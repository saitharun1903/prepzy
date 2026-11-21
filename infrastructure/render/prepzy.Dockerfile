# Prepzy combined image: web app (Next.js) + API (FastAPI, embedded worker) in ONE container,
# for free hosting where only one always-on instance fits the monthly hours.
#   Build from the repo root:  docker build -f infrastructure/render/prepzy.Dockerfile -t prepzy .
#   Start:                     python /app/scripts/start_prepzy.py   (default CMD)

# ---- API dependencies
FROM python:3.13-slim AS api
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
COPY --from=ghcr.io/astral-sh/uv:0.12.7 /uv /usr/local/bin/uv
WORKDIR /app/services/api
COPY services/api/pyproject.toml services/api/uv.lock services/api/.python-version ./
RUN uv sync --frozen --no-dev --no-install-project
COPY services/api/ ./
RUN uv sync --frozen --no-dev

# ---- web build
FROM node:24-slim AS web
WORKDIR /app/web
ENV NEXT_TELEMETRY_DISABLED=1 \
    ELEVATE_COMBINED=1 \
    NEXT_PUBLIC_ELEVATE_HOSTED=1 \
    NEXT_PUBLIC_ELEVATE_AI_PROVIDER=Groq \
    NEXT_PUBLIC_ELEVATE_EXTENSION_ID=bjhbbpnbmichlooillmiaeofcioofkni
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/extension/package.json apps/extension/package.json
COPY packages/api-client/package.json packages/api-client/package.json
RUN npm ci --no-audit --no-fund --include=dev
COPY apps/web apps/web
COPY packages/api-client packages/api-client
RUN npm run build -w apps/web

# ---- runtime
FROM python:3.13-slim
# LaTeX for the resume builder: TeX Live (pdflatex) + the packages resumes commonly use, TeX Gyre fonts, Font
# Awesome 5 from CTAN (not packaged separately in Debian), and poppler for page previews. prlimit caps compiles.
RUN set -e; apt-get update \
 && apt-get install -y --no-install-recommends texlive-latex-base texlive-latex-recommended texlive-latex-extra \
      texlive-fonts-recommended lmodern tex-gyre poppler-utils util-linux curl unzip ca-certificates \
 && for u in https://mirrors.ctan.org/fonts/fontawesome5.zip https://mirrors.mit.edu/CTAN/fonts/fontawesome5.zip \
      https://ftp.math.utah.edu/pub/ctan/tex-archive/fonts/fontawesome5.zip https://mirror.ox.ac.uk/sites/ctan.org/fonts/fontawesome5.zip; do \
      curl -fsSL --retry 3 --retry-delay 3 -o /tmp/fa5.zip "$u" && unzip -tq /tmp/fa5.zip >/dev/null && break; rm -f /tmp/fa5.zip; done \
 && test -s /tmp/fa5.zip \
 && mkdir -p /tmp/fa5 && unzip -q /tmp/fa5.zip -d /tmp/fa5 \
 && T=/usr/local/share/texmf \
 && place() { mkdir -p "$T/$2"; find /tmp/fa5 -type f -name "$1" -not -path "*/doc/*" -exec cp {} "$T/$2/" \; ; } \
 && place '*.sty' tex/latex/fontawesome5 && place '*.fd' tex/latex/fontawesome5 && place '*.def' tex/latex/fontawesome5 \
 && place '*.pfb' fonts/type1/public/fontawesome5 && place '*.tfm' fonts/tfm/public/fontawesome5 \
 && place '*.enc' fonts/enc/dvips/fontawesome5 && place '*.map' fonts/map/dvips/fontawesome5 \
 && rm -rf /tmp/fa5 /tmp/fa5.zip \
 && mktexlsr >/dev/null \
 && kpsewhich fontawesome5.sty fontawesome5.map \
 && updmap-sys --enable Map=fontawesome5.map >/dev/null \
 && apt-get purge -y curl unzip && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* /usr/share/texlive/texmf-dist/doc
COPY --from=web /usr/local/bin/node /usr/local/bin/node
RUN useradd --create-home --uid 10001 prepzy \
 && useradd --no-create-home --uid 10002 --shell /usr/sbin/nologin texrunner
WORKDIR /app
COPY --from=api --chown=prepzy:prepzy /app/services/api /app/services/api
COPY --chown=prepzy:prepzy database/reference-data /app/database/reference-data
COPY --chown=prepzy:prepzy ai/evaluation/results /app/ai/evaluation/results
COPY --chown=prepzy:prepzy scripts/db_bootstrap.py scripts/start_prepzy.py scripts/latex_runner.py /app/scripts/
# Build-time smoke test: every resume template must compile with the installed TeX (fails the build otherwise).
COPY infrastructure/render/latex-smoke /tmp/latex-smoke
RUN cd /tmp/latex-smoke && for f in *.tex; do t="${f%.tex}"; \
      pdflatex -no-shell-escape -interaction=nonstopmode -halt-on-error "$f" >/dev/null \
      || { echo "LaTeX template $t failed"; tail -30 "$t.log"; exit 1; }; \
      if grep -q "Font shape .* undefined" "$t.log"; then echo "Template $t is missing a font"; grep "Font shape" "$t.log"; exit 1; fi; \
    done \
 && cd / && rm -rf /tmp/latex-smoke
COPY --from=web --chown=prepzy:prepzy /app/web/node_modules /app/web/node_modules
COPY --from=web --chown=prepzy:prepzy /app/web/package.json /app/web/package.json
COPY --from=web --chown=prepzy:prepzy /app/web/packages /app/web/packages
COPY --from=web --chown=prepzy:prepzy /app/web/apps/web /app/web/apps/web
ENV PATH="/app/services/api/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    ELEVATE_ENV=production \
    ELEVATE_EMBEDDED_WORKER=true \
    ELEVATE_DATA_DIR=/tmp/elevate-data
# The supervisor starts as root only to launch each process as its own user (see scripts/start_prepzy.py):
# API + web as `prepzy`, the LaTeX compiler as `texrunner` with an empty environment.
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD python -c "import urllib.request,os;urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"3000\")}/health/live',timeout=4)"
CMD ["python", "/app/scripts/start_prepzy.py"]
