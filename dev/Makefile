# Local development Makefile for the Nebari Apps Pack
#
# Creates a kind cluster with the full Nebari infrastructure stack
# (Envoy Gateway, cert-manager, Keycloak, nebari-operator), builds the
# apps-operator image, installs the nebari-apps chart, and deploys an
# example App. Mirrors the software-pack-template dev flow.
#
# Host access needs no port-forwarding and no /etc/hosts edits: the kind
# cluster maps host ports 80/443 to fixed NodePorts on the Envoy gateway
# Service (kind-config.yaml + the EnvoyProxy resource below), and a tiny
# local CoreDNS container wildcard-resolves *.$(CLUSTER_DOMAIN) to
# 127.0.0.1, so every app hostname works the moment its route reconciles
# - fully offline, no third-party DNS. `check-dns` (run by `make up`)
# installs the one-time /etc/resolver file that points macOS at the
# container for that domain only.
#
# Prerequisites: docker, kind, helm, kubectl, git
#
# Usage:
#   make up            Everything: cluster + operator + api + ui + example App
#   make up-git        Also deploy the git-sourced example App
#   make redeploy      Rebuild all images and roll the Deployments
#   make down          Delete the kind cluster
#
# The UI ends up at http://apps.nebari.test and launched apps at
# http://<name>.apps.nebari.test (TLS is disabled locally so there
# are no certificate warnings). Auth is disabled locally: the kind
# stack's Keycloak is not reachable from a host browser (in-cluster issuer),
# so keycloak-js logins cannot complete; on a real Nebari cluster leave
# api.auth.enabled=true and set keycloak.url.
#
# The domain is nebari.test rather than nebari.local: macOS routes .local
# through mDNS/Bonjour, which bypasses /etc/resolver; .test is the TLD
# reserved for exactly this (RFC 6761).

CLUSTER_NAME   := nebari-apps-dev
CLUSTER_DOMAIN := nebari.test
DNS_CONTAINER  := nebari-dev-dns
DNS_PORT       := 53535
CHART          := ../charts/nebari-apps
OPERATOR_DIR   := ../operator
API_DIR        := ../api
UI_DIR         := ../ui
EXAMPLES_DIR   := ../examples
CACHE_DIR      := .cache
OPERATOR_REPO  := $(CACHE_DIR)/nebari-operator
OPERATOR_REF   := v0.1.0-alpha.20

IMG            := apps-operator:dev
API_IMG        := apps-api:dev
UI_IMG         := apps-ui:dev
MCP_IMG        := apps-mcp:dev
APP_NAMESPACE  := apps

# CoreDNS config for the local wildcard-DNS container: answer every
# *.$(CLUSTER_DOMAIN) A query with 127.0.0.1 (and AAAA with an empty
# NOERROR, so clients fall back to the A record).
define COREDNS_CONFIG
$(CLUSTER_DOMAIN) {
    template IN A {
        answer "{{ .Name }} 60 IN A 127.0.0.1"
    }
    template IN AAAA {
    }
}
endef
export COREDNS_CONFIG

# EnvoyProxy config pinning the gateway Service to the NodePorts that
# kind-config.yaml maps to host ports 80/443. Attached to the
# GatewayClass after the nebari-operator dev scripts create it.
define ENVOY_NODEPORT_PROXY
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: nebari-gateway-nodeport
  namespace: envoy-gateway-system
spec:
  provider:
    type: Kubernetes
    kubernetes:
      envoyService:
        type: NodePort
        patch:
          type: StrategicMerge
          value:
            spec:
              ports:
              - port: 80
                nodePort: 30080
              - port: 443
                nodePort: 30443
endef
export ENVOY_NODEPORT_PROXY

.PHONY: up up-git redeploy deploy images operator-image api-image ui-image \
	mcp-image cluster dns check-dns down \
	_cluster-create _clone-operator _kind-create _services \
	_gateway-nodeport _keycloak-setup _operator _namespaces

# --------------------------------------------------------------------------
# cluster - create kind cluster with full Nebari infrastructure
# --------------------------------------------------------------------------
cluster:
	@if kind get clusters 2>/dev/null | grep -q "^$(CLUSTER_NAME)$$"; then \
		echo "Cluster '$(CLUSTER_NAME)' already exists, skipping setup"; \
	else \
		$(MAKE) _cluster-create; \
	fi

