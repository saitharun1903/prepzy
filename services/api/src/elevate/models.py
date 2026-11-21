"""SQLAlchemy models. Alembic (services/api/migrations) is the single schema authority.

Conventions: UUID primary keys, ``owner_id`` on every user-owned row (RLS + explicit filters),
server-side ``created_at``, ``version`` columns for optimistic concurrency on editable rows,
JSONB only for validated, schema-versioned documents.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, TSVECTOR, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

EMBED_DIM = 768


class Base(DeclarativeBase):
    type_annotation_map = {dict[str, Any]: JSONB, list[Any]: JSONB}


def pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))


def owner_fk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)


def created() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now())


# --------------------------------------------------------------------------- identity
class User(Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = pk()
    email: Mapped[str] = mapped_column(String(320))
    password_hash: Mapped[str] = mapped_column(Text)
    display_name: Mapped[str | None] = mapped_column(String(120))
    is_admin: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    timezone: Mapped[str] = mapped_column(String(64), server_default=text("'UTC'"))
    token_version: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    created_at: Mapped[datetime] = created()
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failed_logins: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # TOTP secret encrypted with ELEVATE_DATA_KEY (Fernet); never stored in plaintext.
    totp_secret_enc: Mapped[str | None] = mapped_column(Text)
    totp_enabled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    totp_last_step: Mapped[int | None] = mapped_column(BigInteger)
    __table_args__ = (Index("uq_users_email_lower", func.lower(email), unique=True),)


class AuthToken(Base):
    """Single-use, expiring tokens for email verification and password reset (stored hashed)."""

    __tablename__ = "auth_tokens"
    id: Mapped[uuid.UUID] = pk()
    user_id: Mapped[uuid.UUID] = owner_fk()
    kind: Mapped[str] = mapped_column(String(24))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = created()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (CheckConstraint("kind in ('verify_email','reset_password')", name="ck_auth_token_kind"),)


class MfaRecoveryCode(Base):
    __tablename__ = "mfa_recovery_codes"
    id: Mapped[uuid.UUID] = pk()
    user_id: Mapped[uuid.UUID] = owner_fk()
    code_hash: Mapped[str] = mapped_column(String(64), unique=True)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created()


class RateLimitBucket(Base):
    """Fixed-window counters shared by every API instance (replaces the in-process limiter)."""

    __tablename__ = "rate_limit_buckets"
    key: Mapped[str] = mapped_column(String(200), primary_key=True)
    window_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    count: Mapped[int] = mapped_column(Integer, server_default=text("0"))


class StoredFile(Base):
    """Resume file bytes kept in Postgres (storage backend ``db``): for hosts without a free object
    store. Owner-scoped by RLS like every other user table; deleted with the user (cascade)."""

    __tablename__ = "stored_files"
    owner_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"),
                                                primary_key=True)
    name: Mapped[str] = mapped_column(String(40), primary_key=True)
    data: Mapped[bytes] = mapped_column(LargeBinary)
    created_at: Mapped[datetime] = created()


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"
    id: Mapped[uuid.UUID] = pk()
    user_id: Mapped[uuid.UUID] = owner_fk()
    family_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    client: Mapped[str] = mapped_column(String(16))  # web | extension
    created_at: Mapped[datetime] = created()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (CheckConstraint("client in ('web','extension')", name="ck_refresh_client"),)


class Profile(Base):
    __tablename__ = "profiles"
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"),
                                               primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, server_default=text("1"))
    career_stage: Mapped[str | None] = mapped_column(String(32))
    target_roles: Mapped[list[Any]] = mapped_column(JSONB, server_default=text("'[]'"))
    domains: Mapped[list[str]] = mapped_column(ARRAY(String(64)), server_default=text("'{}'"))
    locations: Mapped[list[str]] = mapped_column(ARRAY(String(120)), server_default=text("'{}'"))
    work_modes: Mapped[list[str]] = mapped_column(ARRAY(String(16)), server_default=text("'{}'"))
    weekly_hours: Mapped[int | None] = mapped_column(Integer)
    target_date: Mapped[date | None] = mapped_column(Date)
    headline: Mapped[str | None] = mapped_column(String(200))
    consent_processing_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    onboarded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = created()


class ProfileFact(Base):
    """User-confirmed skill/evidence statements, kept distinct from resume extraction."""

    __tablename__ = "profile_facts"
    id: Mapped[uuid.UUID] = pk()
    owner_id: Mapped[uuid.UUID] = owner_fk()
    kind: Mapped[str] = mapped_column(String(24))  # skill | certification | project | education
    concept_id: Mapped[str | None] = mapped_column(String(80))
    label: Mapped[str] = mapped_column(String(200))
    evidence_type: Mapped[str] = mapped_column(String(24))  # self_reported | project | course | professional
    detail: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created()
    __table_args__ = (
        CheckConstraint("evidence_type in ('self_reported','project','course','professional','certification')",
                        name="ck_fact_evidence"),
    )


# --------------------------------------------------------------------------- jobs
class Job(Base):
    """A user's job record. Identity is per-owner; nothing here is shared across users."""

    __tablename__ = "jobs"
    id: Mapped[uuid.UUID] = pk()
    owner_id: Mapped[uuid.UUID] = owner_fk()
    canonical_key: Mapped[str] = mapped_column(String(600))
    source_url: Mapped[str | None] = mapped_column(Text)
    title: Mapped[str | None] = mapped_column(String(300))
    company: Mapped[str | None] = mapped_column(String(300))
    saved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    availability: Mapped[str] = mapped_column(String(16), server_default=text("'unknown'"))
    last_observed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created()
    updated_at: Mapped[datetime] = created()
    snapshots: Mapped[list[JobSnapshot]] = relationship(back_populates="job", order_by="JobSnapshot.version",
                                                     cascade="all, delete-orphan", passive_deletes=True)
    __table_args__ = (UniqueConstraint("owner_id", "canonical_key", name="uq_job_owner_key"),
                      CheckConstraint("availability in ('unknown','last_observed','closed')", name="ck_job_avail"))


