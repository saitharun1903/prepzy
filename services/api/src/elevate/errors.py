"""Typed application errors and the single public error body shape."""

from __future__ import annotations

from typing import Any


class AppError(Exception):
    status_code = 400
    code = "bad_request"
    retryable = False

    def __init__(self, message: str, *, code: str | None = None, fields: dict[str, str] | None = None,
                 status_code: int | None = None, retryable: bool | None = None, extra: dict[str, Any] | None = None):
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        if status_code:
            self.status_code = status_code
        if retryable is not None:
            self.retryable = retryable
        self.fields = fields or {}
        self.extra = extra or {}


class NotFound(AppError):
    status_code = 404
    code = "not_found"


class Unauthorized(AppError):
    status_code = 401
    code = "unauthorized"


class Forbidden(AppError):
    status_code = 403
    code = "forbidden"


class Conflict(AppError):
    status_code = 409
    code = "conflict"


class ValidationFailed(AppError):
    status_code = 422
    code = "validation_failed"


class TooManyRequests(AppError):
    status_code = 429
    code = "rate_limited"
    retryable = True


class CapabilityUnavailable(AppError):
    """An optional dependency (e.g. the local model) is not reachable/configured."""

    status_code = 503
    code = "capability_unavailable"
    retryable = True


class ModelOutputInvalid(AppError):
    status_code = 502
    code = "model_output_invalid"
    retryable = True
