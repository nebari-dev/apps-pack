"""APP_DISPLAY_NAME - a FastAPI service for the Nebari Apps Pack.

Local dev: pixi run dev
Serves on 0.0.0.0:8080 in the cluster (see Dockerfile CMD).
"""

from fastapi import FastAPI

app = FastAPI(title="APP_DISPLAY_NAME")


@app.get("/")
def index() -> dict[str, str]:
    return {"app": "APP_DISPLAY_NAME", "status": "ok"}


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}
