FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY ./ ./
RUN npm run build

FROM nginx:1.27-alpine

# envsubst (gettext) renders ${API_URL} into the config at startup; jq powers
# the entrypoint's optional BRANDING_* overlay (standalone runs only).
RUN apk add --no-cache gettext jq && \
    rm -rf /usr/share/nginx/html/* && \
    mkdir -p /tmp/nginx /var/cache/nginx && \
    chown -R 1000:1000 /tmp/nginx /var/cache/nginx /var/log/nginx /usr/share/nginx/html

# Includes public/config.json - the placeholder branding config, overridden
# in-cluster by the Helm-rendered ConfigMap mounted over it.
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /tmp/nginx/nginx.conf.template

# Applies BRANDING_* env-var overrides to config.json at startup (rebranding
# outside Kubernetes). A no-op unless one of those vars is set, so the read-only
# ConfigMap mount used in-cluster is left untouched.
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/apply-branding.sh

ENV API_URL=http://localhost:8000
ENV MCP_URL=http://localhost:8001

EXPOSE 8080
USER 1000

CMD ["/bin/sh", "-c", \
  "/usr/local/bin/apply-branding.sh; envsubst '${API_URL} ${MCP_URL}' < /tmp/nginx/nginx.conf.template > /tmp/nginx/nginx.conf && nginx -c /tmp/nginx/nginx.conf -g 'daemon off;'"]
