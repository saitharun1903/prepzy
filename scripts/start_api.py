"""Single-service start (free hosting): bootstrap the database, then replace this process with uvicorn.

Used as the container command on platforms without a pre-deploy step:  python /app/scripts/start_api.py
No shell is involved, so nothing depends on how the platform quotes a command string.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import db_bootstrap  # noqa: E402


def main() -> None:
    code = db_bootstrap.main()
    if code:
        sys.exit(code)
    args = ["uvicorn", "elevate.main:app", "--host", "0.0.0.0", "--port", os.environ.get("PORT", "8000"),
            "--proxy-headers", "--forwarded-allow-ips", "*", "--workers", os.environ.get("WEB_CONCURRENCY", "1"),
            "--no-server-header"]
    os.execvp(args[0], args)


if __name__ == "__main__":
    main()
