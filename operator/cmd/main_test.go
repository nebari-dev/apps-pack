package main

import "testing"

func TestMetricsOptionsSecureByDefault(t *testing.T) {
	opts := metricsOptions(":8443", true)
	if !opts.SecureServing || opts.FilterProvider == nil {
		t.Fatalf("secure metrics must serve TLS behind the authn/authz filter, got %+v", opts)
	}
	if opts := metricsOptions(":8080", false); opts.SecureServing || opts.FilterProvider != nil {
		t.Fatalf("--metrics-secure=false must serve plain HTTP without the filter, got %+v", opts)
	}
}
