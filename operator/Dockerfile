# The builder runs natively and cross-compiles (GOARCH below), instead of
# running the whole Go toolchain under emulation for non-native platforms.
FROM --platform=$BUILDPLATFORM golang:1.27 AS builder
ARG TARGETOS=linux
ARG TARGETARCH

WORKDIR /workspace
COPY go.mod go.sum ./
RUN go mod download

COPY cmd/ cmd/
COPY api/ api/
COPY internal/ internal/

RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -a -o apps-operator ./cmd

FROM gcr.io/distroless/static:nonroot
WORKDIR /
COPY --from=builder /workspace/apps-operator .
USER 65532:65532

ENTRYPOINT ["/apps-operator"]
