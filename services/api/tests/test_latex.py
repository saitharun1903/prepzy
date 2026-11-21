"""Resume builder: safe LaTeX compilation and saved projects."""

import base64
import shutil

import pytest

from elevate.services.latex import compile_tex

needs_tex = pytest.mark.skipif(not shutil.which("pdflatex"), reason="pdflatex not installed")

DOC = r"""\documentclass[10pt]{article}
\usepackage[margin=0.6in]{geometry}
\usepackage{titlesec,enumitem,xcolor}
\usepackage[hidelinks]{hyperref}
\begin{document}
\section*{Asha Example}
\begin{itemize}\item Built \textbf{REST APIs} in Java.\end{itemize}
\end{document}
"""


@needs_tex
def test_compiles_a_resume_to_pdf_and_previews():
    r = compile_tex(DOC)
    assert r.ok and r.pdf and r.pdf.startswith(b"%PDF") and r.pages and r.page_count == 1


@needs_tex
def test_reports_line_numbered_errors():
    r = compile_tex("\\documentclass{article}\n\\begin{document}\nHi \\textbff{x}\n\\end{document}\n")
    assert not r.ok and r.errors[0].line == 3 and "Unknown command" in r.errors[0].message


@needs_tex
@pytest.mark.parametrize("body", [r"\input{/etc/passwd}", r"\input{/proc/self/environ}", r"\input{../../etc/hostname}",
                                  r"\newread\r\openin\r=/etc/passwd \read\r to\x \x"])
def test_cannot_read_files_outside_the_document(body, monkeypatch):
    monkeypatch.setenv("SECRET_FOR_TEST", "s3cr3t-value")
    r = compile_tex(r"\documentclass{article}\begin{document}" + body + r" done\end{document}")
    assert not r.ok
    assert not (r.pdf and (b"root:" in r.pdf or b"s3cr3t" in r.pdf))


@needs_tex
def test_shell_escape_and_writes_outside_are_blocked(tmp_path):
    target = tmp_path / "pwned"
    r = compile_tex(r"\documentclass{article}\begin{document}\immediate\write18{touch " + str(target) + r"} ok\end{document}")
    assert not target.exists()
    r = compile_tex(r"\documentclass{article}\begin{document}\newwrite\w\immediate\openout\w=" + str(target)
                    + r"\immediate\write\w{x}\immediate\closeout\w\end{document}")
    assert not target.exists() and not r.ok


def test_rejects_non_documents_and_huge_input():
    assert not compile_tex("hello").ok
    assert not compile_tex("\\documentclass{article}" + "x" * 200_000).ok


@needs_tex
def test_compile_endpoint_and_saved_projects(client, user):
    r = client.post("/api/v1/latex/compile", headers=user["h"], json={"source": DOC})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] and base64.b64decode(body["pdf"]).startswith(b"%PDF") and body["pages"]

    created = client.post("/api/v1/latex/docs", headers=user["h"],
                          json={"title": "My resume", "template": "classic", "source": DOC}).json()
    doc_id = created["id"]
    lst = client.get("/api/v1/latex/docs", headers=user["h"]).json()["items"]
    assert any(d["id"] == doc_id for d in lst) and "source" not in lst[0]
    upd = client.patch(f"/api/v1/latex/docs/{doc_id}", headers=user["h"],
                       json={"source": DOC.replace("Asha", "Ravi"), "version": created["version"]})
    assert upd.status_code == 200 and upd.json()["version"] == created["version"] + 1
    stale = client.patch(f"/api/v1/latex/docs/{doc_id}", headers=user["h"], json={"source": DOC, "version": created["version"]})
    assert stale.status_code == 409
    assert "Ravi" in client.get(f"/api/v1/latex/docs/{doc_id}", headers=user["h"]).json()["source"]
    # structured content + template switch
    data = {"name": "Asha", "contact": {}, "skills": [], "education": [], "experience": [], "projects": [], "achievements": []}
    sw = client.patch(f"/api/v1/latex/docs/{doc_id}", headers=user["h"], json={"template": "tech", "data": data})
    assert sw.status_code == 200 and sw.json()["has_data"]
    got = client.get(f"/api/v1/latex/docs/{doc_id}", headers=user["h"]).json()
    assert got["template"] == "tech" and got["data"]["name"] == "Asha"
    big = client.patch(f"/api/v1/latex/docs/{doc_id}", headers=user["h"], json={"data": {"x": "y" * 70_000}})
    assert big.status_code == 422
    cleared = client.patch(f"/api/v1/latex/docs/{doc_id}", headers=user["h"], json={"clear_data": True})
    assert cleared.json()["has_data"] is False
    assert client.delete(f"/api/v1/latex/docs/{doc_id}", headers=user["h"]).status_code == 204
    assert client.get(f"/api/v1/latex/docs/{doc_id}", headers=user["h"]).status_code == 404


def test_docs_are_private_to_their_owner(client, user):
    import secrets
    other = client.post("/api/v1/auth/register", json={"email": f"o-{secrets.token_hex(5)}@example.test",
                                                       "password": "Other-pass-123456"})
    assert other.status_code == 201
    h2 = {"Authorization": f"Bearer {other.json()['access_token']}"}
    d = client.post("/api/v1/latex/docs", headers=user["h"], json={"title": "Mine", "source": DOC}).json()
    assert client.get(f"/api/v1/latex/docs/{d['id']}", headers=h2).status_code == 404
    assert client.patch(f"/api/v1/latex/docs/{d['id']}", headers=h2, json={"title": "x"}).status_code == 404
    assert client.delete(f"/api/v1/latex/docs/{d['id']}", headers=h2).status_code == 404
