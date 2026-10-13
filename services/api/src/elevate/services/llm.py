"""Inference provider interface + Ollama adapter.

The endpoint is trusted operator configuration (ELEVATE_OLLAMA_URL); no client value can change it.
Structured outputs use Ollama's JSON-schema ``format``; results are still validated by Pydantic
by the caller — schema-shaped output is not proof of correctness.
"""

from __future__ import annotations

import json
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
        try:
            with httpx.Client(timeout=httpx.Timeout(timeout, connect=5.0)) as c:
                r = c.post(f"{self.base}{path}", json=body)
        except httpx.ConnectError as e:
            raise CapabilityUnavailable("The local AI model service is not running.", code="model_unavailable") from e
        except httpx.TimeoutException as e:
            raise CapabilityUnavailable("The local AI model did not respond in time.", code="model_timeout") from e
        if r.status_code == 404:
            raise CapabilityUnavailable(f"Model '{body.get('model')}' is not installed in Ollama.", code="model_missing")
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
        _provider = OllamaProvider() if get_settings().llm_provider == "ollama" else DisabledProvider()
    return _provider


def set_provider(p: LLMProvider | None) -> None:
    """Test boundary only."""
    global _provider
    _provider = p
