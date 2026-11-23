"""Tiny local LaTeX compile server, run as its own unprivileged user with an EMPTY environment.

Started by start_prepzy.py (as uid `texrunner`) and reached only by the API over 127.0.0.1 with a per-boot
token. It holds no secrets: nothing in its environment, and it cannot read the API's /proc/<pid>/environ or
the app's files, so even a LaTeX trick that slipped past TeX Live's own restrictions has nothing to steal.
"""

from __future__ import annotations

import base64
import hmac
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services" / "api" / "src"))
from elevate.services.latex import MAX_SOURCE_CHARS, compile_tex  # noqa: E402

TOKEN = os.environ.get("LATEX_RUNNER_TOKEN", "")
PORT = int(os.environ.get("LATEX_RUNNER_PORT", "8100"))
SLOTS = threading.BoundedSemaphore(int(os.environ.get("LATEX_RUNNER_SLOTS", "2")))


class Handler(BaseHTTPRequestHandler):
    server_version = "latex-runner"

    def log_message(self, *args: object) -> None:  # no request logging (documents are private)
        return

    def _send(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        self._send(200 if self.path == "/health" else 404, {"ok": self.path == "/health"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/compile" or not TOKEN or not hmac.compare_digest(self.headers.get("X-Runner-Token", ""), TOKEN):
            self._send(403, {"error": "forbidden"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_SOURCE_CHARS * 4 + 1024:
            self._send(413, {"error": "too large"})
            return
        try:
            body = json.loads(self.rfile.read(length))
            source, previews = body["source"], body.get("previews", True)
            if not isinstance(source, str) or not isinstance(previews, bool):
                raise ValueError
        except (ValueError, KeyError, TypeError):
            self._send(400, {"error": "bad request"})
            return
        if not SLOTS.acquire(timeout=40):
            self._send(503, {"error": "busy"})
            return
        try:
            r = compile_tex(source, previews=previews)
        finally:
            SLOTS.release()
        self._send(200, {
            "ok": r.ok, "ms": r.ms, "page_count": r.page_count, "overfull": r.overfull, "log_tail": r.log_tail,
            "errors": [{"line": e.line, "message": e.message} for e in r.errors],
            "pdf": base64.b64encode(r.pdf).decode() if r.pdf else None,
            "pages": [base64.b64encode(p).decode() for p in r.pages],
        })


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
