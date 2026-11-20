"""Start the combined Prepzy service: database bootstrap, then the API (with its embedded worker) on
127.0.0.1:8000 and the web app on $PORT, in one container. Used on free hosting so a single instance
serves everything and only one service has to stay awake.

If either process exits, the other is stopped and the container exits non-zero so the platform restarts it.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import db_bootstrap  # noqa: E402

API_PORT = "8000"
WEB_DIR = Path(os.environ.get("PREPZY_WEB_DIR", "/app/web"))


def wait_for_api(timeout: float = 90.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{API_PORT}/health/live", timeout=2)
            return True
        except Exception:  # noqa: BLE001 - still starting
            time.sleep(0.5)
    return False


def main() -> int:
    code = db_bootstrap.main()
    if code:
        return code
    api = subprocess.Popen([
        "uvicorn", "elevate.main:app", "--host", "127.0.0.1", "--port", API_PORT,
        "--proxy-headers", "--forwarded-allow-ips", "127.0.0.1", "--workers", "1", "--no-server-header",
    ], cwd=os.environ.get("PREPZY_API_DIR", "/app/services/api"))
    if not wait_for_api():
        print("API did not become healthy in time", file=sys.stderr, flush=True)
        api.terminate()
        return 1
    env = {**os.environ, "ELEVATE_API_URL": f"http://127.0.0.1:{API_PORT}", "HOSTNAME": "0.0.0.0"}
    web = subprocess.Popen(["node", "node_modules/next/dist/bin/next", "start", "apps/web", "-p", os.environ.get("PORT", "3000"),
                            "-H", "0.0.0.0"], cwd=WEB_DIR, env=env)
    procs = [api, web]

    def stop(*_: object) -> None:
        for p in procs:
            if p.poll() is None:
                p.terminate()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    while all(p.poll() is None for p in procs):
        time.sleep(1)
    stop()
    for p in procs:
        try:
            p.wait(timeout=20)
        except subprocess.TimeoutExpired:
            p.kill()
    return next((p.returncode for p in procs if p.returncode), 1)


if __name__ == "__main__":
    sys.exit(main())
