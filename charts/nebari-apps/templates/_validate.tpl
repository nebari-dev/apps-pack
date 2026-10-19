{{/*
Install-time checks, in one place. Rendered once by validate.yaml; a failing
check stops `helm install`/`template` with the message.
*/}}
{{- define "nebari-apps.validate" -}}
{{- $_ := required "clusterDomain is required" .Values.clusterDomain }}
{{- if .Values.api.auth.enabled }}
{{- $_ := required "keycloak.url is required when api.auth.enabled" .Values.keycloak.url }}
{{- else if and .Values.tls.enabled (not .Values.api.auth.insecureAllowAnonymous) }}
{{- fail "api.auth.enabled=false makes the API anonymous with cluster-wide write access. It is meant for local development (which also sets tls.enabled=false). To run without authentication anyway, set api.auth.insecureAllowAnonymous=true." }}
{{- end }}
{{- range .Values.telemetry.metricsReaders }}
{{- $_ := required "telemetry.metricsReaders[].name is required" .name }}
{{- $_ := required "telemetry.metricsReaders[].namespace is required" .namespace }}
{{- end }}
{{- with .Values.ui.existingConfigMap }}
{{- if not $.Values.ui.enabled }}
{{- fail "ui.existingConfigMap is set but ui.enabled is false" }}
{{- end }}
{{- end }}
{{- end }}
