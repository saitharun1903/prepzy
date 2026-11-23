"""Compile untrusted LaTeX (user resumes) to PDF + page previews.

Self-contained on purpose: no application settings, secrets or database imports, so it can run inside the
unprivileged LaTeX runner process (scripts/latex_runner.py) that holds nothing worth stealing.

Defences, in layers:
  1. TeX Live hardening: shell escape off (-no-shell-escape, shell_escape=f) and kpathsea "paranoid" file
     access (openin_any=p / openout_any=p): no absolute paths, no "..", no dot-files, writes only in the job dir.
  2. A fresh empty job directory per compile; nothing else readable relative to it.
  3. A minimal environment (no inherited variables, so no secrets in /proc/self/environ).
  4. Resource limits: CPU seconds, address space, file size, wall-clock timeout, source size.
  5. In production the runner itself runs as a separate uid with an empty environment, so even a TeX trick
     could not read other processes' /proc/<pid>/environ or the app's files.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass, field

MAX_SOURCE_CHARS = 150_000
CPU_SECONDS = 25
WALL_SECONDS = 35
MEMORY_BYTES = 1536 * 1024 * 1024
MAX_FILE_BYTES = 30 * 1024 * 1024
PREVIEW_DPI = 150
MAX_PREVIEW_PAGES = 4


@dataclass
class TexError:
    line: int | None
    message: str


@dataclass
class CompileResult:
    ok: bool
    pdf: bytes | None = None
    pages: list[bytes] = field(default_factory=list)
    errors: list[TexError] = field(default_factory=list)
    log_tail: str = ""
    ms: int = 0
    page_count: int = 0
    overfull: bool = False  # content ran past the bottom of a fixed-height box (used by fit-to-page)


def _limited(cmd: list[str]) -> list[str]:
    """Apply resource limits with util-linux `prlimit` (fork-safe in a threaded server, unlike preexec_fn)."""
    pl = shutil.which("prlimit", path="/usr/local/bin:/usr/bin:/bin")
    if not pl:
        return cmd
    return [pl, f"--cpu={CPU_SECONDS}", f"--as={MEMORY_BYTES}", f"--fsize={MAX_FILE_BYTES}", "--core=0", "--nproc=64", "--",
            *cmd]


def _env(job: str) -> dict[str, str]:
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": job,
        "LANG": "C.UTF-8",
        "TEXMFOUTPUT": job,
        "TEXMFVAR": os.path.join(job, ".texmf-var"),
        "openin_any": "p",
        "openout_any": "p",
        "shell_escape": "f",
        "max_print_line": "1000",
        "SOURCE_DATE_EPOCH": "0",
    }


_FILE_LINE = re.compile(r"^\./main\.tex:(\d+): (.+)$", re.M)
_BANG = re.compile(r"^! (.+)$", re.M)
_LNUM = re.compile(r"^l\.(\d+)", re.M)


def parse_errors(log: str) -> list[TexError]:
    noise = ("Emergency stop", "==> Fatal error")
    out: list[TexError] = []
    for m in _FILE_LINE.finditer(log):
        if not m.group(2).strip().startswith(noise):
            out.append(TexError(int(m.group(1)), m.group(2).strip()))
    for m in _BANG.finditer(log):
        msg = m.group(1).strip()
        if msg.startswith(noise):
            continue
        ln = _LNUM.search(log, m.end(), m.end() + 2000)
        out.append(TexError(int(ln.group(1)) if ln else None, msg))
    f = re.search(r"I can't find file `([^']+)'", log)
    if f:
        out.insert(0, TexError(None, f"File '{f.group(1)}' can't be used here. Only this document and installed "
                                     "packages are available."))
    if not out and "Emergency stop" in log:
        out.append(TexError(None, "LaTeX stopped early. Check for a missing \\end{document} or an unclosed brace."))
    seen, uniq = set(), []
    for e in out:
        key = e.message.removeprefix("LaTeX Error: ")
        if key not in seen:
            seen.add(key)
            uniq.append(TexError(e.line, key))
    return uniq[:20]


def _friendly(e: TexError) -> TexError:
    msg = e.message
    if msg.startswith("==> Fatal error"):
        return TexError(None, "")
    m = re.search(r"File `([^']+)' not found", msg) or re.search(r"File '([^']+)' can't be used", msg)
    if m and (m.group(1).startswith("/") or ".." in m.group(1)):
        msg = "Reading files outside this document isn't allowed."
    elif "I can't write on file" in msg:
        msg = "Writing files isn't allowed here."
    elif m:
        msg = (f"Package or file '{m.group(1)}' isn't available. Remove it, or use a common package "
               "(geometry, titlesec, enumitem, hyperref, xcolor, fontawesome5, tabularx …).")
    elif "Undefined control sequence" in msg:
        msg = "Unknown command (a typo, or a command from a package you haven't loaded)."
    elif "not writable" in msg or "Not reading" in msg or "openin_any" in msg:
        msg = "Reading or writing files outside this document isn't allowed."
    return TexError(e.line, msg)


def compile_tex(source: str, *, engine: str = "pdflatex", previews: bool = True) -> CompileResult:
    started = time.monotonic()
    if len(source) > MAX_SOURCE_CHARS:
        return CompileResult(ok=False, errors=[TexError(None, "The document is too long (150,000 characters max).")])
    if "\\documentclass" not in source:
        return CompileResult(ok=False, errors=[TexError(None, "Missing \\documentclass — start from a template.")])
    exe = shutil.which(engine, path="/usr/local/bin:/usr/bin:/bin")
    if not exe:
        return CompileResult(ok=False, errors=[TexError(None, "The LaTeX compiler isn't installed on this server.")])
    job = tempfile.mkdtemp(prefix="tex-")
    try:
        os.chmod(job, 0o700)
        with open(os.path.join(job, "main.tex"), "w", encoding="utf-8") as f:
            f.write(source)
        cmd = [exe, "-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "main.tex"]
        log = ""
        for _ in range(2):  # a second pass only when LaTeX asks for it (labels / hyperref)
            try:
                subprocess.run(_limited(cmd), cwd=job, env=_env(job), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=WALL_SECONDS, start_new_session=True, check=False)
            except subprocess.TimeoutExpired:
                return CompileResult(ok=False, ms=int((time.monotonic() - started) * 1000),
                                     errors=[TexError(None, "Compiling took too long. Check for an endless loop.")])
            try:
                with open(os.path.join(job, "main.log"), encoding="latin-1") as f:
                    log = f.read()
            except OSError:
                log = ""
            if "Rerun to get" not in log and "Label(s) may have changed" not in log:
                break
        pdf_path = os.path.join(job, "main.pdf")
        errors = [x for x in (_friendly(e) for e in parse_errors(log)) if x.message]

        tail = "\n".join(log.splitlines()[-60:])
        if not os.path.exists(pdf_path) or errors:
            return CompileResult(ok=False, errors=errors or [TexError(None, "No PDF was produced.")], log_tail=tail,
                                 ms=int((time.monotonic() - started) * 1000))
        with open(pdf_path, "rb") as f:
            pdf = f.read()
        pages: list[bytes] = []
        pdftoppm = shutil.which("pdftoppm", path="/usr/local/bin:/usr/bin:/bin")
        if pdftoppm and previews:
            try:
                subprocess.run(_limited([pdftoppm, "-r", str(PREVIEW_DPI), "-png", "-l", str(MAX_PREVIEW_PAGES), "main.pdf",
                                         "page"]),
                               cwd=job, env=_env(job), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=20, start_new_session=True, check=False)
                for name in sorted(n for n in os.listdir(job) if n.startswith("page") and n.endswith(".png")):
                    with open(os.path.join(job, name), "rb") as f:
                        pages.append(f.read())
            except subprocess.TimeoutExpired:
                pages = []
        m = re.search(r"Output written on main\.pdf \((\d+) pages?", log)
        count = int(m.group(1)) if m else len(pages)
        return CompileResult(ok=True, pdf=pdf, pages=pages, log_tail=tail, page_count=count,
                             overfull="Overfull \\vbox" in log,
                             ms=int((time.monotonic() - started) * 1000))
    finally:
        shutil.rmtree(job, ignore_errors=True)