class JobSnapshot(Base):
    __tablename__ = "job_snapshots"
    id: Mapped[uuid.UUID] = pk()
    job_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="CASCADE"), index=True)
    owner_id: Mapped[uuid.UUID] = owner_fk()
    version: Mapped[int] = mapped_column(Integer)
    content_hash: Mapped[str] = mapped_column(String(64))
    capture_method: Mapped[str] = mapped_column(String(24))  # extension | manual
    extraction_version: Mapped[str] = mapped_column(String(32))
    source_url: Mapped[str | None] = mapped_column(Text)
    page_title: Mapped[str | None] = mapped_column(String(500))
    text: Mapped[str] = mapped_column(Text)
    structured: Mapped[dict[str, Any] | None] = mapped_column(JSONB)  # untrusted JSON-LD JobPosting claims
    captured_at: Mapped[datetime] = created()
    job: Mapped[Job] = relationship(back_populates="snapshots")
    __table_args__ = (UniqueConstraint("job_id", "content_hash", name="uq_snapshot_content"),
                      UniqueConstraint("job_id", "version", name="uq_snapshot_version"))


class JobAnalysis(Base):
    """Immutable, versioned model analysis of one snapshot."""

    __tablename__ = "job_analyses"
    id: Mapped[uuid.UUID] = pk()
    owner_id: Mapped[uuid.UUID] = owner_fk()
    job_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="CASCADE"), index=True)
    snapshot_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("job_snapshots.id", ondelete="CASCADE"))
    operation_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    status: Mapped[str] = mapped_column(String(16))  # complete | partial
    result: Mapped[dict[str, Any]] = mapped_column(JSONB)
    issues: Mapped[list[Any]] = mapped_column(JSONB, server_default=text("'[]'"))
    model: Mapped[str] = mapped_column(String(120))
    prompt_version: Mapped[str] = mapped_column(String(32))
    schema_version: Mapped[str] = mapped_column(String(32))
    taxonomy_version: Mapped[str] = mapped_column(String(32))
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = created()


