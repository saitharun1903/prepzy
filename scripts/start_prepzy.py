"""Start the combined Prepzy service: database bootstrap, then the API (with its embedded worker) on
127.0.0.1:8000 and the web app on $PORT, in one container. Used on free hosting so a single instance
serves everything and only one service has to stay awake.

If either process exits, the other is stopped and the container exits non-zero so the platform restarts it.

Privilege separation (when started as root, as in the production image):
  * the API and web app run as the `prepzy` user;
  * the LaTeX resume compiler runs as `texrunner` with an EMPTY environment and a per-boot token, so user LaTeX
    can never see the app's secrets: it cannot read the API's /proc/<pid>/environ or its files.
Started as a normal user (local development), everything runs as that user and LaTeX compiles in-process.
"""

from __future__ import annotations

import os
import pwd
import secrets
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import db_bootstrap  # noqa: E402

API_PORT = "8000"
LATEX_PORT = "8100"
ROOT = os.geteuid() == 0


def as_user(name: str) -> dict:
    """subprocess kwargs that start a child as `name` (only possible when we are root)."""
    if not ROOT:
        return {}
    pw = pwd.getpwnam(name)
    return {"user": pw.pw_uid, "group": pw.pw_gid, "extra_groups": []}


def start_latex_runner() -> tuple[subprocess.Popen | None, dict[str, str]]:
    if not ROOT:
        return None, {}
    try:
        pwd.getpwnam("texrunner")
    except KeyError:
        print("texrunner user missing; LaTeX compiles in-process", file=sys.stderr, flush=True)
        return None, {}
    token = secrets.token_urlsafe(32)
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp", "LANG": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1",
           "LATEX_RUNNER_TOKEN": token, "LATEX_RUNNER_PORT": LATEX_PORT}
    runner = subprocess.Popen(["/usr/local/bin/python3", "-I", "/app/scripts/latex_runner.py"], cwd="/tmp", env=env,
                              **as_user("texrunner"))
    return runner, {"ELEVATE_LATEX_RUNNER_URL": f"http://127.0.0.1:{LATEX_PORT}", "ELEVATE_LATEX_RUNNER_TOKEN": token}
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
    if ROOT:  # run the bootstrap as the app user too, so anything it creates is owned by prepzy
        code = subprocess.call([sys.executable, str(Path(__file__).resolve().parent / "db_bootstrap.py")], **as_user("prepzy"))
    else:
        code = db_bootstrap.main()
    if code:
        return code
    runner, runner_env = start_latex_runner()
    app_home = {"HOME": pwd.getpwnam("prepzy").pw_dir} if ROOT else {}
    api = subprocess.Popen([
        "uvicorn", "elevate.main:app", "--host", "127.0.0.1", "--port", API_PORT,
        # Loopback-only listener: only the web app in this container can reach it, and it sets a single
        # edge-verified X-Forwarded-For, so trusting forwarded headers here is safe.
        "--proxy-headers", "--forwarded-allow-ips", "*", "--workers", "1", "--no-server-header",
    ], cwd=os.environ.get("PREPZY_API_DIR", "/app/services/api"), env={**os.environ, **app_home, **runner_env}, **as_user("prepzy"))
    if not wait_for_api():
        print("API did not become healthy in time", file=sys.stderr, flush=True)
        api.terminate()
        if runner:
            runner.terminate()
        return 1
    # The web app is the container's only public listener; the API stays on loopback.
    public = "0.0.0.0"  # noqa: S104 - intentional: the platform routes traffic to this port
    env = {**os.environ, **app_home, "ELEVATE_API_URL": f"http://127.0.0.1:{API_PORT}", "HOSTNAME": public}
    web = subprocess.Popen(["node", "node_modules/next/dist/bin/next", "start", "apps/web", "-p", os.environ.get("PORT", "3000"),
                            "-H", public], cwd=WEB_DIR, env=env, **as_user("prepzy"))
    procs = [api, web] + ([runner] if runner else [])

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
