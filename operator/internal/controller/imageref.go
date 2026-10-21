package controller

import (
	"fmt"
	"regexp"
	"strings"
)

// Image references and the registry allowlist. apps-api applies the same
// rules (nebari_apps_api/images.py); keep the two in step.
//
// A reference is parsed with the Docker grammar and normalized the way the
// container runtime would: a first path component without a '.' or ':' (and
// not "localhost") is a Docker Hub repository, so "nginx:1.27" becomes
// "docker.io/library/nginx:1.27", and index.docker.io and
// registry-1.docker.io are written docker.io. The pod gets the normalized
// reference, so what was checked is exactly what the kubelet pulls.
//
// An allowlist entry is "<registry host>[:port][/<repository prefix>]". An
// image matches when its "<host>/<repository>" equals the entry or starts
// with the entry followed by "/": hosts compare whole (so ghcr.io does not
// admit ghcr.io.evil.com, and a port is part of the host), and a prefix
// matches whole path components (ghcr.io/org admits ghcr.io/org/app and
// ghcr.io/org/team/app, never ghcr.io/org-evil/app). There are no wildcards.

const dockerHub = "docker.io"

var (
	// One path component (lowercase; separators ., _, __, -).
	pathComponent = `[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*`
	// A registry host: DNS labels, optional port.
	hostPart = `(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?))*(?::[0-9]{1,5})?`
	pathRE   = regexp.MustCompile(`^` + pathComponent + `(?:/` + pathComponent + `)*$`)
	hostRE   = regexp.MustCompile(`^` + hostPart + `$`)
	tagRE    = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$`)
	digestRE = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
	hubAlias = map[string]bool{"docker.io": true, "index.docker.io": true, "registry-1.docker.io": true}
)

// imageRef is a parsed, normalized image reference.
type imageRef struct {
	Host   string // lowercase, with port if any; docker.io for Docker Hub
	Path   string // repository path, library/ added for Docker Hub short names
	Tag    string
	Digest string
}

// Repository is "<host>/<path>", what allowlist entries match against.
func (r imageRef) Repository() string { return r.Host + "/" + r.Path }

// String is the normalized reference the pod runs.
func (r imageRef) String() string {
	s := r.Repository()
	if r.Tag != "" {
		s += ":" + r.Tag
	}
	if r.Digest != "" {
		s += "@" + r.Digest
	}
	return s
}

// looksLikeHost reports whether the first component of a name is a registry
// host rather than a Docker Hub namespace (the Docker rule).
func looksLikeHost(s string) bool {
	return strings.ContainsAny(s, ".:") || s == "localhost"
}

// splitHost splits "<host>/<path>" with Docker Hub defaults applied.
func splitHost(name string) (host, path string, err error) {
	first, rest, found := strings.Cut(name, "/")
	if found && looksLikeHost(first) {
		if !hostRE.MatchString(first) {
			return "", "", fmt.Errorf("invalid registry host %q", first)
		}
		host, path = strings.ToLower(first), rest
	} else {
		host, path = dockerHub, name
	}
	if hubAlias[host] {
		host = dockerHub
	}
	return host, path, nil
}

// parseImageRef parses and normalizes a reference. It requires a tag or a
// digest: an implicit :latest would change under the App without an edit.
func parseImageRef(raw string) (imageRef, error) {
	if raw != strings.TrimSpace(raw) || raw == "" {
		return imageRef{}, fmt.Errorf("must be a non-empty image reference without spaces")
	}
	var ref imageRef
	name := raw
	if n, d, found := strings.Cut(name, "@"); found {
		if !digestRE.MatchString(d) {
			return imageRef{}, fmt.Errorf("digest %q must be sha256:<64 lowercase hex>", d)
		}
		name, ref.Digest = n, d
	}
	// A tag follows the last ':' after the last '/' (an earlier ':' is a port).
	if i := strings.LastIndex(name, ":"); i > strings.LastIndex(name, "/") {
		ref.Tag = name[i+1:]
		name = name[:i]
		if !tagRE.MatchString(ref.Tag) {
			return imageRef{}, fmt.Errorf("invalid tag %q", ref.Tag)
		}
	}
	host, path, err := splitHost(name)
	if err != nil {
		return imageRef{}, err
	}
	if !pathRE.MatchString(path) {
		return imageRef{}, fmt.Errorf("invalid repository %q (lowercase letters, digits and . _ - separators)", path)
	}
	if host == dockerHub && !strings.Contains(path, "/") {
		path = "library/" + path
	}
	ref.Host, ref.Path = host, path
	if ref.Tag == "" && ref.Digest == "" {
		return imageRef{}, fmt.Errorf("needs a tag (:1.2.3) or a digest (@sha256:...)")
	}
	if len(ref.String()) > 512 {
		return imageRef{}, fmt.Errorf("is longer than 512 characters")
	}
	return ref, nil
}

// ParseRegistryAllowlist normalizes allowlist entries
// ("<host>[:port][/<repository prefix>]"). An entry must name its registry
// host explicitly (docker.io for Docker Hub) and may not carry a tag,
// digest or wildcard.
func ParseRegistryAllowlist(entries []string) ([]string, error) {
	var out []string
	for _, raw := range entries {
		e := strings.TrimSuffix(strings.TrimSpace(raw), "/")
		if e == "" {
			continue
		}
		first, rest, _ := strings.Cut(e, "/")
		if !looksLikeHost(first) || !hostRE.MatchString(first) {
			return nil, fmt.Errorf("image registry %q must start with a registry host, e.g. ghcr.io or docker.io", raw)
		}
		host := strings.ToLower(first)
		if hubAlias[host] {
			host = dockerHub
		}
		if rest != "" && !pathRE.MatchString(rest) {
			return nil, fmt.Errorf("image registry %q: invalid repository prefix %q (no tags, digests or wildcards)", raw, rest)
		}
		norm := host
		if rest != "" {
			norm += "/" + rest
		}
		out = append(out, norm)
	}
	return out, nil
}

// registryAllowed reports whether a normalized reference matches a
// normalized allowlist entry (whole host, whole path components).
func registryAllowed(ref imageRef, allowlist []string) bool {
	repo := ref.Repository()
	for _, e := range allowlist {
		if repo == e || strings.HasPrefix(repo, e+"/") {
			return true
		}
	}
	return false
}

// checkImage parses an image reference and checks it against the allowlist,
// returning the normalized reference the pod runs.
func (c OperatorConfig) checkImage(raw string) (imageRef, error) {
	if len(c.ImageRegistries) == 0 {
		return imageRef{}, errImageNotAllowed{"image sources are disabled on this cluster: the operator has no " +
			"--image-registries allowlist (chart apps.image.allowedRegistries)"}
	}
	ref, err := parseImageRef(raw)
	if err != nil {
		return imageRef{}, fmt.Errorf("source.image.reference %q: %w", raw, err)
	}
	if !registryAllowed(ref, c.ImageRegistries) {
		return imageRef{}, errImageNotAllowed{fmt.Sprintf(
			"source.image.reference %q: %s is not in the allowed image registries (%s)",
			raw, ref.Repository(), strings.Join(c.ImageRegistries, ", "))}
	}
	return ref, nil
}

// errImageNotAllowed marks a validation error for an image outside the
// allowlist (or with the feature off): the App's workload is scaled to zero.
type errImageNotAllowed struct{ msg string }

func (e errImageNotAllowed) Error() string { return e.msg }