class JobCorrection(Base):
    """User override of an extracted field/requirement. Never mutates the original analysis."""

    __tablename__ = "job_corrections"
    id: Mapped[uuid.UUID] = pk()
    owner_id: Mapped[uuid.UUID] = owner_fk()
    job_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="CASCADE"), index=True)
    analysis_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("job_analyses.id", ondelete="CASCADE"))
    target: Mapped[str] = mapped_column(String(16))  # field | requirement
    key: Mapped[str] = mapped_column(String(120))
    value: Mapped[dict[str, Any]] = mapped_column(JSONB)
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created()
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


# --------------------------------------------------------------------------- resumes
class Resume(Base):
    __tablename__ = "resumes"
    id: Mapped[uuid.UUID] = pk()
    owner_id: Mapped[uuid.UUID] = owner_fk()
    name: Mapped[str] = mapped_column(String(120))
    is_default: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    created_at: Mapped[datetime] = created()
    versions: Mapped[list[ResumeVersion]] = relationship(back_populates="resume", order_by="ResumeVersion.version",
                                                             cascade="all, delete-orphan", passive_deletes=True)
    __table_args__ = (Index("uq_resume_default", "owner_id", unique=True, postgresql_where=text("is_default")),)


class ResumeVersion(Base):
    __tablename__ = "resume_versions"
    id: Mapped[uuid.UUID] = pk()
    resume_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("resumes.id", ondelete="CASCADE"), index=True)
    owner_id: Mapped[uuid.UUID] = owner_fk()
    version: Mapped[int] = mapped_column(Integer)
    origin: Mapped[str] = mapped_column(String(16))  # upload | manual | edited
    original_filename: Mapped[str | None] = mapped_column(String(255))
    storage_name: Mapped[str | None] = mapped_column(String(80))
    file_sha256: Mapped[str | None] = mapped_column(String(64))
    mime: Mapped[str | None] = mapped_column(String(100))
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    text: Mapped[str | None] = mapped_column(Text)
    parse_status: Mapped[str] = mapped_column(String(16))  # pending | parsed | failed | unsupported
    parse_error: Mapped[str | None] = mapped_column(Text)
    extracted: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    reviewed: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    parser_version: Mapped[str | None] = mapped_column(String(32))
    created_at: Mapped[datetime] = created()
    resume: Mapped[Resume] = relationship(back_populates="versions")
    __table_args__ = (UniqueConstraint("resume_id", "version", name="uq_resume_version"),)


class MatchReport(Base):
    __tablename__ = "match_reports"
    id: Mapped[uuid.UUID] = pk()
    owner_id: Mapped[uuid.UUID] = owner_fk()
    job_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="CASCADE"), index=True)
    analysis_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("job_analyses.id", ondelete="CASCADE"))
    resume_version_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("resume_versions.id", ondelete="CASCADE"))
    profile_revision: Mapped[int] = mapped_column(Integer)
    corrections_rev: Mapped[str] = mapped_column(String(64))
    taxonomy_version: Mapped[str] = mapped_column(String(32))
    scoring_version: Mapped[str] = mapped_column(String(32))
    result: Mapped[dict[str, Any]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = created()


# --------------------------------------------------------------------------- interviews
class InterviewSession(Base):
    __tablename__ = "interview_sessions"
    id: Mapped[uuid.UUID] = pk()
    owner_id: Mapped[uuid.UUID] = owner_fk()
    job_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="SET NULL"))
    title: Mapped[str] = mapped_column(String(200))
    config: Mapped[dict[str, Any]] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(16), server_default=text("'preparing'"))
    created_at: Mapped[datetime] = created()
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (CheckConstraint("status in ('preparing','active','paused','completed','failed')",
                                      name="ck_interview_status"),)


class InterviewQuestion(Base):
    __tablename__ = "interview_questions"
    id: Mapped[uuid.UUID] = pk()
    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("interview_sessions.id", ondelete="CASCADE"), index=True)
    owner_id: Mapped[uuid.UUID] = owner_fk()
    ord: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(24))
    topic: Mapped[str] = mapped_column(String(120))
    prompt: Mapped[str] = mapped_column(Text)
    rubric: Mapped[list[Any]] = mapped_column(JSONB)
    rubric_version: Mapped[str] = mapped_column(String(32))
    origin: Mapped[str] = mapped_column(String(16), server_default=text("'generated'"))
    requirement_ref: Mapped[str | None] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(16), server_default=text("'pending'"))  # pending|answered|skipped
    __table_args__ = (UniqueConstraint("session_id", "ord", name="uq_question_ord"),)


