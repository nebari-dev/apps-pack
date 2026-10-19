# Python version comes from api/.python-version (CI checks they agree).
FROM python:3.14-slim@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170 AS builder

# Install exactly what uv.lock pins: no resolution at build time.
COPY --from=ghcr.io/astral-sh/uv:0.10.11 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv

WORKDIR /build
# Dependencies first, so source edits do not invalidate this layer.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src/ src/
RUN uv sync --frozen --no-dev --no-editable

FROM python:3.14-slim@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170
# The app runs from /app/.venv; the base image's pip (and the packages it
# vendors) is never used at runtime, so it is removed rather than shipped.
RUN useradd --uid 65532 --user-group --no-create-home app \
    && python -m pip uninstall --yes --root-user-action=ignore pip
COPY --from=builder /app/.venv /app/.venv
ENV PATH="/app/.venv/bin:$PATH"

USER 65532:65532
EXPOSE 8080

CMD ["uvicorn", "nebari_apps_api.main:app", "--host", "0.0.0.0", "--port", "8080"]
