# The builder runs natively and cross-compiles (GOARCH below), instead of
# running the whole Go toolchain under emulation for non-native platforms.
# Go version matches the toolchain line in go.mod (CI checks they agree).
FROM --platform=$BUILDPLATFORM golang:1.27.3@sha256:2920bb124f1a2e12a1d39f0cab756ae0068441ee1da7655dec7f5e374944095b AS builder
ARG TARGETOS=linux
ARG TARGETARCH

WORKDIR /workspace
COPY go.mod go.sum ./
RUN go mod download

COPY main.go ./
COPY internal/ internal/

RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o apps-proxy .

FROM gcr.io/distroless/static:nonroot@sha256:25ac8f0c3b2334a9eb05452266bd4697864a8c8ef0ef71e5e6480d7f92868329
WORKDIR /
COPY --from=builder /workspace/apps-proxy .
USER 65532:65532

EXPOSE 8080 8082
ENTRYPOINT ["/apps-proxy"]
