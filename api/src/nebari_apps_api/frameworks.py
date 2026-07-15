"""Read-only mirror of the operator's framework table.

The operator (operator/internal/controller/frameworks.go) is authoritative;
this mirror exists so the UI can render choices and validate before a CR is
ever written. Keep the two in sync.
"""

from .models import FrameworkInfo

STATIC_SOURCES = ["inline", "git", "pvc"]
PYTHON_SOURCES = ["ociEnv", "image"]
PYTHON_IMPLEMENTED = ["image"]  # ociEnv (Nebi pixi envs) lands in Phase 2
ALL_SOURCES = ["ociEnv", "image", "git", "inline", "pvc"]

FRAMEWORKS: list[FrameworkInfo] = [
    FrameworkInfo(
        name="static",
        displayName="Static site",
        sourceTypes=STATIC_SOURCES,
        implementedSources=STATIC_SOURCES,
        description="HTML/CSS/JS served by nginx. Upload files, point at git, or mount a PVC.",
    ),
    FrameworkInfo(
        name="streamlit",
        displayName="Streamlit",
        sourceTypes=PYTHON_SOURCES,
        implementedSources=PYTHON_IMPLEMENTED,
        description="Streamlit data app from a prebuilt image (pixi environments coming soon).",
    ),
    FrameworkInfo(
        name="panel",
        displayName="Panel",
        sourceTypes=PYTHON_SOURCES,
        implementedSources=PYTHON_IMPLEMENTED,
        description="HoloViz Panel app from a prebuilt image.",
    ),
    FrameworkInfo(
        name="gradio",
        displayName="Gradio",
        sourceTypes=PYTHON_SOURCES,
        implementedSources=PYTHON_IMPLEMENTED,
        description="Gradio interface from a prebuilt image.",
    ),
    FrameworkInfo(
        name="dash",
        displayName="Dash",
        sourceTypes=PYTHON_SOURCES,
        implementedSources=PYTHON_IMPLEMENTED,
        description="Plotly Dash app from a prebuilt image.",
    ),
    FrameworkInfo(
        name="voila",
        displayName="Voilà",
        sourceTypes=PYTHON_SOURCES,
        implementedSources=PYTHON_IMPLEMENTED,
        description="Voilà notebook app from a prebuilt image.",
    ),
    FrameworkInfo(
        name="fastapi",
        displayName="FastAPI",
        sourceTypes=PYTHON_SOURCES,
        implementedSources=PYTHON_IMPLEMENTED,
        description="FastAPI service from a prebuilt image.",
    ),
    FrameworkInfo(
        name="custom",
        displayName="Custom",
        sourceTypes=ALL_SOURCES,
        implementedSources=PYTHON_IMPLEMENTED,
        description="Any container listening on port 8080; requires an explicit command.",
    ),
]

FRAMEWORKS_BY_NAME = {f.name: f for f in FRAMEWORKS}