_cluster-create: _clone-operator _kind-create _services _gateway-nodeport _keycloak-setup _operator _namespaces
	@echo ""
	@echo "=========================================="
	@echo "Cluster setup complete!"
	@echo "=========================================="
	@echo ""
	@echo "Run 'make up' to build the operator and deploy an example App."

_clone-operator:
	@if [ ! -d "$(OPERATOR_REPO)" ]; then \
		echo "Cloning nebari-operator ($(OPERATOR_REF)) into $(OPERATOR_REPO)..."; \
		mkdir -p $(CACHE_DIR); \
		git clone --depth 1 --branch $(OPERATOR_REF) \
			https://github.com/nebari-dev/nebari-operator.git $(OPERATOR_REPO); \
	else \
		echo "nebari-operator already cloned"; \
	fi

_kind-create:
	@echo "Creating kind cluster: $(CLUSTER_NAME)"
	kind create cluster --name $(CLUSTER_NAME) --config kind-config.yaml

# No LoadBalancer provider is installed (the gateway Service becomes
# NodePort in _gateway-nodeport), so the install script's "waiting for
# LoadBalancer address" step is expected to time out with a warning and
# its /etc/hosts step is skipped - both are fine.
_services:
	@echo "Installing foundational services (Envoy Gateway, cert-manager, Keycloak, Gateway, TLS)..."
	CLUSTER_NAME=$(CLUSTER_NAME) $(OPERATOR_REPO)/dev/scripts/services/install.sh

# Switch the gateway Service to the fixed NodePorts mapped by
# kind-config.yaml, making it reachable at http://localhost:80 without
# port-forwarding. Runs after _services because the operator's install
# script creates (and owns) the GatewayClass.
_gateway-nodeport:
	@echo "Pinning the Envoy gateway Service to NodePorts 30080/30443..."
	echo "$$ENVOY_NODEPORT_PROXY" | kubectl apply -f -
	kubectl patch gatewayclass envoy-gateway --type=merge -p \
		'{"spec":{"parametersRef":{"group":"gateway.envoyproxy.io","kind":"EnvoyProxy","name":"nebari-gateway-nodeport","namespace":"envoy-gateway-system"}}}'
	@echo "Waiting for the gateway Service to expose NodePort 30080..."
	@for i in $$(seq 1 30); do \
		NP=$$(kubectl get svc -n envoy-gateway-system \
			-l gateway.envoyproxy.io/owning-gateway-name=nebari-gateway \
			-o jsonpath='{.items[0].spec.ports[?(@.port==80)].nodePort}' 2>/dev/null); \
		if [ "$$NP" = "30080" ]; then \
			echo "Gateway reachable on http://localhost:80"; exit 0; \
		fi; \
		sleep 2; \
	done; \
	echo "ERROR: gateway Service did not switch to NodePort 30080"; exit 1

_keycloak-setup:
	@echo "Setting up Keycloak realm..."
	CLUSTER_NAME=$(CLUSTER_NAME) $(OPERATOR_REPO)/dev/scripts/services/keycloak/setup.sh

_operator:
	@echo "Installing nebari-operator..."
	kubectl apply -f https://github.com/nebari-dev/nebari-operator/releases/download/$(OPERATOR_REF)/install.yaml
	kubectl wait --for=condition=available deployment/nebari-operator-controller-manager \
		-n nebari-operator-system --timeout=120s
	@echo "nebari-operator is running"

_namespaces:
	kubectl create namespace $(APP_NAMESPACE) --dry-run=client -o yaml | kubectl apply -f -
	kubectl label namespace $(APP_NAMESPACE) nebari.dev/managed=true --overwrite

# --------------------------------------------------------------------------
# images - build the operator/api/ui images and load them into kind
# --------------------------------------------------------------------------
operator-image:
	docker build -t $(IMG) $(OPERATOR_DIR)
	kind load docker-image $(IMG) --name $(CLUSTER_NAME)