class InterviewAnswer(Base):
    __tablename__ = "interview_answers"
    id: Mapped[uuid.UUID] = pk()
    question_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("interview_questions.id", ondelete="CASCADE"), index=True)
    owner_id: Mapped[uuid.UUID] = owner_fk()
    revision: Mapped[int] = mapped_column(Integer)
    answer: Mapped[str] = mapped_column(Text)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    submitted_at: Mapped[datetime] = created()
    eval_status: Mapped[str] = mapped_column(String(24), server_default=text("'pending'"))
    evaluation: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    __table_args__ = (UniqueConstraint("question_id", "revision", name="uq_answer_rev"),)


# --------------------------------------------------------------------------- roadmaps
class Roadmap(Base):
    __tablename__ = "roadmaps"
    id: Mapped[uuid.UUID] = pk()
    owner_id: Mapped[uuid.UUID] = owner_fk()
    job_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="SET NULL"))
    match_report_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("match_reports.id", ondelete="SET NULL"))
    title: Mapped[str] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(16), server_default=text("'active'"))
    weekly_hours: Mapped[int] = mapped_column(Integer)
    start_date: Mapped[date] = mapped_column(Date)
    target_date: Mapped[date | None] = mapped_column(Date)
    feasibility: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'"))
    generic: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    revision: Mapped[int] = mapped_column(Integer, server_default=text("1"))
    created_at: Mapped[datetime] = created()
    updated_at: Mapped[datetime] = created()
    __table_args__ = (CheckConstraint("status in ('active','paused','archived')", name="ck_roadmap_status"),)


class RoadmapTask(Base):
    __tablename__ = "roadmap_tasks"
    id: Mapped[uuid.UUID] = pk()
    roadmap_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("roadmaps.id", ondelete="CASCADE"), index=True)
    owner_id: Mapped[uuid.UUID] = owner_fk()
    key: Mapped[str] = mapped_column(String(120))
    ord: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(300))
    objective: Mapped[str | None] = mapped_column(Text)
    skill_id: Mapped[str | None] = mapped_column(String(80))
    requirement_ref: Mapped[str | None] = mapped_column(String(300))
    priority: Mapped[str] = mapped_column(String(8))
    est_hours_low: Mapped[float] = mapped_column()
    est_hours_high: Mapped[float] = mapped_column()
    depends_on: Mapped[list[Any]] = mapped_column(JSONB, server_default=text("'[]'"))
    resources: Mapped[list[Any]] = mapped_column(JSONB, server_default=text("'[]'"))
    scheduled_week: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(12), server_default=text("'todo'"))
    user_edited: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    version: Mapped[int] = mapped_column(Integer, server_default=text("1"))
    __table_args__ = (UniqueConstraint("roadmap_id", "key", name="uq_task_key"),
                      CheckConstraint("status in ('todo','in_progress','done','skipped')", name="ck_task_status"))


class RoadmapEvent(Base):
    __tablename__ = "roadmap_events"
    id: Mapped[uuid.UUID] = pk()
    roadmap_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("roadmaps.id", ondelete="CASCADE"), index=True)
    owner_id: Mapped[uuid.UUID] = owner_fk()
    kind: Mapped[str] = mapped_column(String(32))
    detail: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'"))
    created_at: Mapped[datetime] = created()


# --------------------------------------------------------------------------- applications
class Application(Base):
    __tablename__ = "applications"
    id: Mapped[uuid.UUID] = pk()
    owner_id: Mapped[uuid.UUID] = owner_fk()
    job_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="CASCADE"), index=True)
    cycle: Mapped[int] = mapped_column(Integer, server_default=text("1"))
    status: Mapped[str] = mapped_column(String(16))
    applied_on: Mapped[date | None] = mapped_column(Date)
    resume_version_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("resume_versions.id", ondelete="SET NULL"))
    next_action: Mapped[str | None] = mapped_column(String(300))
    next_action_on: Mapped[date | None] = mapped_column(Date)
    version: Mapped[int] = mapped_column(Integer, server_default=text("1"))
    created_at: Mapped[datetime] = created()
    updated_at: Mapped[datetime] = created()
    __table_args__ = (
        UniqueConstraint("owner_id", "job_id", "cycle", name="uq_application_cycle"),
        CheckConstraint("status in ('planned','applied','screening','interviewing','offer','rejected','withdrawn','closed')",
                        name="ck_application_status"),
    )


