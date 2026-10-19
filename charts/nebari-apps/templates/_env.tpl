{{/*
OIDC settings shared by apps-api and apps-mcp: both verify Keycloak tokens
against the same issuer and accept only this pack's two clients (the UI's
SPA client and the device-flow client), whose ids the UI's NebariApp writes
into its OIDC secret. If the secret is missing the $(...) references stay
unexpanded and every token is rejected (fail closed).

Takes (dict "root" $ "spaVar" "<env var the service reads the SPA id from>").
*/}}
{{- define "nebari-apps.oidcEnv" -}}
{{- $root := .root -}}
- name: AUTH_ENABLED
  value: {{ $root.Values.api.auth.enabled | quote }}
{{- if $root.Values.api.auth.enabled }}
- name: OIDC_ISSUER
  value: {{ printf "%s/realms/%s" ($root.Values.keycloak.url | trimSuffix "/") $root.Values.keycloak.realm }}
{{- with $root.Values.keycloak.internalUrl }}
- name: OIDC_ISSUER_INTERNAL
  value: {{ printf "%s/realms/%s" (. | trimSuffix "/") $root.Values.keycloak.realm }}
{{- end }}
- name: {{ .spaVar }}
  valueFrom:
    secretKeyRef:
      name: {{ include "nebari-apps.fullname" $root }}-ui-oidc-client
      key: spa-client-id
      optional: true
- name: OIDC_DEVICE_CLIENT_ID
  valueFrom:
    secretKeyRef:
      name: {{ include "nebari-apps.fullname" $root }}-ui-oidc-client
      key: device-client-id
      optional: true
- name: OIDC_ALLOWED_CLIENTS
  value: "$({{ .spaVar }}),$(OIDC_DEVICE_CLIENT_ID)"
{{- end }}
{{- end }}

