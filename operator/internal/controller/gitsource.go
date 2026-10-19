package controller

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

// validateGitURL accepts only https URLs to a public-looking host with no
// embedded credentials. It keeps the git-clone init container from being
// pointed at file:// paths, plain http, or cluster-internal services (SSRF),
// and keeps tokens out of the App CR, which every API caller can read.
// The apps-api applies the same rules (models.GitSource).
func validateGitURL(raw string) error {
	if strings.HasPrefix(raw, "-") {
		return fmt.Errorf("must not start with '-'")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid URL: %v", err)
	}
	if u.Scheme != "https" {
		return fmt.Errorf("only https:// URLs are allowed, got %q", u.Scheme+"://")
	}
	if u.User != nil {
		return fmt.Errorf("must not contain credentials (user:token@); use a public repository")
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return fmt.Errorf("missing host")
	}
	if internalHost(host) {
		return fmt.Errorf("host %q is not allowed: cluster-internal and private addresses are blocked", host)
	}
	return nil
}

func internalHost(host string) bool {
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
			ip.IsLinkLocalMulticast() || ip.IsUnspecified()
	}
	if host == "localhost" || !strings.Contains(host, ".") {
		return true
	}
	for _, suffix := range []string{".localhost", ".svc", ".cluster.local", ".internal", ".local"} {
		if strings.HasSuffix(host, suffix) {
			return true
		}
	}
	return false
}
