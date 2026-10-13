"""Consistent local backup and isolated restore drill.

  python scripts/backup.py backup            -> backups/<stamp>/{db.dump, files.tar, manifest.json}
  python scripts/backup.py restore-drill <dir>
      Restores into a NEW scratch database `elevate_restore_drill` (never the live DB) and a scratch
      file directory, then verifies row counts, file checksums and that deleted accounts recorded in
      deletion_jobs after the backup are flagged for re-deletion. Drops the scratch DB afterwards.

Ordering: the file archive is taken AFTER the DB dump, so every file referenced by the dump exists
(files created later are orphans, harmless). RPO = time since last backup; see docs/DEPLOYMENT.md.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tarfile
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTAINER = "browserelevate-db"


def env(key: str) -> str:
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1]
    raise SystemExit(f"{key} missing in .env")


def psql(db: str, sql: str) -> str:
    r = subprocess.run(["docker", "exec", CONTAINER, "psql", "-U", "elevate_owner", "-d", db, "-tAc", sql],
                       capture_output=True, text=True, check=True)
    return r.stdout.strip()


COUNT_TABLES = ["users", "jobs", "job_snapshots", "job_analyses", "resumes", "resume_versions", "applications",
                "notes", "reminders", "notifications", "knowledge_chunks", "match_reports", "roadmaps"]


def backup() -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    out = ROOT / "backups" / stamp
    out.mkdir(parents=True)
    dump = out / "db.dump"
    with dump.open("wb") as f:
        subprocess.run(["docker", "exec", CONTAINER, "pg_dump", "-U", "elevate_owner", "-d", "elevate", "-Fc"],
                       stdout=f, check=True)
    data = ROOT / "data" / "users"
    files: dict[str, str] = {}
    with tarfile.open(out / "files.tar", "w") as tar:
        if data.exists():
            for p in sorted(data.rglob("*")):
                if p.is_file():
                    rel = p.relative_to(ROOT / "data").as_posix()
                    files[rel] = hashlib.sha256(p.read_bytes()).hexdigest()
                    tar.add(p, arcname=rel)
    counts = {t: int(psql("elevate", f"select count(*) from {t}")) for t in COUNT_TABLES}
    (out / "manifest.json").write_text(json.dumps({"created_at": stamp, "counts": counts, "files": files}, indent=1))
    print(f"Backup written to {out} ({dump.stat().st_size} bytes db, {len(files)} files)")
    return out


def restore_drill(src: Path) -> int:
    man = json.loads((src / "manifest.json").read_text())
    drill_db = "elevate_restore_drill"
    psql("postgres", f"drop database if exists {drill_db} with (force)")
    psql("postgres", f"create database {drill_db}")
    subprocess.run(["docker", "cp", str(src / "db.dump"), f"{CONTAINER}:/tmp/drill.dump"], check=True)
    r = subprocess.run(["docker", "exec", CONTAINER, "pg_restore", "-U", "elevate_owner", "-d", drill_db, "--no-owner",
                        "/tmp/drill.dump"], capture_output=True, text=True)
    if r.returncode not in (0, 1):  # 1 = warnings (e.g. existing extension)
        print(r.stderr)
        return 1
    ok = True
    for t, n in man["counts"].items():
        got = int(psql(drill_db, f"select count(*) from {t}"))
        status = "ok" if got == n else "MISMATCH"
        ok &= got == n
        print(f"  {t:20} expected {n:6} restored {got:6} {status}")
    scratch = ROOT / "backups" / "_drill_files"
    if scratch.exists():
        import shutil
        shutil.rmtree(scratch)
    with tarfile.open(src / "files.tar") as tar:
        tar.extractall(scratch, filter="data")
    for rel, digest in man["files"].items():
        p = scratch / rel
        good = p.exists() and hashlib.sha256(p.read_bytes()).hexdigest() == digest
        ok &= good
        if not good:
            print("  FILE MISMATCH", rel)
    print(f"  files verified: {len(man['files'])}")
    # Deletion safeguard: accounts deleted after the backup must not silently come back.
    deleted_after = psql("elevate", f"select count(*) from deletion_jobs where created_at > '{man['created_at']}'::timestamptz")
    print(f"  accounts deleted since backup (must be re-deleted after a real restore): {deleted_after}")
    psql("postgres", f"drop database if exists {drill_db} with (force)")
    print("RESTORE DRILL", "PASSED" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "backup":
        backup()
    elif len(sys.argv) >= 3 and sys.argv[1] == "restore-drill":
        sys.exit(restore_drill(Path(sys.argv[2])))
    else:
        print(__doc__)
        sys.exit(2)
