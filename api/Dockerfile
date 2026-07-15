FROM python:3.12-slim AS builder

WORKDIR /build
COPY pyproject.toml ./
COPY src/ src/
RUN pip install --no-cache-dir --prefix=/install .

FROM python:3.12-slim
RUN useradd --uid 65532 --user-group --no-create-home app
COPY --from=builder /install /usr/local

USER 65532:65532
EXPOSE 8080

CMD ["uvicorn", "nebari_apps_api.main:app", "--host", "0.0.0.0", "--port", "8080"]