class ApplicationEvent(Base):
    __tablename__ = "application_events"
    id: Mapped[uuid.UUID] = pk()
    application_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), index=True)
    owner_id: Mapped[uuid.UUID] = owner_fk()
    from_status: Mapped[str | None] = mapped_column(String(16))
    to_status: Mapped[str] = mapped_column(String(16))
    note: Mapped[str | None] = mapped_column(Text)
    is_correction: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    occurred_at: Mapped[datetime] = created()


class Note(Base):
    __tablename__ = "notes"
    id: Mapped[uuid.UUID] = pk()
    owner_id: Mapped[uuid.UUID] = owner_fk()
    job_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="CASCADE"), index=True)
    body: Mapped[str] = mapped_column(Text)
    version: Mapped[int] = mapped_column(Integer, server_default=text("1"))
    created_at: Mapped[datetime] = created()
    updated_at: Mapped[datetime] = created()


# --------------------------------------------------------------------------- resume builder (LaTeX projects)
class ResumeDoc(Base):
    __tablename__ = "resume_docs"
    id: Mapped[uuid.UUID] = pk()
    owner_id: Mapped[uuid.UUID] = owner_fk()
    title: Mapped[str] = mapped_column(String(120))
    template: Mapped[str] = mapped_column(String(40))
    source: Mapped[str] = mapped_column(Text)
    job_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="SET NULL"))
    version: Mapped[int] = mapped_column(Integer, server_default=text("1"))
    created_at: Mapped[datetime] = created()
    updated_at: Mapped[datetime] = created()


# --------------------------------------------------------------------------- reminders
class Reminder(Base):
    __tablename__ = "reminders"
    id: Mapped[uuid.UUID] = pk()
    owner_id: Mapped[uuid.UUID] = owner_fk()
    job_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="CASCADE"))
    application_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"))
    title: Mapped[str] = mapped_column(String(300))
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)  # UTC instant to fire
    due_date: Mapped[date | None] = mapped_column(Date)  # original date-only deadline, if that's what the user gave
    timezone: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16), server_default=text("'scheduled'"))
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    late_by_seconds: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = created()
    __table_args__ = (CheckConstraint("status in ('scheduled','processed','cancelled','failed')", name="ck_reminder_status"),)


class Notification(Base):
    __tablename__ = "notifications"
    id: Mapped[uuid.UUID] = pk()
    owner_id: Mapped[uuid.UUID] = owner_fk()
    reminder_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("reminders.id", ondelete="CASCADE"), unique=True)
    kind: Mapped[str] = mapped_column(String(24))
    title: Mapped[str] = mapped_column(String(300))
    body: Mapped[str | None] = mapped_column(Text)
    link: Mapped[str | None] = mapped_column(String(300))
    created_at: Mapped[datetime] = created()
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    dismissed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


# --------------------------------------------------------------------------- knowledge / RAG
class KnowledgeSource(Base):
    __tablename__ = "knowledge_sources"
    id: Mapped[uuid.UUID] = pk()
    owner_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    visibility: Mapped[str] = mapped_column(String(8))  # shared | private
    title: Mapped[str] = mapped_column(String(300))
    source_type: Mapped[str] = mapped_column(String(24))  # upload | url_supplied | authored
    source_url: Mapped[str | None] = mapped_column(Text)
    domain: Mapped[str | None] = mapped_column(String(64))
    skills: Mapped[list[str]] = mapped_column(ARRAY(String(80)), server_default=text("'{}'"))
    language: Mapped[str] = mapped_column(String(8), server_default=text("'en'"))
    license_basis: Mapped[str] = mapped_column(Text)
    published_on: Mapped[date | None] = mapped_column(Date)
    review_state: Mapped[str] = mapped_column(String(16), server_default=text("'unreviewed'"))
    review_note: Mapped[str | None] = mapped_column(Text)
    active_version_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = created()
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        CheckConstraint("(visibility='shared' and owner_id is null) or (visibility='private' and owner_id is not null)",
                        name="ck_source_visibility"),
        CheckConstraint("review_state in ('unreviewed','reviewed','rejected')", name="ck_source_review"),
    )


