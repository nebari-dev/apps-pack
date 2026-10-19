#!/bin/sh
# Smoke test for ui/nginx.conf: boot an image and assert the security headers
# on the page, a hashed asset, config.json and an error. HSTS and the Keycloak
# origin are set the way the chart sets them on a TLS install.
#   ui/scripts/check-headers.sh <image>
set -eu
IMAGE=$1
NAME=apps-ui-headers-$$
PORT=${PORT:-18095}
docker run -d --rm --name "$NAME" -p "$PORT:8080" \
  -e HSTS="max-age=31536000" -e KEYCLOAK_ORIGIN="https://keycloak.example.ai" \
  "$IMAGE" >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1' EXIT

BASE=http://127.0.0.1:$PORT
for _ in $(seq 1 30); do curl -fs "$BASE/healthz" >/dev/null && break; sleep 1; done

ASSET=$(curl -fs "$BASE/" | grep -oE '/assets/index-[^"]+\.js' | head -1)
fail=0
for path in / "$ASSET" /config.json /does-not-exist.js; do
  headers=$(curl -s -o /dev/null -D - "$BASE$path" | tr -d '\r')
  for want in \
    "Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-" \
    "connect-src 'self' https://keycloak.example.ai;" \
    "frame-ancestors 'none'" \
    "X-Frame-Options: DENY" \
    "X-Content-Type-Options: nosniff" \
    "Referrer-Policy: strict-origin-when-cross-origin" \
    "Permissions-Policy: camera=()" \
    "Strict-Transport-Security: max-age=31536000"; do
    if ! printf '%s\n' "$headers" | grep -qiF -- "$want"; then
      echo "FAIL $path: missing '$want'"; fail=1
    fi
  done
done
# Per-location headers still apply alongside the security set.
curl -s -o /dev/null -D - "$BASE$ASSET" | grep -qi "Cache-Control: public, immutable" || { echo "FAIL $ASSET: not immutable"; fail=1; }
curl -s -o /dev/null -D - "$BASE/" | grep -qi "Cache-Control: no-store" || { echo "FAIL /: index.html cacheable"; fail=1; }
[ $fail -eq 0 ] && echo "ok: security headers on /, $ASSET, /config.json and 404s"
exit $fail
