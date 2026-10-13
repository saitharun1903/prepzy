"""Structured JSON logging with request/operation correlation. Never log bodies, tokens or resume text."""

from __future__ import annotations

import contextvars
import json
import logging
import sys
from datetime import UTC, datetime

request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("request_id", default=None)
operation_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("operation_id", default=None)

_REDACT_KEYS = {"password", "token", "authorization", "refresh_token", "access_token", "text", "answer", "body"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        out: dict[str, object] = {
            "ts": datetime.now(UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if rid := request_id_var.get():
            out["request_id"] = rid
        if oid := operation_id_var.get():
            out["operation_id"] = oid
        extra = getattr(record, "ctx", None)
        if isinstance(extra, dict):
            out.update({k: ("[redacted]" if k.lower() in _REDACT_KEYS else v) for k, v in extra.items()})
        if record.exc_info:
            out["exc"] = self.formatException(record.exc_info)
        return json.dumps(out, default=str)


def setup_logging(level: str) -> None:
    root = logging.getLogger()
    root.handlers.clear()
    h = logging.StreamHandler(sys.stdout)
    h.setFormatter(JsonFormatter())
    root.addHandler(h)
    root.setLevel(level.upper())
    for noisy in ("uvicorn.access", "httpx", "httpcore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def log(logger: logging.Logger, level: int, msg: str, **ctx: object) -> None:
    logger.log(level, msg, extra={"ctx": ctx})
