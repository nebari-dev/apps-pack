# The builder runs natively and cross-compiles (GOARCH below), instead of
# running the whole Go toolchain under emulation for non-native platforms.
# Go version matches the toolchain line in go.mod (CI checks they agree).
FROM --platform=$BUILDPLATFORM golang:1.27.3@sha256:f24164268fc1e741bbdc0066dbadcf1c8426c5a8489f0729c02c3905a53032fd AS builder
ARG TARGETOS=linux
ARG TARGETARCH

WORKDIR /workspace
COPY go.mod go.sum ./
RUN go mod download

COPY main.go ./
COPY internal/ internal/

RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o apps-proxy .

FROM gcr.io/distroless/static:nonroot@sha256:d62067879de890a1def9da0e7766b7d20810a5e5555cef8506b752437d7a3e88
WORKDIR /
COPY --from=builder /workspace/apps-proxy .
USER 65532:65532

EXPOSE 8080 8082
ENTRYPOINT ["/apps-proxy"]
