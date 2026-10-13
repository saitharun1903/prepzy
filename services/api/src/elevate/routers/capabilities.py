from typing import Any

from fastapi import APIRouter, Query
from sqlalchemy import func, select

from ..config import get_settings
from ..deps import Authed
from ..models import KnowledgeChunk, KnowledgeSource, User
from ..services.llm import get_provider
from ..services.taxonomy import load_taxonomy

router = APIRouter(prefix="/api/v1", tags=["capabilities"])

# Validation status per domain is maintained from docs/AI_EVALUATION.md results (never assumed).
_EVAL_PATH = "ai/evaluation/results/latest.json"


def _eval_status() -> dict[str, Any]:
    import json

    from ..config import REPO_ROOT
    p = REPO_ROOT / _EVAL_PATH
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8")).get("by_domain", {})
    except (OSError, ValueError):
        return {}


@router.get("/me")
def me(ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    u = db.get(User, actor.id)
    assert u is not None
    h = get_provider().health()
    ai_ok = bool(h.get("reachable") and h.get("llm_installed"))
    return {
        "user": {"id": str(u.id), "email": u.email, "display_name": u.display_name, "is_admin": u.is_admin,
                 "timezone": u.timezone, "created_at": u.created_at},
        "capabilities": {
            "ai_analysis": ai_ok, "semantic_search": bool(h.get("reachable") and h.get("embed_installed")),
            "ocr": False, "email_delivery": False, "calendar_sync": False, "push": False, "code_execution": False,
            "voice_interviews": False, "external_ai": False,
        },
        "limits": {"max_upload_mb": get_settings().max_upload_mb, "max_job_text_chars": get_settings().max_job_text_chars,
                   "supported_resume_formats": ["pdf (text-based)", "docx", "pasted text"],
                   "supported_languages": ["en"]},
    }


@router.get("/taxonomy/domains")
def domains(ctx: Authed) -> dict[str, Any]:
    db, _ = ctx
    tax = load_taxonomy()
    evals = _eval_status()
    counts = dict(db.execute(select(KnowledgeSource.domain, func.count(KnowledgeChunk.id))
                             .join(KnowledgeChunk, KnowledgeChunk.source_id == KnowledgeSource.id)
                             .where(KnowledgeSource.visibility == "shared", KnowledgeSource.deleted_at.is_(None))
                             .group_by(KnowledgeSource.domain)).all())
    return {"version": tax.version, "domains": [{
        "id": d.id, "label": d.label,
        "skills": sum(1 for s in tax.skills.values() if d.id in s.domains),
        "interview_kinds": list(d.interview_kinds),
        "knowledge_chunks": counts.get(d.id, 0),
        "evaluation": evals.get(d.id, {"status": "unvalidated", "cases": 0}),
    } for d in tax.domains.values()]}


@router.get("/taxonomy/skills")
def search_skills(ctx: Authed, q: str = Query(min_length=1, max_length=60), domain: str | None = None
                  ) -> list[dict[str, Any]]:
    tax = load_taxonomy()
    ql = q.lower().strip()
    hits = [s for s in tax.skills.values() if (ql in s.label.lower() or any(ql in a for a in s.aliases))
            and (not domain or domain in s.domains)]
    hits.sort(key=lambda s: (not s.label.lower().startswith(ql), s.label))
    return [{"id": s.id, "label": s.label, "kind": s.kind} for s in hits[:15]]
