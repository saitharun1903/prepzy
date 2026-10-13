"""Central, validated configuration. Loaded once; invalid config fails fast at startup."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[4]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="ELEVATE_",
        env_file=(REPO_ROOT / ".env",),
        env_file_encoding="utf-8",
        extra="ignore",
        hide_input_in_errors=True,  # never echo secrets from env/.env into startup errors or logs
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

    llm_provider: Literal["ollama", "openai", "disabled"] = "ollama"
    ollama_url: str = "http://127.0.0.1:11434"
    # OpenAI-compatible API (llm_provider=openai). Default: Groq, whose free tier needs no card.
    openai_base_url: str = "https://api.groq.com/openai/v1"
    openai_api_key: str = ""
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
    api_rate_per_minute: int = Field(240, ge=10, le=100000)
    log_level: str = "INFO"

    # ---- account security
    data_key: str = Field(default="", description="Fernet key encrypting TOTP secrets")
    require_verified_email: bool = False
    lockout_threshold: int = Field(5, ge=3, le=20)
    lockout_minutes: int = Field(15, ge=1, le=1440)

    # ---- email (verification + password reset)
    email_backend: Literal["console", "smtp"] = "console"
    email_from: str = "Elevate <no-reply@localhost>"
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_starttls: bool = True

    # ---- private file storage
    storage_backend: Literal["local", "s3", "db"] = "local"
    s3_endpoint_url: str = ""
    s3_bucket: str = ""
    s3_region: str = "auto"
    s3_access_key_id: str = ""
    s3_secret_access_key: str = ""

    # ---- operations
    metrics_token: str = ""
    # Run the durable worker inside the API process (single-service hosting, e.g. free plans
    # without background workers). Leases still fence every write, so a separate worker is optional.
    embedded_worker: bool = False

    @field_validator("ollama_url")
    @classmethod
    def _ollama_scheme(cls, v: str) -> str:
        """Platforms inject private addresses as "host:port"; inference stays on the private network."""
        v = v.strip().rstrip("/")
        return v if "://" in v else f"http://{v}"

    @field_validator("data_dir")
    @classmethod
    def _resolve_data_dir(cls, v: Path) -> Path:
        return v if v.is_absolute() else (REPO_ROOT / v).resolve()

    @model_validator(mode="after")
    def _production_guard(self) -> Settings:
        """Refuse to start in production with development defaults or unsafe settings."""
        if self.env != "production":
            return self
        problems: list[str] = []
        if not self.web_url.startswith("https://"):
            problems.append("ELEVATE_WEB_URL must be https")
        for o in self.allowed_origins.split(","):
            if o.strip() and not o.strip().startswith("https://"):
                problems.append(f"ELEVATE_ALLOWED_ORIGINS contains a non-https origin: {o.strip()}")
        if "localhost" in self.allowed_origins or "127.0.0.1" in self.allowed_origins:
            problems.append("ELEVATE_ALLOWED_ORIGINS must not contain localhost")
        if len(self.jwt_secret) < 43:
            problems.append("ELEVATE_JWT_SECRET must be >= 32 random bytes (43+ chars urlsafe)")
        if len(self.data_key) != 44:
            problems.append("ELEVATE_DATA_KEY must be a Fernet key (python -c 'from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())')")
        if self.email_backend != "smtp" or not self.smtp_host:
            problems.append("Production requires ELEVATE_EMAIL_BACKEND=smtp with ELEVATE_SMTP_HOST (verification/reset emails)")
        if self.storage_backend == "local":
            problems.append("Production requires ELEVATE_STORAGE_BACKEND=s3 or db (platform disks are ephemeral)")
        if self.storage_backend == "s3" and not (self.s3_bucket and self.s3_access_key_id and self.s3_secret_access_key):
            problems.append("ELEVATE_STORAGE_BACKEND=s3 needs ELEVATE_S3_BUCKET and access key credentials")
        if self.llm_provider == "openai" and (not self.openai_api_key or not self.openai_base_url.startswith("https://")):
            problems.append("ELEVATE_LLM_PROVIDER=openai needs ELEVATE_OPENAI_API_KEY and an https ELEVATE_OPENAI_BASE_URL")
        if "sslmode=" not in self.database_url and "127.0.0.1" not in self.database_url:
            problems.append("ELEVATE_DATABASE_URL must set sslmode=require for a remote database")
        if not self.metrics_token or len(self.metrics_token) < 24:
            problems.append("ELEVATE_METRICS_TOKEN must be set (>= 24 chars)")
        if problems:
            raise ValueError("Unsafe production configuration:\n- " + "\n- ".join(problems))
        return self

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
