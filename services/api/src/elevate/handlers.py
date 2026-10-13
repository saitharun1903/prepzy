"""Operation handlers. Each handler: load inputs (short txn) -> expensive work (no txn) ->
fenced atomic commit of results via ``ctx.commit_result``."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .errors import NotFound
from .models import Job, JobAnalysis, JobSnapshot
from .services import job_analysis
from .services.taxonomy import load_taxonomy
from .worker import Cancelled, OpContext, handler


@handler("job_analysis")
def handle_job_analysis(ctx: OpContext) -> None:
    job_id = uuid.UUID(ctx.payload["job_id"])
    snap_id = uuid.UUID(ctx.payload["snapshot_id"])
    ctx.stage("loading")
    with ctx.owner_db() as db:
        snap = db.execute(select(JobSnapshot).where(JobSnapshot.id == snap_id, JobSnapshot.job_id == job_id,
                                                    JobSnapshot.owner_id == ctx.owner_id)).scalar_one_or_none()
        if snap is None:
            raise NotFound("Job snapshot no longer exists", retryable=False)
        text, structured, page_title = snap.text, snap.structured, snap.page_title
        job_row = db.execute(select(Job).where(Job.id == job_id)).scalar_one_or_none()
        hints = {"title": job_row.title, "company": job_row.company} if job_row else {}
    ctx.stage("analyzing")
    # Transient model failures are retried by the operation (backoff); only the final attempt
    # may fall back to a rules-only partial analysis.
    final_attempt = ctx.attempt >= ctx.op.max_attempts
    out = job_analysis.analyze(text, structured, page_title, cancel_check=ctx.cancelled,
                               allow_partial=final_attempt, page_hints=hints)
    ctx.stage("validating")
    if ctx.cancelled():
        raise Cancelled()

    def write(db: Session) -> dict[str, Any]:
        job = db.execute(select(Job).where(Job.id == job_id, Job.owner_id == ctx.owner_id)).scalar_one_or_none()
        if job is None:
            raise NotFound("Job was deleted", retryable=False)
        a = JobAnalysis(owner_id=ctx.owner_id, job_id=job_id, snapshot_id=snap_id, operation_id=ctx.op.id,
                        status=out["status"], result=out["result"], issues=out["issues"], model=out["model"],
                        prompt_version=job_analysis.PROMPT_VERSION, schema_version=job_analysis.SCHEMA_VERSION,
                        taxonomy_version=load_taxonomy().version, duration_ms=out["duration_ms"])
        db.add(a)
        f = out["result"]["fields"]
        if not job.title and f["title"]["value"]:
            job.title = f["title"]["value"][:300]
        if not job.company and f["company"]["value"]:
            job.company = f["company"]["value"][:300]
        job.updated_at = datetime.now(UTC)
        db.flush()
        return {"job_id": str(job_id), "analysis_id": str(a.id), "status": out["status"],
                "issue_count": len(out["issues"])}

    ctx.commit_result(write, state="succeeded" if out["status"] == "complete" else "partially_succeeded")
