FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY ./ ./
RUN npm run build

FROM nginx:1.27-alpine

# envsubst (gettext) renders ${API_URL} into the config at startup.
RUN apk add --no-cache gettext && \
    rm -rf /usr/share/nginx/html/* && \
    mkdir -p /tmp/nginx /var/cache/nginx && \
    chown -R 1000:1000 /tmp/nginx /var/cache/nginx /var/log/nginx /usr/share/nginx/html

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /tmp/nginx/nginx.conf.template

ENV API_URL=http://localhost:8000
ENV MCP_URL=http://localhost:8001

EXPOSE 8080
USER 1000

CMD ["/bin/sh", "-c", \
  "envsubst '${API_URL} ${MCP_URL}' < /tmp/nginx/nginx.conf.template > /tmp/nginx/nginx.conf && nginx -c /tmp/nginx/nginx.conf -g 'daemon off;'"]
