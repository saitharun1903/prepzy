"""Create .env from .env.example, generating strong local secrets.

Never overwrites an existing .env. Run: python scripts/init_env.py
"""

from __future__ import annotations

import re
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    target = ROOT / ".env"
    if target.exists():
        print(".env already exists; leaving it unchanged.")
        return 0
    template = (ROOT / ".env.example").read_text(encoding="utf-8")
    values: dict[str, str] = {}
    out_lines = []
    for line in template.splitlines():
        m = re.match(r"^([A-Z0-9_]+)=(.*)$", line)
        if m:
            key, val = m.group(1), m.group(2)
            if val == "__generate__":
                val = secrets.token_urlsafe(32)
            elif val == "__generate_fernet__":
                import base64
                val = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()
            val = re.sub(r"\$\{([A-Z0-9_]+)\}", lambda mm: values.get(mm.group(1), ""), val)
            values[key] = val
            line = f"{key}={val}"
        out_lines.append(line)
    target.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
    print("Wrote .env with generated secrets (values not printed).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
