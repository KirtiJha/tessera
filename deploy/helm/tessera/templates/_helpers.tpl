{{- define "tessera.name" -}}{{ .Chart.Name }}{{- end -}}
{{- define "tessera.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}{{ .Release.Name | trunc 63 | trimSuffix "-" }}{{- else -}}{{ printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}{{- end -}}
{{- end -}}
{{- define "tessera.labels" -}}
app.kubernetes.io/name: {{ include "tessera.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}
{{- define "tessera.selector" -}}
app.kubernetes.io/name: {{ include "tessera.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "tessera.secretName" -}}{{ .Values.existingSecret | default (include "tessera.fullname" .) }}{{- end -}}
{{- define "tessera.serviceAccountName" -}}{{ if .Values.serviceAccount.create }}{{ .Values.serviceAccount.name | default (include "tessera.fullname" .) }}{{ else }}{{ .Values.serviceAccount.name | default "default" }}{{ end }}{{- end -}}
{{- define "tessera.validate" -}}
{{- if not .Values.publicUrl -}}{{ fail "publicUrl is required" }}{{- end -}}
{{- if and (not .Values.existingSecret) (not .Values.secret.databaseUrl) -}}{{ fail "set secret.databaseUrl, or existingSecret with a DATABASE_URL key" }}{{- end -}}
{{- if and (not .Values.existingSecret) (lt (len .Values.secret.secretKey) 32) -}}{{ fail "secret.secretKey must be at least 32 characters (openssl rand -hex 32), or use existingSecret" }}{{- end -}}
{{- if and (or (gt (int .Values.replicaCount) 1) .Values.autoscaling.enabled) (not .Values.redis.url) (not .Values.existingSecret) -}}{{ fail "more than one replica needs redis.url (or REDIS_URL in existingSecret)" }}{{- end -}}
{{- end -}}
