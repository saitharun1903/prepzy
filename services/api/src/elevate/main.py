"""FastAPI application: `uv run uvicorn elevate.main:app --port 8000`."""

from __future__ import annotations

import logging
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, OperationalError
from starlette.exceptions import HTTPException as StarletteHTTPException

from .config import get_settings
from .db import engine, system_session
from .errors import AppError
from .logs import log, request_id_var, setup_logging

logger = logging.getLogger("elevate.api")
MAX_BODY = 8 * 1024 * 1024


def _err(status: int, code: str, message: str, *, retryable: bool = False, fields: dict[str, str] | None = None,
         extra: dict[str, Any] | None = None) -> JSONResponse:
    body: dict[str, Any] = {"error": {"code": code, "message": message, "request_id": request_id_var.get(),
                                      "retryable": retryable, "fields": fields or {}}}
    if extra:
        body["error"].update(extra)
    headers = {"Retry-After": str(extra["retry_after"])} if extra and "retry_after" in extra else None
    return JSONResponse(body, status_code=status, headers=headers)


def create_app() -> FastAPI:
    s = get_settings()
    setup_logging(s.log_level)
    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        stop = None
        if s.embedded_worker:
            # Same canonical module as `python -m elevate.worker`, so handlers share one registry.
            from elevate.worker import start_embedded
            stop = start_embedded()
        yield
        if stop is not None:
            stop.set()

    # The machine-readable API description is a map for attackers; publish it only outside production.
    app = FastAPI(title="Prepzy API", version="0.1.0", openapi_url="/api/v1/openapi.json" if s.env != "production" else None,
                  docs_url="/api/docs" if s.env != "production" else None, redoc_url=None, lifespan=lifespan)

    app.add_middleware(CORSMiddleware, allow_origins=s.cors_origins, allow_credentials=False,
                       allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
                       allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "X-Request-ID"],
                       expose_headers=["X-Request-ID", "Retry-After"], max_age=600)

    @app.middleware("http")
    async def request_context(request: Request, call_next: Any) -> Any:
        rid = request.headers.get("x-request-id")
        rid = rid if rid and len(rid) <= 64 and rid.replace("-", "").isalnum() else uuid.uuid4().hex
        token = request_id_var.set(rid)
        try:
            cl = request.headers.get("content-length")
            if cl and cl.isdigit() and int(cl) > MAX_BODY:
                return _err(413, "payload_too_large", "Request body is too large.")
            start = time.monotonic()
            response = await call_next(request)
            response.headers["X-Request-ID"] = rid
            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["Referrer-Policy"] = "no-referrer"
            response.headers["Cache-Control"] = "no-store"
            if s.env == "production":
                response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
            if not request.url.path.startswith("/api/docs"):
                response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"
            log(logger, logging.INFO, "request", method=request.method, path=request.url.path,
                status=response.status_code, ms=int((time.monotonic() - start) * 1000))
            return response
        finally:
            request_id_var.reset(token)

    @app.exception_handler(AppError)
    async def app_error(_: Request, e: AppError) -> JSONResponse:
        return _err(e.status_code, e.code, e.message, retryable=e.retryable, fields=e.fields, extra=e.extra)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, e: RequestValidationError) -> JSONResponse:
        fields = {".".join(str(p) for p in err["loc"][1:]) or "body": err["msg"] for err in e.errors()}
        return _err(422, "validation_failed", "Some fields are invalid.", fields=fields)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, e: StarletteHTTPException) -> JSONResponse:
        return _err(e.status_code, "http_error", str(e.detail))

    @app.exception_handler(IntegrityError)
    async def integrity_error(_: Request, e: IntegrityError) -> JSONResponse:
        logger.warning("integrity error", exc_info=False)
        return _err(409, "conflict", "This change conflicts with existing data. Refresh and try again.", retryable=True)

    @app.exception_handler(OperationalError)
    async def db_error(_: Request, e: OperationalError) -> JSONResponse:
        logger.error("database unavailable")
        return _err(503, "database_unavailable", "The database is unavailable. Try again shortly.", retryable=True)

    @app.exception_handler(Exception)
    async def unhandled(_: Request, e: Exception) -> JSONResponse:
        logger.exception("unhandled error")
        return _err(500, "internal_error", "An unexpected error occurred.", retryable=True)

    @app.get("/health/live", tags=["health"])
    def live() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/health/ready", tags=["health"])
    def ready(request: Request) -> JSONResponse:
        from .services.llm import get_provider
        checks: dict[str, Any] = {}
        try:
            with engine().connect() as c:
                c.execute(text("select 1"))
            checks["database"] = "ok"
        except OperationalError as e:
            checks["database"] = "unavailable"
            # Server log only (never in the response): the driver's reason, e.g. "password authentication
            # failed for user ...". libpq messages name host and user but never include the password.
            reason = str(getattr(e, "orig", e)).strip().splitlines()
            log(logger, logging.ERROR, "database check failed", reason=reason[0][:300] if reason else type(e).__name__)
        try:
            with system_session() as db:
                row = db.execute(text("select count(*) filter (where state='queued'), "
                                      "extract(epoch from now() - min(created_at) filter (where state='queued')), "
                                      "max(heartbeat_at) from operations")).one()
            checks["queue"] = {"queued": row[0], "oldest_queued_seconds": int(row[1]) if row[1] else 0,
                               "last_worker_heartbeat": row[2].isoformat() if row[2] else None}
        except OperationalError:
            checks["queue"] = "unavailable"
        checks["ai"] = get_provider().health()
        from .services.storage import get_storage
        checks["storage"] = get_storage().health()
        ok = checks["database"] == "ok"
        body: dict[str, Any] = {"status": "ready" if ok else "not_ready"}
        # Component details (model, provider, queue) only for the operator: outside production, or with
        # the metrics token. Uptime monitors only need the status and HTTP code.
        import secrets as _secrets
        auth = request.headers.get("authorization", "")
        if s.env != "production" or (s.metrics_token and _secrets.compare_digest(auth, f"Bearer {s.metrics_token}")):
            body["checks"] = checks
        return JSONResponse(body, status_code=200 if ok else 503)

    @app.get("/metrics", tags=["health"], include_in_schema=False)
    def metrics(request: Request) -> Any:
        """Prometheus text metrics (counts only, no personal data). Requires ELEVATE_METRICS_TOKEN."""
        import secrets as _secrets

        from fastapi.responses import PlainTextResponse
        token = s.metrics_token
        auth = request.headers.get("authorization", "")
        if not token or not _secrets.compare_digest(auth, f"Bearer {token}"):
            return _err(404, "not_found", "Not found.")
        lines: list[str] = []
        with system_session() as db:
            for state, n in db.execute(text("select state, count(*) from operations group by state")).all():
                lines.append(f'elevate_operations{{state="{state}"}} {n}')
            oldest = db.execute(text("select coalesce(extract(epoch from now() - min(created_at)), 0) from operations "
                                     "where state = 'queued'")).scalar()
            lines.append(f"elevate_queue_oldest_seconds {int(oldest or 0)}")
            failed = db.execute(text("select count(*) from operations where state in ('failed','timed_out') "
                                     "and finished_at > now() - interval '1 hour'")).scalar()
            lines.append(f"elevate_operations_failed_last_hour {failed}")
            overdue = db.execute(text("select count(*) from reminders where status = 'scheduled' "
                                      "and due_at < now() - interval '5 minutes'")).scalar()
            lines.append(f"elevate_reminders_overdue {overdue}")
            hb = db.execute(text("select coalesce(extract(epoch from now() - max(heartbeat_at)), -1) from operations")).scalar()
            lines.append(f"elevate_worker_last_heartbeat_seconds {int(hb)}")
            users = db.execute(text("select count(*) from users where deleted_at is null")).scalar()
            lines.append(f"elevate_users_total {users}")
        lines.append(f'elevate_ai_reachable {1 if get_provider_health_ok() else 0}')
        return PlainTextResponse("\n".join(lines) + "\n", media_type="text/plain; version=0.0.4")

    def get_provider_health_ok() -> bool:
        from .services.llm import get_provider
        h = get_provider().health()
        return bool(h.get("reachable") and h.get("llm_installed"))

    from .routers import (
        account,
        applications,
        auth,
        capabilities,
        interviews,
        jobs,
        knowledge,
        matching,
        notifications,
        operations,
        profile,
        resumes,
        roadmaps,
    )
    for r in (auth, jobs, operations, profile, resumes, matching, interviews, roadmaps, applications, notifications,
              knowledge, account, capabilities):
        app.include_router(r.router)
    return app


app = create_app()
