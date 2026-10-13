"""Central, validated configuration. Loaded once; invalid config fails fast at startup."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[4]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="ELEVATE_",
        env_file=(REPO_ROOT / ".env",),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    env: Literal["local", "test", "production"] = "local"
    web_url: str = "http://localhost:3000"
    allowed_origins: str = "http://localhost:3000"
    extension_ids: str = ""

    database_url: str
    migration_database_url: str | None = None
    db_pool_size: int = Field(5, ge=1, le=50)

    jwt_secret: str = Field(min_length=32)
    jwt_issuer: str = "elevate-local"
    jwt_audience: str = "elevate-api"
    access_token_minutes: int = Field(15, ge=1, le=60)
    refresh_token_days: int = Field(30, ge=1, le=90)
    admin_emails: str = ""

    llm_provider: Literal["ollama", "disabled"] = "ollama"
    ollama_url: str = "http://127.0.0.1:11434"
    llm_model: str = "qwen2.5-coder:7b"
    llm_temperature: float = Field(0.1, ge=0, le=1.5)
    llm_num_ctx: int = Field(8192, ge=2048, le=131072)
    llm_max_output_tokens: int = Field(2048, ge=128, le=8192)
    llm_timeout_seconds: float = Field(240, ge=5, le=1800)
    llm_concurrency: int = Field(1, ge=1, le=8)
    embed_model: str = "nomic-embed-text"
    embed_dim: int = 768

    rag_top_k: int = Field(6, ge=1, le=20)
    rag_max_distance: float = Field(0.55, gt=0, lt=2)
    chunk_chars: int = Field(1200, ge=200, le=6000)
    chunk_overlap: int = Field(150, ge=0, le=1000)

    data_dir: Path = Path("./data")
    max_upload_mb: int = Field(5, ge=1, le=50)
    max_resume_pages: int = Field(10, ge=1, le=50)
    max_job_text_chars: int = Field(60000, ge=1000, le=200000)
    export_retention_hours: int = 24

    worker_concurrency: int = Field(1, ge=1, le=8)
    worker_lease_seconds: int = Field(90, ge=15, le=3600)
    worker_poll_seconds: float = Field(2, gt=0, le=60)
    operation_max_attempts: int = Field(3, ge=1, le=10)
    operation_deadline_minutes: int = Field(20, ge=1, le=1440)
    max_queued_operations_per_user: int = Field(10, ge=1, le=1000)

    auth_rate_per_minute: int = Field(10, ge=1, le=1000)
    log_level: str = "INFO"

    @field_validator("data_dir")
    @classmethod
    def _resolve_data_dir(cls, v: Path) -> Path:
        return v if v.is_absolute() else (REPO_ROOT / v).resolve()

    @property
    def cors_origins(self) -> list[str]:
        origins = [o.strip() for o in self.allowed_origins.split(",") if o.strip()]
        origins += [f"chrome-extension://{i.strip()}" for i in self.extension_ids.split(",") if i.strip()]
        return origins

    @property
    def admin_email_set(self) -> set[str]:
        return {e.strip().lower() for e in self.admin_emails.split(",") if e.strip()}


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]  # values come from env / .env
