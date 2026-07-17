"""APP_DISPLAY_NAME - a minimal FastAPI app served by the Nebari Apps Pack."""

from fastapi import FastAPI

app = FastAPI()


@app.get("/")
def index() -> dict[str, str]:
    return {"message": "Hello from APP_DISPLAY_NAME"}
