import uuid
from datetime import UTC, date, datetime
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select

from ..deps import Authed
from ..errors import Conflict, NotFound, ValidationFailed
from ..models import Profile, ProfileFact, User
from ..services.taxonomy import load_taxonomy

router = APIRouter(prefix="/api/v1/profile", tags=["profile"])

WORK_MODES = {"remote", "hybrid", "onsite"}
STAGES = {"student", "fresh_graduate", "early_career", "mid_career", "senior", "career_changer"}


def _out(p: Profile, u: User) -> dict[str, Any]:
    return {"revision": p.revision, "career_stage": p.career_stage, "target_roles": p.target_roles,
            "domains": p.domains, "locations": p.locations, "work_modes": p.work_modes, "weekly_hours": p.weekly_hours,
            "target_date": p.target_date, "headline": p.headline, "onboarded_at": p.onboarded_at,
            "consent_processing_at": p.consent_processing_at, "updated_at": p.updated_at,
            "display_name": u.display_name, "timezone": u.timezone}


def _get(db: Any, uid: uuid.UUID) -> Profile:
    p = db.get(Profile, uid)
    if p is None:
        p = Profile(user_id=uid)
        db.add(p)
        db.flush()
        db.refresh(p)
    return p


@router.get("")
def get_profile(ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    p = _get(db, actor.id)
    db.commit()
    u = db.get(User, actor.id)
    assert u is not None
    return _out(p, u)


class ProfileIn(BaseModel):
    expected_revision: int
    career_stage: str | None = None
    target_roles: list[str] = Field(default_factory=list, max_length=10)
    domains: list[str] = Field(default_factory=list, max_length=10)
    locations: list[str] = Field(default_factory=list, max_length=10)
    work_modes: list[str] = Field(default_factory=list, max_length=3)
    weekly_hours: int | None = Field(default=None, ge=1, le=80)
    target_date: date | None = None
    headline: str | None = Field(default=None, max_length=200)
    display_name: str | None = Field(default=None, max_length=120)
    timezone: str | None = Field(default=None, max_length=64)
    complete_onboarding: bool = False
    consent_processing: bool | None = None

    @field_validator("target_roles", "locations")
    @classmethod
    def _short(cls, v: list[str]) -> list[str]:
        out = [x.strip()[:120] for x in v if x.strip()]
        return list(dict.fromkeys(out))


@router.put("")
def update_profile(body: ProfileIn, ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    p = db.execute(select(Profile).where(Profile.user_id == actor.id).with_for_update()).scalar_one_or_none() \
        or _get(db, actor.id)
    if p.revision != body.expected_revision:
        raise Conflict("Your profile was changed elsewhere. Reload to see the latest version.", code="stale_write",
                       extra={"current_revision": p.revision})
    tax = load_taxonomy()
    if body.career_stage and body.career_stage not in STAGES:
        raise ValidationFailed("Unknown career stage", fields={"career_stage": "invalid"})
    if any(d not in tax.domains for d in body.domains):
        raise ValidationFailed("Unknown domain", fields={"domains": "invalid"})
    if any(m not in WORK_MODES for m in body.work_modes):
        raise ValidationFailed("Unknown work mode", fields={"work_modes": "invalid"})
    u = db.get(User, actor.id)
    assert u is not None
    if body.timezone:
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
        try:
            ZoneInfo(body.timezone)
        except (ZoneInfoNotFoundError, ValueError) as e:
            raise ValidationFailed("Unknown timezone", fields={"timezone": "invalid"}) from e
        u.timezone = body.timezone
    if body.display_name is not None:
        u.display_name = body.display_name.strip() or None
    p.career_stage, p.target_roles, p.domains = body.career_stage, body.target_roles, body.domains
    p.locations, p.work_modes, p.weekly_hours = body.locations, body.work_modes, body.weekly_hours
    p.target_date, p.headline = body.target_date, body.headline
    if body.complete_onboarding and not p.onboarded_at:
        p.onboarded_at = datetime.now(UTC)
    if body.consent_processing is True and not p.consent_processing_at:
        p.consent_processing_at = datetime.now(UTC)
    if body.consent_processing is False:
        p.consent_processing_at = None
    p.revision += 1
    p.updated_at = datetime.now(UTC)
    db.commit()
    return _out(p, u)


class FactIn(BaseModel):
    kind: Literal["skill", "certification", "project", "education"] = "skill"
    concept_id: str | None = Field(default=None, max_length=80)
    label: str | None = Field(default=None, max_length=200)
    evidence_type: Literal["self_reported", "project", "course", "professional", "certification"] = "self_reported"
    detail: str | None = Field(default=None, max_length=2000)


@router.get("/facts")
def list_facts(ctx: Authed) -> list[dict[str, Any]]:
    db, actor = ctx
    return [{"id": str(f.id), "kind": f.kind, "concept_id": f.concept_id, "label": f.label,
             "evidence_type": f.evidence_type, "detail": f.detail, "created_at": f.created_at}
            for f in db.execute(select(ProfileFact).where(ProfileFact.owner_id == actor.id)
                                .order_by(ProfileFact.created_at)).scalars()]


def _bump(db: Any, uid: uuid.UUID) -> None:
    p = _get(db, uid)
    p.revision += 1
    p.updated_at = datetime.now(UTC)


@router.post("/facts", status_code=201)
def add_fact(body: FactIn, ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    tax = load_taxonomy()
    label = body.label
    if body.kind == "skill":
        if not body.concept_id or body.concept_id not in tax.skills:
            raise ValidationFailed("Choose a skill from the list", fields={"concept_id": "unknown"})
        label = tax.skills[body.concept_id].label
        dup = db.execute(select(ProfileFact).where(ProfileFact.owner_id == actor.id,
                                                   ProfileFact.concept_id == body.concept_id)).first()
        if dup:
            raise Conflict("That skill is already in your profile.", code="duplicate")
    if not label:
        raise ValidationFailed("A label is required", fields={"label": "required"})
    f = ProfileFact(owner_id=actor.id, kind=body.kind, concept_id=body.concept_id, label=label,
                    evidence_type=body.evidence_type, detail=body.detail)
    db.add(f)
    _bump(db, actor.id)
    db.commit()
    return {"id": str(f.id)}


@router.delete("/facts/{fact_id}", status_code=204)
def delete_fact(fact_id: uuid.UUID, ctx: Authed) -> None:
    db, actor = ctx
    f = db.execute(select(ProfileFact).where(ProfileFact.id == fact_id, ProfileFact.owner_id == actor.id)
                   ).scalar_one_or_none()
    if f is None:
        raise NotFound("Not found")
    db.delete(f)
    _bump(db, actor.id)
    db.commit()
