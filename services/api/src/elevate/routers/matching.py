import uuid
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import select

from ..deps import Authed
from ..errors import Conflict, NotFound
from ..models import JobAnalysis, MatchReport, Profile, ProfileFact, Resume, ResumeVersion
from ..services import jobs as jobsvc
from ..services import matching
from ..services.taxonomy import load_taxonomy

router = APIRouter(prefix="/api/v1", tags=["matching"])


class MatchIn(BaseModel):
    resume_version_id: uuid.UUID | None = None
    analysis_id: uuid.UUID | None = None


def _default_version(db: Any, owner: uuid.UUID) -> ResumeVersion | None:
    r = db.execute(select(Resume).where(Resume.owner_id == owner, Resume.is_default)).scalar_one_or_none()
    if r is None:
        return None
    return db.execute(select(ResumeVersion).where(ResumeVersion.resume_id == r.id, ResumeVersion.parse_status == "parsed")
                      .order_by(ResumeVersion.version.desc()).limit(1)).scalar_one_or_none()


def _inputs(db: Any, owner: uuid.UUID, job_id: uuid.UUID, analysis: JobAnalysis, version: ResumeVersion | None
            ) -> dict[str, Any]:
    prof = db.get(Profile, owner)
    corrs = jobsvc.active_corrections(db, job_id, analysis.id)
    return {"analysis_id": str(analysis.id), "resume_version_id": str(version.id) if version else None,
            "resume_reviewed_at": version.reviewed_at.isoformat() if version and version.reviewed_at else None,
            "profile_revision": prof.revision if prof else 0, "corrections_rev": jobsvc.corrections_rev(corrs),
            "taxonomy_version": load_taxonomy().version, "scoring_version": matching.SCORING_VERSION}


def _stale(db: Any, owner: uuid.UUID, rep: MatchReport) -> list[str]:
    reasons = []
    latest = db.execute(select(JobAnalysis).where(JobAnalysis.job_id == rep.job_id).order_by(JobAnalysis.created_at.desc())
                        .limit(1)).scalar_one_or_none()
    if latest and latest.id != rep.analysis_id:
        reasons.append("A newer job analysis exists.")
    analysis = db.get(JobAnalysis, rep.analysis_id)
    version = db.get(ResumeVersion, rep.resume_version_id) if rep.resume_version_id else None
    cur = _inputs(db, owner, rep.job_id, analysis, version)
    old = rep.result.get("inputs", {})
    if cur["corrections_rev"] != old.get("corrections_rev"):
        reasons.append("Job requirements were corrected since this report.")
    if cur["resume_reviewed_at"] != old.get("resume_reviewed_at"):
        reasons.append("Resume evidence was reviewed/edited since this report.")
    if cur["profile_revision"] != old.get("profile_revision"):
        reasons.append("Your profile skills changed since this report.")
    if cur["taxonomy_version"] != old.get("taxonomy_version") or cur["scoring_version"] != old.get("scoring_version"):
        reasons.append("Prepzy's taxonomy or scoring rules were updated.")
    if version:
        newer = db.execute(select(ResumeVersion.id).where(ResumeVersion.resume_id == version.resume_id,
                                                          ResumeVersion.version > version.version,
                                                          ResumeVersion.parse_status == "parsed")).first()
        if newer:
            reasons.append("A newer version of this resume exists.")
    return reasons


def _out(db: Any, owner: uuid.UUID, rep: MatchReport) -> dict[str, Any]:
    return {"id": str(rep.id), "job_id": str(rep.job_id), "created_at": rep.created_at, "result": rep.result,
            "stale_reasons": _stale(db, owner, rep)}


@router.post("/jobs/{job_id}/match")
def create_match(job_id: uuid.UUID, body: MatchIn, ctx: Authed) -> dict[str, Any]:
    """Deterministic and fast, so it runs synchronously. Identical inputs return the existing report."""
    db, actor = ctx
    job = jobsvc.get_job(db, actor.id, job_id)
    if body.analysis_id:
        analysis = db.execute(select(JobAnalysis).where(JobAnalysis.id == body.analysis_id,
                                                        JobAnalysis.job_id == job.id)).scalar_one_or_none()
    else:
        analysis = db.execute(select(JobAnalysis).where(JobAnalysis.job_id == job.id)
                              .order_by(JobAnalysis.created_at.desc()).limit(1)).scalar_one_or_none()
    if analysis is None:
        raise Conflict("Analyse this job before comparing it with your resume.", code="no_analysis")
    if body.resume_version_id:
        version = db.execute(select(ResumeVersion).where(ResumeVersion.id == body.resume_version_id,
                                                         ResumeVersion.owner_id == actor.id)).scalar_one_or_none()
        if version is None:
            raise NotFound("Resume version not found")
        if version.parse_status != "parsed":
            raise Conflict("That resume version has not been parsed successfully.", code="not_parsed")
    else:
        version = _default_version(db, actor.id)
    inputs = _inputs(db, actor.id, job.id, analysis, version)
    for rep in db.execute(select(MatchReport).where(MatchReport.job_id == job.id, MatchReport.analysis_id == analysis.id)
                          .order_by(MatchReport.created_at.desc())).scalars():
        if rep.result.get("inputs") == inputs:
            return {**_out(db, actor.id, rep), "reused": True}
    corrs = jobsvc.active_corrections(db, job.id, analysis.id)
    effective = jobsvc.effective_analysis(analysis, corrs)
    facts = [{"kind": f.kind, "concept_id": f.concept_id, "evidence_type": f.evidence_type, "detail": f.detail}
             for f in db.execute(select(ProfileFact).where(ProfileFact.owner_id == actor.id)).scalars()]
    result = matching.compute(effective, version.text if version else None, version.extracted if version else None,
                              version.reviewed if version else None, facts)
    result["inputs"] = inputs
    result["resume"] = ({"version_id": str(version.id), "resume_id": str(version.resume_id), "version": version.version}
                        if version else None)
    if version is None:
        result["summary"]["score_status"] = "withheld"
        result["summary"]["withheld_reason"] = "Add a resume or confirm profile skills to compare evidence."
        result["summary"]["required"]["coverage"] = None
    rep = MatchReport(owner_id=actor.id, job_id=job.id, analysis_id=analysis.id,
                      resume_version_id=version.id if version else None, profile_revision=inputs["profile_revision"],
                      corrections_rev=inputs["corrections_rev"], taxonomy_version=inputs["taxonomy_version"],
                      scoring_version=matching.SCORING_VERSION, result=result)
    db.add(rep)
    db.commit()
    return {**_out(db, actor.id, rep), "reused": False}


@router.get("/match-reports/{report_id}")
def get_report(report_id: uuid.UUID, ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    rep = db.execute(select(MatchReport).where(MatchReport.id == report_id, MatchReport.owner_id == actor.id)
                     ).scalar_one_or_none()
    if rep is None:
        raise NotFound("Report not found")
    return _out(db, actor.id, rep)


@router.get("/jobs/{job_id}/match/latest")
def latest_report(job_id: uuid.UUID, ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    jobsvc.get_job(db, actor.id, job_id)
    rep = db.execute(select(MatchReport).where(MatchReport.job_id == job_id, MatchReport.owner_id == actor.id)
                     .order_by(MatchReport.created_at.desc()).limit(1)).scalar_one_or_none()
    return {"report": _out(db, actor.id, rep) if rep else None}