class KnowledgeVersion(Base):
    __tablename__ = "knowledge_versions"
    id: Mapped[uuid.UUID] = pk()
    source_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("knowledge_sources.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    checksum: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16))  # pending | ingesting | ready | active | failed | superseded
    error: Mapped[str | None] = mapped_column(Text)
    embed_model: Mapped[str] = mapped_column(String(120))
    embed_dim: Mapped[int] = mapped_column(Integer)
    ingestion_version: Mapped[str] = mapped_column(String(32))
    chunk_count: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    text: Mapped[str] = mapped_column(Text)
    retrieved_at: Mapped[datetime] = created()
    activated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (UniqueConstraint("source_id", "version", name="uq_kv_version"),
                      UniqueConstraint("source_id", "checksum", name="uq_kv_checksum"))


class KnowledgeChunk(Base):
    __tablename__ = "knowledge_chunks"
    id: Mapped[uuid.UUID] = pk()
    version_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("knowledge_versions.id", ondelete="CASCADE"), index=True)
    source_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("knowledge_sources.id", ondelete="CASCADE"), index=True)
    owner_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"))
    visibility: Mapped[str] = mapped_column(String(8))
    ord: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)
    embedding: Mapped[list[float]] = mapped_column(Vector(EMBED_DIM))
    tsv: Mapped[Any] = mapped_column(TSVECTOR)
    __table_args__ = (UniqueConstraint("version_id", "ord", name="uq_chunk_ord"),
                      Index("ix_chunk_tsv", "tsv", postgresql_using="gin"))


# --------------------------------------------------------------------------- durable operations
class Operation(Base):
    __tablename__ = "operations"
    id: Mapped[uuid.UUID] = pk()
    owner_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(40))
    state: Mapped[str] = mapped_column(String(24), server_default=text("'queued'"))
    stage: Mapped[str | None] = mapped_column(String(40))
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB)
    idempotency_key: Mapped[str | None] = mapped_column(String(120))
    payload_hash: Mapped[str] = mapped_column(String(64))
    attempt: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    max_attempts: Mapped[int] = mapped_column(Integer)
    lease_owner: Mapped[str | None] = mapped_column(String(80))
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    run_after: Mapped[datetime] = created()
    deadline_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    cancel_requested: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    error: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    result: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = created()
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        Index("uq_operation_idem", "owner_id", "kind", "idempotency_key", unique=True,
              postgresql_where=text("idempotency_key is not null")),
        Index("ix_operation_claim", "state", "run_after"),
        CheckConstraint("state in ('queued','running','partially_succeeded','succeeded','failed','timed_out',"
                        "'cancellation_requested','cancelled')", name="ck_operation_state"),
    )


class AuditEvent(Base):
    """Minimal, content-free audit trail (no PII beyond user id)."""

    __tablename__ = "audit_events"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    action: Mapped[str] = mapped_column(String(60))
    meta: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'"))
    created_at: Mapped[datetime] = created()


class DeletionJob(Base):
    """Durable cleanup of files left after an account's rows are deleted. No FK: user row is gone."""

    __tablename__ = "deletion_jobs"
    id: Mapped[uuid.UUID] = pk()
    subject_ref: Mapped[str] = mapped_column(String(64), unique=True)  # sha256 of user id
    storage_path: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), server_default=text("'pending'"))
    attempts: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    created_at: Mapped[datetime] = created()
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


OWNED_TABLES = [
    "profiles", "profile_facts", "jobs", "job_snapshots", "job_analyses", "job_corrections", "resumes",
    "resume_versions", "match_reports", "interview_sessions", "interview_questions", "interview_answers",
    "roadmaps", "roadmap_tasks", "roadmap_events", "applications", "application_events", "notes", "reminders",
    "notifications",
]
