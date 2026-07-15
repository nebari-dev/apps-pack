# Deployment image for the Nebari Apps Pack: port 8080, non-root.
# Keep dependencies in sync with pixi.toml.
FROM python:3.12-slim

RUN pip install --no-cache-dir streamlit>=1.38 pandas>=2.2 && \
    useradd --uid 65532 --user-group --no-create-home app

WORKDIR /app
COPY app.py .

USER 65532:65532
EXPOSE 8080

# The platform injects STREAMLIT_SERVER_PORT=8080/ADDRESS=0.0.0.0/HEADLESS=true;
# the flags below make the image behave the same when run standalone.
CMD ["streamlit", "run", "app.py", "--server.port=8080", "--server.address=0.0.0.0", "--server.headless=true"]