api-image:
	docker build -t $(API_IMG) $(API_DIR)
	kind load docker-image $(API_IMG) --name $(CLUSTER_NAME)

ui-image:
	docker build -t $(UI_IMG) $(UI_DIR)
	kind load docker-image $(UI_IMG) --name $(CLUSTER_NAME)

mcp-image:
	docker build -t $(MCP_IMG) ../mcp
	kind load docker-image $(MCP_IMG) --name $(CLUSTER_NAME)

images: operator-image api-image ui-image mcp-image

# --------------------------------------------------------------------------
# deploy - install/upgrade the nebari-apps chart with the dev images
# --------------------------------------------------------------------------
deploy:
	kubectl create namespace nebari-apps --dry-run=client -o yaml | kubectl apply -f -
	kubectl label namespace nebari-apps nebari.dev/managed=true --overwrite
	helm upgrade --install nebari-apps $(CHART) \
		--namespace nebari-apps --create-namespace \
		--set clusterDomain=$(CLUSTER_DOMAIN) \
		--set operator.image.repository=apps-operator \
		--set operator.image.tag=dev \
		--set operator.image.pullPolicy=Never \
		--set api.image.repository=apps-api \
		--set api.image.tag=dev \
		--set api.image.pullPolicy=Never \
		--set api.auth.enabled=false \
		--set tls.enabled=false \
		--set ui.image.repository=apps-ui \
		--set ui.image.tag=dev \
		--set ui.image.pullPolicy=Never \
		--set mcp.image.repository=apps-mcp \
		--set mcp.image.tag=dev \
		--set mcp.image.pullPolicy=Never \
		--wait --timeout 3m

# --------------------------------------------------------------------------
# dns - local wildcard DNS: *.$(CLUSTER_DOMAIN) -> 127.0.0.1
#
# A CoreDNS container on 127.0.0.1:$(DNS_PORT) answers every hostname
# under $(CLUSTER_DOMAIN) with 127.0.0.1 - fully offline and immune to
# routers that filter loopback answers (DNS-rebinding protection).
# --restart unless-stopped keeps it alive across reboots; it is
# intentionally left running by `make down` (delete it with
# `docker rm -f $(DNS_CONTAINER)`).
# --------------------------------------------------------------------------
dns:
	@mkdir -p $(CACHE_DIR)/dns
	@printf '%s\n' "$$COREDNS_CONFIG" > $(CACHE_DIR)/dns/Corefile
	@if [ "$$(docker inspect -f '{{.State.Running}}' $(DNS_CONTAINER) 2>/dev/null)" = "true" ]; then \
		echo "DNS container $(DNS_CONTAINER) already running"; \
	else \
		docker rm -f $(DNS_CONTAINER) >/dev/null 2>&1 || true; \
		docker run -d --name $(DNS_CONTAINER) --restart unless-stopped \
			-p 127.0.0.1:$(DNS_PORT):53/udp -p 127.0.0.1:$(DNS_PORT):53/tcp \
			-v $(abspath $(CACHE_DIR)/dns/Corefile):/etc/coredns/Corefile:ro \
			coredns/coredns:1.12.1 -conf /etc/coredns/Corefile >/dev/null; \
		echo "DNS container started: *.$(CLUSTER_DOMAIN) -> 127.0.0.1 on 127.0.0.1:$(DNS_PORT)"; \
	fi

