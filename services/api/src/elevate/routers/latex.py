"""Resume builder: compile LaTeX safely, and keep the user's LaTeX resume projects."""

from __future__ import annotations

import base64
import os
import threading
import uuid
from datetime import UTC, datetime
from typing import Any

import httpx
from fastapi import APIRouter, Response
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..deps import Authed
from ..errors import CapabilityUnavailable, Conflict, NotFound, ValidationFailed
from ..models import ResumeDoc
from ..services import latex

router = APIRouter(prefix="/api/v1/latex", tags=["resume-builder"])

MAX_DOCS = 50
_local_slots = threading.BoundedSemaphore(2)


def _compile(source: str) -> dict[str, Any]:
    """Production: the isolated runner (separate uid, empty env). Dev/tests: in-process with the same limits."""
    url, token = os.environ.get("ELEVATE_LATEX_RUNNER_URL"), os.environ.get("ELEVATE_LATEX_RUNNER_TOKEN")
    if url and token:
        try:
            r = httpx.post(f"{url}/compile", json={"source": source}, headers={"X-Runner-Token": token}, timeout=60)
        except httpx.HTTPError as e:
            raise CapabilityUnavailable("The LaTeX compiler is not reachable right now. Try again shortly.",
                                        code="latex_unavailable", retryable=True) from e
        if r.status_code == 503:
            raise CapabilityUnavailable("The compiler is busy. Try again in a few seconds.", code="latex_busy",
                                        retryable=True)
        if r.status_code != 200:
            raise CapabilityUnavailable("The LaTeX compiler failed. Try again shortly.", code="latex_unavailable",
                                        retryable=True)
        return r.json()
    if not _local_slots.acquire(timeout=40):
        raise CapabilityUnavailable("The compiler is busy. Try again in a few seconds.", code="latex_busy", retryable=True)
    try:
        res = latex.compile_tex(source)
    finally:
        _local_slots.release()
    return {"ok": res.ok, "ms": res.ms, "page_count": res.page_count, "log_tail": res.log_tail,
            "errors": [{"line": e.line, "message": e.message} for e in res.errors],
            "pdf": base64.b64encode(res.pdf).decode() if res.pdf else None,
            "pages": [base64.b64encode(p).decode() for p in res.pages]}


class CompileIn(BaseModel):
    source: str = Field(min_length=1, max_length=latex.MAX_SOURCE_CHARS)


@router.post("/compile")
def compile_source(body: CompileIn, ctx: Authed, response: Response) -> dict[str, Any]:
    """Compile a LaTeX document. Returns the PDF and PNG page previews (base64), or line-numbered errors."""
    from ..services.account_security import rate_limit
    db, actor = ctx
    rate_limit(db, f"latex:{actor.id}", limit=30, window_seconds=60)
    response.headers["Cache-Control"] = "no-store"
    return _compile(body.source)


# ------------------------------------------------------------------ saved projects
class DocIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    template: str = Field(default="custom", max_length=40, pattern=r"^[a-z0-9_-]+$")
    source: str = Field(min_length=1, max_length=latex.MAX_SOURCE_CHARS)
    job_id: uuid.UUID | None = None


class DocPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    source: str | None = Field(default=None, min_length=1, max_length=latex.MAX_SOURCE_CHARS)
    version: int | None = None  # optimistic concurrency: reject a save based on an older copy


def _out(d: ResumeDoc, with_source: bool = True) -> dict[str, Any]:
    o: dict[str, Any] = {"id": str(d.id), "title": d.title, "template": d.template, "version": d.version,
                         "job_id": str(d.job_id) if d.job_id else None,
                         "created_at": d.created_at, "updated_at": d.updated_at}
    if with_source:
        o["source"] = d.source
    return o


def _get(db: Any, owner: uuid.UUID, doc_id: uuid.UUID) -> ResumeDoc:
    d = db.execute(select(ResumeDoc).where(ResumeDoc.id == doc_id, ResumeDoc.owner_id == owner)).scalar_one_or_none()
    if d is None:
        raise NotFound("This resume was not found. It may have been deleted.")
    return d


@router.get("/docs")
def list_docs(ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    rows = db.execute(select(ResumeDoc).where(ResumeDoc.owner_id == actor.id)
                      .order_by(ResumeDoc.updated_at.desc()).limit(MAX_DOCS)).scalars().all()
    return {"items": [_out(d, with_source=False) for d in rows]}


@router.post("/docs", status_code=201)
def create_doc(body: DocIn, ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    count = len(db.execute(select(ResumeDoc.id).where(ResumeDoc.owner_id == actor.id)).all())
    if count >= MAX_DOCS:
        raise ValidationFailed(f"You can keep up to {MAX_DOCS} resumes. Delete one to make room.", code="too_many_docs")
    if body.job_id:
        from ..services.jobs import get_job
        get_job(db, actor.id, body.job_id)
    d = ResumeDoc(owner_id=actor.id, title=body.title.strip(), template=body.template, source=body.source,
                  job_id=body.job_id)
    db.add(d)
    db.commit()
    db.refresh(d)
    return _out(d)


@router.get("/docs/{doc_id}")
def get_doc(doc_id: uuid.UUID, ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    return _out(_get(db, actor.id, doc_id))


@router.patch("/docs/{doc_id}")
def update_doc(doc_id: uuid.UUID, body: DocPatch, ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    d = _get(db, actor.id, doc_id)
    if body.version is not None and body.version != d.version:
        raise Conflict("This resume was changed in another tab. Reload to get the latest version.",
                       code="version_conflict")
    if body.title is not None:
        d.title = body.title.strip()
    if body.source is not None:
        d.source = body.source
    d.version += 1
    d.updated_at = datetime.now(UTC)
    db.commit()
    db.refresh(d)
    return _out(d, with_source=False)


@router.delete("/docs/{doc_id}", status_code=204)
def delete_doc(doc_id: uuid.UUID, ctx: Authed) -> Response:
    db, actor = ctx
    db.delete(_get(db, actor.id, doc_id))
    db.commit()
    return Response(status_code=204)
