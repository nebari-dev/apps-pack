package controller

import (
	"strings"
	"testing"
)

func TestParseImageRef(t *testing.T) {
	digest := "sha256:" + strings.Repeat("a", 64)
	for raw, want := range map[string]string{
		"nginx:1.27":                           "docker.io/library/nginx:1.27",
		"bitnami/nginx:1.27":                   "docker.io/bitnami/nginx:1.27",
		"docker.io/nginx:1":                    "docker.io/library/nginx:1",
		"index.docker.io/library/nginx:1":      "docker.io/library/nginx:1",
		"registry-1.docker.io/org/app:v2":      "docker.io/org/app:v2",
		"GHCR.io/org/app:1.2.3":                "ghcr.io/org/app:1.2.3",
		"ghcr.io/org/team/app@" + digest:       "ghcr.io/org/team/app@" + digest,
		"ghcr.io/org/app:1.0@" + digest:        "ghcr.io/org/app:1.0@" + digest,
		"localhost:5000/app:dev":               "localhost:5000/app:dev",
		"registry.example.com:5000/a/b:latest": "registry.example.com:5000/a/b:latest",
	} {
		ref, err := parseImageRef(raw)
		if err != nil {
			t.Errorf("%s: %v", raw, err)
			continue
		}
		if ref.String() != want {
			t.Errorf("%s: normalized to %s, want %s", raw, ref.String(), want)
		}
	}
	for _, raw := range []string{
		"",
		" nginx:1",
		"nginx",                             // no tag or digest
		"ghcr.io/org/app",                   // no tag or digest
		"localhost:5000/app",                // the port is not a tag
		"ghcr.io/Org/app:1",                 // uppercase repository
		"ghcr.io/org/app:-bad",              // tag starts with '-'
		"ghcr.io/org/app@sha256:abc",        // short digest
		"ghcr.io/org/app@md5:" + digest[7:], // other algorithms
		"ghcr.io/org//app:1",
		"ghcr.io/org/app:1;rm -rf /",
		"https://ghcr.io/org/app:1",
		"-ghcr.io/org/app:1",
	} {
		if ref, err := parseImageRef(raw); err == nil {
			t.Errorf("%q: accepted as %s", raw, ref)
		}
	}
}

func TestRegistryAllowlistMatching(t *testing.T) {
	allow, err := ParseRegistryAllowlist([]string{"ghcr.io/org", " Docker.io/library/ ", "registry.example.com:5000", "quay.io"})
	if err != nil {
		t.Fatal(err)
	}
	if want := "ghcr.io/org,docker.io/library,registry.example.com:5000,quay.io"; strings.Join(allow, ",") != want {
		t.Fatalf("normalized allowlist = %v, want %s", allow, want)
	}
	for raw, ok := range map[string]bool{
		"ghcr.io/org/app:1":                true,
		"ghcr.io/org/team/app:1":           true,
		"ghcr.io/org:1":                    true, // the prefix is itself a repository
		"ghcr.io/org-evil/app:1":           false,
		"ghcr.io/organization/app:1":       false,
		"ghcr.io/other/app:1":              false,
		"ghcr.io.evil.com/org/app:1":       false,
		"evil.com/ghcr.io/org/app:1":       false,
		"nginx:1.27":                       true, // docker.io/library/nginx
		"index.docker.io/library/redis:7":  true,
		"bitnami/nginx:1":                  false, // docker.io/bitnami, not library
		"docker.io/libraryx/nginx:1":       false,
		"registry.example.com:5000/x/y:1":  true,
		"registry.example.com/x/y:1":       false, // the port is part of the host
		"registry.example.com:50001/x/y:1": false,
		"quay.io/anyone/app:1":             true,
		"quay.io.example.net/anyone/app:1": false,
		"sub.quay.io/anyone/app:1":         false,
	} {
		ref, err := parseImageRef(raw)
		if err != nil {
			t.Errorf("%s: %v", raw, err)
			continue
		}
		if got := registryAllowed(ref, allow); got != ok {
			t.Errorf("%s (%s): allowed = %v, want %v", raw, ref.Repository(), got, ok)
		}
	}
}

func TestParseRegistryAllowlistRejectsBadEntries(t *testing.T) {
	for _, entry := range []string{"library", "org/app", "ghcr.io/*", "ghcr.io/org/app:1", "ghcr.io/Org", "https://ghcr.io"} {
		if _, err := ParseRegistryAllowlist([]string{entry}); err == nil {
			t.Errorf("%q accepted", entry)
		}
	}
	if got, err := ParseRegistryAllowlist([]string{"", " "}); err != nil || len(got) != 0 {
		t.Errorf("blank entries: %v, %v", got, err)
	}
}

func TestCheckImageDisabledByDefault(t *testing.T) {
	_, err := OperatorConfig{}.checkImage("ghcr.io/org/app:1")
	if !isImageNotAllowed(err) || !strings.Contains(err.Error(), "disabled") {
		t.Errorf("empty allowlist: %v", err)
	}
}
