# Deployment image for the Nebari Apps Pack: port 8080, non-root.
# Keep dependencies in sync with pixi.toml.
FROM python:3.12-slim

RUN pip install --no-cache-dir "fastapi>=0.115" "uvicorn>=0.32" && \
    useradd --uid 65532 --user-group --no-create-home app

WORKDIR /app
COPY app.py .

USER 65532:65532
EXPOSE 8080

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
