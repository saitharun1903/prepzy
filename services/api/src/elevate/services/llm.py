"""Inference provider interface + adapters: Ollama (self-hosted) and OpenAI-compatible APIs (e.g. Groq).

Endpoints are trusted operator configuration (ELEVATE_OLLAMA_URL / ELEVATE_OPENAI_BASE_URL); no client
value can change them.
Structured outputs use Ollama's JSON-schema ``format``; results are still validated by Pydantic
by the caller — schema-shaped output is not proof of correctness.
"""

from __future__ import annotations

import json
import re
import threading
import time
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from ..config import get_settings
from ..errors import CapabilityUnavailable, ModelOutputInvalid


@dataclass(frozen=True)
class Completion:
    data: dict[str, Any]
    model: str
    duration_ms: int
    prompt_tokens: int | None
    output_tokens: int | None


MAX_RATE_LIMIT_WAIT_SECONDS = 20.0


def _retry_after_seconds(headers: Any) -> float | None:
    """Seconds the provider asks us to wait (Retry-After, or Groq/OpenAI reset headers like '7.2s')."""
    for name in ("retry-after", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"):
        raw = headers.get(name)
        if not raw:
            continue
        m = re.fullmatch(r"\s*(?:(\d+)m(?!s))?\s*([\d.]+)?(ms|s)?\s*", str(raw))
        if not m or (m.group(1) is None and m.group(2) is None):
            continue
        secs = float(m.group(1) or 0) * 60 + float(m.group(2) or 0) * (0.001 if m.group(3) == "ms" else 1)
        return max(0.5, min(secs, 600.0))
    return None

class LLMProvider(Protocol):
    def generate_json(self, system: str, user: str, schema: dict[str, Any], *, max_tokens: int | None = None,
                      cancel_check: Any = None) -> Completion: ...

    def embed(self, texts: list[str]) -> list[list[float]]: ...

    def health(self) -> dict[str, Any]: ...


_sem: threading.BoundedSemaphore | None = None


def _semaphore() -> threading.BoundedSemaphore:
    global _sem
    if _sem is None:
        _sem = threading.BoundedSemaphore(get_settings().llm_concurrency)
    return _sem


class OllamaProvider:
    def __init__(self) -> None:
        s = get_settings()
        self.base = s.ollama_url.rstrip("/")
        self.model = s.llm_model
        self.embed_model = s.embed_model
        self.embed_dim = s.embed_dim
        self.timeout = s.llm_timeout_seconds
        self.temperature = s.llm_temperature
        self.num_ctx = s.llm_num_ctx
        self.max_tokens = s.llm_max_output_tokens

    def _post(self, path: str, body: dict[str, Any], timeout: float) -> dict[str, Any]:
        r = None
        for attempt in range(2):  # one quick retry: Ollama returns 5xx while its runner (re)starts
            try:
                with httpx.Client(timeout=httpx.Timeout(timeout, connect=5.0)) as c:
                    r = c.post(f"{self.base}{path}", json=body)
            except httpx.ConnectError as e:
                raise CapabilityUnavailable("The local AI model service is not running.", code="model_unavailable") from e
            except httpx.TimeoutException as e:
                raise CapabilityUnavailable("The local AI model did not respond in time.", code="model_timeout") from e
            if r.status_code < 500 or attempt == 1:
                break
            time.sleep(5)
        assert r is not None
        if r.status_code == 404:
            raise CapabilityUnavailable(f"Model '{body.get('model')}' is not installed in Ollama.", code="model_missing",
                                        retryable=False)
        if r.status_code >= 400:
            raise CapabilityUnavailable(f"Model service error ({r.status_code}).", code="model_error")
        return r.json()

    def generate_json(self, system: str, user: str, schema: dict[str, Any], *, max_tokens: int | None = None,
                      cancel_check: Any = None) -> Completion:
        body = {
            "model": self.model, "stream": False, "format": schema,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "options": {"temperature": self.temperature, "num_ctx": self.num_ctx,
                        "num_predict": max_tokens or self.max_tokens},
            "keep_alive": "10m",
        }
        start = time.monotonic()
        with _semaphore():
            if cancel_check and cancel_check():
                raise InterruptedError("cancelled before inference")
            data = self._post("/api/chat", body, self.timeout)
        content = (data.get("message") or {}).get("content", "")
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError as e:
            raise ModelOutputInvalid("The model returned malformed JSON.") from e
        if not isinstance(parsed, dict):
            raise ModelOutputInvalid("The model returned an unexpected structure.")
        return Completion(parsed, self.model, int((time.monotonic() - start) * 1000),
                          data.get("prompt_eval_count"), data.get("eval_count"))

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        data = self._post("/api/embed", {"model": self.embed_model, "input": texts, "keep_alive": "10m"}, 120)
        vecs = data.get("embeddings") or []
        if len(vecs) != len(texts) or any(len(v) != self.embed_dim for v in vecs):
            raise ModelOutputInvalid(f"Embedding model returned unexpected dimensions (expected {self.embed_dim}).")
        return vecs

    def health(self) -> dict[str, Any]:
        try:
            with httpx.Client(timeout=3.0) as c:
                tags = c.get(f"{self.base}/api/tags").json()
        except (httpx.HTTPError, ValueError):
            return {"reachable": False, "llm_installed": False, "embed_installed": False}
        names = {m.get("name") for m in tags.get("models", [])}
        def has(n: str) -> bool:
            return n in names or f"{n}:latest" in names
        return {"reachable": True, "llm_installed": has(self.model), "embed_installed": has(self.embed_model),
                "llm_model": self.model, "embed_model": self.embed_model}


class OpenAICompatProvider:
    """Any OpenAI-compatible chat API (default: Groq's free tier). JSON mode plus the schema in the
    system prompt; the caller still validates with Pydantic and checks quotes against the source.
    No embeddings: semantic knowledge search reports itself unavailable."""

    def __init__(self) -> None:
        s = get_settings()
        self.base = s.openai_base_url.rstrip("/")
        self.key = s.openai_api_key
        self.model = s.llm_model
        self.timeout = s.llm_timeout_seconds
        self.temperature = s.llm_temperature
        self.max_tokens = s.llm_max_output_tokens
        self._health: tuple[float, dict[str, Any]] | None = None

    def generate_json(self, system: str, user: str, schema: dict[str, Any], *, max_tokens: int | None = None,
                      cancel_check: Any = None) -> Completion:
        if not self.key:
            raise CapabilityUnavailable("The AI service key is not configured.", code="ai_disabled", retryable=False)
        sys_prompt = (f"{system}\n\nRespond with one JSON object only. It must conform to this JSON Schema:\n"
                      f"{json.dumps(schema, separators=(',', ':'))}")
        body = {
            "model": self.model, "temperature": self.temperature, "max_tokens": max_tokens or self.max_tokens,
            "response_format": {"type": "json_object"},
            "messages": [{"role": "system", "content": sys_prompt}, {"role": "user", "content": user}],
        }
        if "gpt-oss" in self.model:
            # Reasoning models: keep thinking short so the answer fits max_tokens and free-tier token limits.
            body["reasoning_effort"] = "low"
        start = time.monotonic()
        with _semaphore():
            if cancel_check and cancel_check():
                raise InterruptedError("cancelled before inference")
            data = self._post(body)
        choice = (data.get("choices") or [{}])[0]
        content = (choice.get("message") or {}).get("content") or ""
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError as e:
            raise ModelOutputInvalid("The model returned malformed JSON.") from e
        if not isinstance(parsed, dict):
            raise ModelOutputInvalid("The model returned an unexpected structure.")
        usage = data.get("usage") or {}
        return Completion(parsed, self.model, int((time.monotonic() - start) * 1000),
                          usage.get("prompt_tokens"), usage.get("completion_tokens"))

    def _post(self, body: dict[str, Any]) -> dict[str, Any]:
        r = None
        waited_for_limit = False
        for attempt in range(3):  # one quick retry on a transient 5xx; one short wait on a rate limit
            try:
                with httpx.Client(timeout=httpx.Timeout(self.timeout, connect=10.0)) as c:
                    r = c.post(f"{self.base}/chat/completions", json=body,
                               headers={"Authorization": f"Bearer {self.key}"})
            except httpx.ConnectError as e:
                raise CapabilityUnavailable("The AI service could not be reached.", code="model_unavailable") from e
            except httpx.TimeoutException as e:
                raise CapabilityUnavailable("The AI service did not respond in time.", code="model_timeout") from e
            if r.status_code == 429 and not waited_for_limit:
                # Free tiers limit requests per minute and say when to come back. A short wait here
                # keeps the user's result complete instead of falling back to a partial analysis.
                delay = _retry_after_seconds(r.headers)
                if delay is not None and delay <= MAX_RATE_LIMIT_WAIT_SECONDS:
                    waited_for_limit = True
                    time.sleep(delay)
                    continue
                break
            if r.status_code < 500 or attempt >= 1:
                break
            time.sleep(3)
        assert r is not None
        if r.status_code == 429:
            # Free-tier limits: the worker retries with backoff.
            raise CapabilityUnavailable("The AI service's free usage limit was reached. Retrying shortly.",
                                        code="model_rate_limited")
        if r.status_code == 413:
            raise CapabilityUnavailable("This text is too long for the AI service's limits.", code="input_too_large",
                                        retryable=False)
        if r.status_code in (401, 403):
            raise CapabilityUnavailable("The AI service rejected the configured key.", code="model_auth",
                                        retryable=False)
        if r.status_code == 404:
            raise CapabilityUnavailable(f"Model '{self.model}' is not available from the AI service.",
                                        code="model_missing", retryable=False)
        if r.status_code == 400 and "json_validate_failed" in r.text:
            raise ModelOutputInvalid("The model returned malformed JSON.")
        if r.status_code >= 400:
            raise CapabilityUnavailable(f"AI service error ({r.status_code}).", code="model_error")
        return r.json()

    def embed(self, texts: list[str]) -> list[list[float]]:
        raise CapabilityUnavailable("Semantic search is not available with the configured AI service.",
                                    code="embeddings_unavailable", retryable=False)

    def health(self) -> dict[str, Any]:
        # Cached: /health/ready and /metrics must not spend the provider's request quota.
        now = time.monotonic()
        if self._health and now - self._health[0] < 120:
            return self._health[1]
        h: dict[str, Any] = {"reachable": False, "llm_installed": False, "embed_installed": False}
        if self.key:
            try:
                with httpx.Client(timeout=4.0) as c:
                    r = c.get(f"{self.base}/models", headers={"Authorization": f"Bearer {self.key}"})
                ids = {m.get("id") for m in r.json().get("data", [])} if r.status_code == 200 else set()
                h = {"reachable": r.status_code == 200, "llm_installed": self.model in ids, "embed_installed": False,
                     "llm_model": self.model, "provider": "openai-compatible"}
            except (httpx.HTTPError, ValueError):
                pass
        self._health = (now, h)
        return h


class DisabledProvider:
    def generate_json(self, *a: Any, **k: Any) -> Completion:
        raise CapabilityUnavailable("AI features are disabled by configuration.", code="ai_disabled", retryable=False)

    def embed(self, texts: list[str]) -> list[list[float]]:
        raise CapabilityUnavailable("AI features are disabled by configuration.", code="ai_disabled", retryable=False)

    def health(self) -> dict[str, Any]:
        return {"reachable": False, "disabled": True}


_provider: LLMProvider | None = None


def get_provider() -> LLMProvider:
    global _provider
    if _provider is None:
        kind = get_settings().llm_provider
        _provider = (OllamaProvider() if kind == "ollama" else OpenAICompatProvider() if kind == "openai"
                     else DisabledProvider())
    return _provider


def set_provider(p: LLMProvider | None) -> None:
    """Test boundary only."""
    global _provider
    _provider = p