# --------------------------------------------------------------------------
# check-dns - preflight: the host must resolve *.$(CLUSTER_DOMAIN)
#
# macOS needs a one-time /etc/resolver/$(CLUSTER_DOMAIN) file pointing
# the domain at the DNS container - written with sudo, attempted only in
# an interactive shell. Never fails the build: the cluster works either
# way, only host browser access needs the file.
# --------------------------------------------------------------------------
check-dns: dns
	@if (dscacheutil -q host -a name probe.apps.$(CLUSTER_DOMAIN) 2>/dev/null; getent hosts probe.apps.$(CLUSTER_DOMAIN) 2>/dev/null) | grep -q '127\.0\.0\.1'; then \
		echo "DNS preflight OK: *.apps.$(CLUSTER_DOMAIN) -> 127.0.0.1"; \
	elif [ "$$(uname)" = "Darwin" ] && [ -t 0 ]; then \
		echo "Installing /etc/resolver/$(CLUSTER_DOMAIN) (one-time, needs sudo) so"; \
		echo "*.$(CLUSTER_DOMAIN) resolves via the local DNS container..."; \
		if sudo sh -c 'mkdir -p /etc/resolver && printf "nameserver 127.0.0.1\nport $(DNS_PORT)\n" > /etc/resolver/$(CLUSTER_DOMAIN)'; then \
			sleep 1; dscacheutil -flushcache 2>/dev/null || true; \
			echo "Installed /etc/resolver/$(CLUSTER_DOMAIN)"; \
		else \
			echo "WARNING: could not install the resolver file; app hostnames"; \
			echo "will not resolve in your browser (see the local dev docs)."; \
		fi; \
	else \
		echo "WARNING: probe.apps.$(CLUSTER_DOMAIN) does not resolve to 127.0.0.1."; \
		echo "On macOS, run 'make check-dns' from an interactive terminal to install"; \
		echo "the one-time /etc/resolver/$(CLUSTER_DOMAIN) file (sudo; exact command in"; \
		echo "the local development docs). On Linux, route $(CLUSTER_DOMAIN) to"; \
		echo "127.0.0.1:$(DNS_PORT) (e.g. a systemd-resolved drop-in with"; \
		echo "DNS=127.0.0.1:$(DNS_PORT) and Domains=~$(CLUSTER_DOMAIN))."; \
	fi

# --------------------------------------------------------------------------
# up - full local loop: cluster + operator + api + ui + inline example App
# --------------------------------------------------------------------------
up: check-dns cluster images deploy
	kubectl apply -n $(APP_NAMESPACE) -f $(EXAMPLES_DIR)/static-inline-app.yaml
	kubectl wait --for=jsonpath='{.status.phase}'=Running app/docs-site \
		-n $(APP_NAMESPACE) --timeout=180s
	kubectl wait --for=condition=Ready nebariapp/nebari-apps-ui \
		-n nebari-apps --timeout=120s
	@echo ""
	@echo "The Apps Pack is up (plain HTTP locally):"
	@echo "  UI:          http://apps.$(CLUSTER_DOMAIN)"
	@echo "  MCP:         http://apps.$(CLUSTER_DOMAIN)/mcp"
	@echo "  Example app: http://docs-site.apps.$(CLUSTER_DOMAIN)"
	@echo ""
	@echo "Hostnames resolve to 127.0.0.1 via the local DNS container;"
	@echo "kind maps host port 80 to the gateway - no port-forward or"
	@echo "/etc/hosts needed."

# --------------------------------------------------------------------------
# up-git - also deploy the git-sourced example App (auth enabled)
# --------------------------------------------------------------------------
up-git: up
	kubectl apply -n $(APP_NAMESPACE) -f $(EXAMPLES_DIR)/static-git-app.yaml
	kubectl wait --for=jsonpath='{.status.phase}'=Running app/team-site \
		-n $(APP_NAMESPACE) --timeout=180s
	@echo ""
	@echo "Git-sourced App is running (Keycloak SSO enforced at the gateway)."
	@echo "  http://team-site.apps.$(CLUSTER_DOMAIN)"

# --------------------------------------------------------------------------
# redeploy - fast dev loop: rebuild images and roll the Deployments
# --------------------------------------------------------------------------
redeploy: images
	kubectl rollout restart deployment/nebari-apps-operator deployment/nebari-apps-api deployment/nebari-apps-ui deployment/nebari-apps-mcp -n nebari-apps
	kubectl rollout status deployment/nebari-apps-operator -n nebari-apps --timeout=120s
	kubectl rollout status deployment/nebari-apps-api -n nebari-apps --timeout=120s
	kubectl rollout status deployment/nebari-apps-ui -n nebari-apps --timeout=120s
	kubectl rollout status deployment/nebari-apps-mcp -n nebari-apps --timeout=120s

# --------------------------------------------------------------------------
# down - delete the kind cluster
# --------------------------------------------------------------------------
down:
	kind delete cluster --name $(CLUSTER_NAME)
