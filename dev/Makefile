# Local development Makefile for the Nebari Apps Pack
#
# Creates a kind cluster with the full Nebari infrastructure stack
# (MetalLB, Envoy Gateway, cert-manager, Keycloak, nebari-operator),
# builds the apps-operator image, installs the nebari-apps chart, and
# deploys an example App. Mirrors the software-pack-template dev flow.
#
# Prerequisites: docker, kind, helm, kubectl, git
#
# Usage:
#   make up            Everything: cluster + operator + api + ui + example App
#   make up-git        Also deploy the git-sourced example App
#   make redeploy      Rebuild all images and roll the Deployments
#   make update-hosts  Update /etc/hosts with NebariApp hostnames
#   make down          Delete the kind cluster
#
# The UI ends up at http://apps.nebari.local and launched apps at
# http://<name>.apps.nebari.local (TLS is disabled locally so there are no
# certificate warnings). Auth is disabled locally: the kind
# stack's Keycloak is not reachable from a host browser (in-cluster issuer),
# so keycloak-js logins cannot complete; on a real Nebari cluster leave
# api.auth.enabled=true and set keycloak.url.

CLUSTER_NAME   := nebari-apps-dev
CLUSTER_DOMAIN := nebari.local
CHART          := ../charts/nebari-apps
OPERATOR_DIR   := ../operator
API_DIR        := ../api
UI_DIR         := ../ui
EXAMPLES_DIR   := ../examples
CACHE_DIR      := .cache
OPERATOR_REPO  := $(CACHE_DIR)/nebari-operator
OPERATOR_REF   := v0.1.0-alpha.19

IMG            := apps-operator:dev
API_IMG        := apps-api:dev
UI_IMG         := apps-ui:dev
MCP_IMG        := apps-mcp:dev
APP_NAMESPACE  := apps

# MetalLB IP pool configuration template.
# METALLB_BASE_IP is substituted at runtime with the Kind network base.
define METALLB_POOL
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: kind-pool
  namespace: metallb-system
spec:
  addresses:
  - METALLB_BASE_IP.255.200-METALLB_BASE_IP.255.250
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: kind-l2
  namespace: metallb-system
spec:
  ipAddressPools:
  - kind-pool
endef
export METALLB_POOL

.PHONY: up up-git redeploy deploy images operator-image api-image ui-image \
	mcp-image cluster update-hosts port-forward down \
	_cluster-create _clone-operator _kind-create _metallb _services \
	_keycloak-setup _operator _namespaces

# --------------------------------------------------------------------------
# cluster - create kind cluster with full Nebari infrastructure
# --------------------------------------------------------------------------
cluster:
	@if kind get clusters 2>/dev/null | grep -q "^$(CLUSTER_NAME)$$"; then \
		echo "Cluster '$(CLUSTER_NAME)' already exists, skipping setup"; \
	else \
		$(MAKE) _cluster-create; \
	fi

_cluster-create: _clone-operator _kind-create _metallb _services _keycloak-setup _operator _namespaces
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
	kind create cluster --name $(CLUSTER_NAME)

_metallb:
	@echo "Installing MetalLB..."
	kubectl apply -f https://raw.githubusercontent.com/metallb/metallb/v0.14.8/config/manifests/metallb-native.yaml 2>&1 | grep -v "unrecognized format"
	kubectl wait --namespace metallb-system \
		--for=condition=available deployment/controller \
		--timeout=90s
	kubectl wait --namespace metallb-system \
		--for=jsonpath='{.status.numberReady}'=1 \
		daemonset/speaker \
		--timeout=90s
	@KIND_NET_CIDR=$$(docker network inspect kind -f '{{range .IPAM.Config}}{{.Subnet}}{{"\n"}}{{end}}' 2>/dev/null | grep '\.' | head -n1); \
	BASE_IP=$$(echo $${KIND_NET_CIDR} | awk -F. '{print $$1"."$$2}'); \
	echo "MetalLB IP pool: $${BASE_IP}.255.200-$${BASE_IP}.255.250"; \
	echo "$$METALLB_POOL" | sed "s/METALLB_BASE_IP/$${BASE_IP}/g" | kubectl apply -f -
	@echo "MetalLB installed"

_services:
	@echo "Installing foundational services (Envoy Gateway, cert-manager, Keycloak, Gateway, TLS)..."
	CLUSTER_NAME=$(CLUSTER_NAME) $(OPERATOR_REPO)/dev/scripts/services/install.sh

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
	kubectl label namespace default nebari.dev/managed=true --overwrite

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
# up - full local loop: cluster + operator + api + ui + inline example App
# --------------------------------------------------------------------------
up: cluster images deploy
	kubectl apply -n $(APP_NAMESPACE) -f $(EXAMPLES_DIR)/static-inline-app.yaml
	kubectl wait --for=jsonpath='{.status.phase}'=Running app/docs-site \
		-n $(APP_NAMESPACE) --timeout=180s
	kubectl wait --for=condition=Ready nebariapp/nebari-apps-ui \
		-n nebari-apps --timeout=120s
	CLUSTER_NAME=$(CLUSTER_NAME) $(OPERATOR_REPO)/dev/scripts/networking/update-hosts.sh
	@echo ""
	@echo "The Apps Pack is up (plain HTTP locally):"
	@echo "  UI:          http://apps.$(CLUSTER_DOMAIN)"
	@echo "  MCP:         http://apps.$(CLUSTER_DOMAIN)/mcp"
	@echo "  Example app: http://docs-site.apps.$(CLUSTER_DOMAIN)"
	@echo ""
	@echo "On macOS/Docker Desktop the LoadBalancer IP is not routable;"
	@echo "run 'make port-forward' (sudo) and open the same URLs."

# --------------------------------------------------------------------------
# port-forward - host access on macOS/Docker Desktop (gateway HTTP -> :80)
#
# Must listen on local port 80: Envoy matches the exact hostname in the Host
# header, and browsers append non-default ports (host:8080 would 404).
# Binding port 80 usually needs sudo, hence the sudo -E below.
# --------------------------------------------------------------------------
port-forward:
	@SVC=$$(kubectl get svc -n envoy-gateway-system \
		-l gateway.envoyproxy.io/owning-gateway-name=nebari-gateway \
		-o jsonpath='{.items[0].metadata.name}'); \
	echo "Forwarding http://localhost:80 -> $$SVC:80 (Ctrl-C to stop)"; \
	sudo -E KUBECONFIG=$${KUBECONFIG:-$$HOME/.kube/config} \
		kubectl port-forward -n envoy-gateway-system svc/$$SVC 80:80

# --------------------------------------------------------------------------
# up-git - also deploy the git-sourced example App (auth enabled)
# --------------------------------------------------------------------------
up-git: up
	kubectl apply -n $(APP_NAMESPACE) -f $(EXAMPLES_DIR)/static-git-app.yaml
	kubectl wait --for=jsonpath='{.status.phase}'=Running app/team-site \
		-n $(APP_NAMESPACE) --timeout=180s
	CLUSTER_NAME=$(CLUSTER_NAME) $(OPERATOR_REPO)/dev/scripts/networking/update-hosts.sh
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
# update-hosts - update /etc/hosts with all NebariApp hostnames
# --------------------------------------------------------------------------
update-hosts:
	CLUSTER_NAME=$(CLUSTER_NAME) $(OPERATOR_REPO)/dev/scripts/networking/update-hosts.sh

# --------------------------------------------------------------------------
# down - delete the kind cluster
# --------------------------------------------------------------------------
down:
	kind delete cluster --name $(CLUSTER_NAME)
