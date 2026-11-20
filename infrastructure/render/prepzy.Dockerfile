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
COPY --from=web /usr/local/bin/node /usr/local/bin/node
RUN useradd --create-home --uid 10001 prepzy
WORKDIR /app
COPY --from=api --chown=prepzy:prepzy /app/services/api /app/services/api
COPY --chown=prepzy:prepzy database/reference-data /app/database/reference-data
COPY --chown=prepzy:prepzy ai/evaluation/results /app/ai/evaluation/results
COPY --chown=prepzy:prepzy scripts/db_bootstrap.py scripts/start_prepzy.py /app/scripts/
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
USER prepzy
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD python -c "import urllib.request,os;urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"3000\")}/health/live',timeout=4)"
CMD ["python", "/app/scripts/start_prepzy.py"]
