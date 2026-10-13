# Elevate API + worker image (same image, different command).
#   API:    default CMD (uvicorn, honours $PORT, trusts the platform proxy for client IPs)
#   Worker: python -m elevate.worker
# Build from the repo root:  docker build -f services/api/Dockerfile -t elevate-api .
FROM python:3.13-slim AS build
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
COPY --from=ghcr.io/astral-sh/uv:0.12.7 /uv /usr/local/bin/uv
WORKDIR /app/services/api
COPY services/api/pyproject.toml services/api/uv.lock services/api/.python-version ./
RUN uv sync --frozen --no-dev --no-install-project
COPY services/api/ ./
RUN uv sync --frozen --no-dev

FROM python:3.13-slim
RUN useradd --create-home --uid 10001 elevate
WORKDIR /app
# Code + reference data the API reads at runtime (taxonomy, evaluation status).
COPY --from=build --chown=elevate:elevate /app/services/api /app/services/api
COPY --chown=elevate:elevate database/reference-data /app/database/reference-data
COPY --chown=elevate:elevate ai/evaluation/results /app/ai/evaluation/results
COPY --chown=elevate:elevate scripts/db_bootstrap.py /app/scripts/db_bootstrap.py
COPY --chown=elevate:elevate scripts/start_api.py /app/scripts/start_api.py
ENV PATH="/app/services/api/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    ELEVATE_ENV=production \
    ELEVATE_DATA_DIR=/tmp/elevate-data
USER elevate
WORKDIR /app/services/api
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD python -c "import urllib.request,os;urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8000\")}/health/live',timeout=4)"
# --proxy-headers: the platform's load balancer terminates TLS and sets X-Forwarded-For; the
# API uses the real client IP for rate limiting. Only the platform proxy can reach this port.
CMD ["sh", "-c", "exec uvicorn elevate.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips='*' --workers ${WEB_CONCURRENCY:-2} --no-server-header"]
