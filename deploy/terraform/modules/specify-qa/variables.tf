variable "name" {
  type        = string
  description = "Base name for the Deployment / Service / PVC / ServiceAccount. Should be unique within the namespace."
}

variable "namespace" {
  type        = string
  description = "Namespace the QA pod runs in. The module does not create the namespace."
}

variable "image" {
  type        = string
  description = "Container image. Default: ghcr.io/gm2211/specify-qa:latest. Pin to a digest in production."
  default     = "ghcr.io/gm2211/specify-qa:latest"
}

variable "image_pull_policy" {
  type        = string
  description = "IfNotPresent (default) or Always."
  default     = "IfNotPresent"

  validation {
    condition     = contains(["Always", "IfNotPresent", "Never"], var.image_pull_policy)
    error_message = "image_pull_policy must be one of Always, IfNotPresent, Never."
  }
}

variable "resources" {
  type = object({
    cpu_request    = optional(string, "200m")
    cpu_limit      = optional(string, "1000m")
    memory_request = optional(string, "512Mi")
    memory_limit   = optional(string, "2Gi")
  })
  description = "Pod resource requests / limits."
  default     = {}
}

# ----------------------------------------------------------------------------
# Target — pick exactly one of these. (See variables_target_validate.tf below
# for the cross-attribute check.)
# ----------------------------------------------------------------------------

variable "target_url" {
  type        = string
  description = "Direct URL to the app under test (e.g. http://app.svc.cluster.local:8080)."
  default     = null
}

variable "target_dns" {
  type        = string
  description = "Bare hostname; defaults to http://<dns>:80 inside the pod."
  default     = null
}

variable "target_cluster_ip" {
  type        = string
  description = "Direct IP[:port], used when DNS isn't resolvable from the pod (e.g. external service)."
  default     = null
}

variable "target_from_configmap" {
  type = object({
    name = string
    key  = string
  })
  description = "Read the target URL from another ConfigMap at runtime. Useful when the app team publishes its own endpoint."
  default     = null
}

# ----------------------------------------------------------------------------
# Spec source — pick exactly one.
# ----------------------------------------------------------------------------

variable "spec_inline" {
  type        = string
  description = "Spec YAML content, baked into a ConfigMap mounted at /work/spec/specify.spec.yaml."
  default     = null
  sensitive   = true
}

variable "spec_url" {
  type        = string
  description = "URL the QA pod fetches the spec from on each /control/reload-spec call."
  default     = null
}

variable "spec_url_bearer" {
  type        = string
  description = "Bearer token for the spec_url. Auto-generated if spec_url is set and this is empty."
  default     = null
  sensitive   = true
}

variable "spec_git" {
  type = object({
    repo              = string
    ref               = string
    path              = string
    deploy_key_secret = optional(string)
  })
  description = "Clone repo@ref, read path. deploy_key_secret is the name of an existing Secret with an `id_ed25519` key when the repo is private."
  default     = null
}

# ----------------------------------------------------------------------------
# Discovery — how verifies are triggered.
# ----------------------------------------------------------------------------

variable "discovery" {
  type = object({
    mode           = optional(string, "webhook") # watch | webhook | both | none
    namespaces     = optional(list(string), [])
    label_selector = optional(string, "specify.dev/target=true")
    resources      = optional(list(string), ["deployment", "statefulset"])
    rbac_scope     = optional(string, "namespace") # namespace | cluster
  })
  description = "How the daemon learns about new app versions to verify."
  default     = {}

  validation {
    condition     = contains(["watch", "webhook", "both", "none"], coalesce(var.discovery.mode, "webhook"))
    error_message = "discovery.mode must be one of watch, webhook, both, none."
  }

  validation {
    condition     = contains(["namespace", "cluster"], coalesce(var.discovery.rbac_scope, "namespace"))
    error_message = "discovery.rbac_scope must be namespace or cluster."
  }
}

# ----------------------------------------------------------------------------
# Reports.
# ----------------------------------------------------------------------------

variable "report_file_dir" {
  type        = string
  description = "When set, file sink writes verify reports into this in-pod directory (PVC-backed, defaults to /work/reports)."
  default     = "/work/reports"
}

variable "report_slack_webhook" {
  type        = string
  description = "Slack incoming-webhook URL. Stored in a Secret and mounted to the pod. Empty disables the slack sink."
  default     = ""
  sensitive   = true
}

# ----------------------------------------------------------------------------
# Auth + secrets.
# ----------------------------------------------------------------------------

variable "anthropic_api_key_secret" {
  type        = string
  description = "Name of an existing Secret in `namespace` with key `api-key` holding the Anthropic API key. Required."
}

variable "inbox_token" {
  type        = string
  description = "Bearer token for the daemon /inbox endpoint. Auto-generated when empty."
  default     = ""
  sensitive   = true
}

# ----------------------------------------------------------------------------
# Storage.
# ----------------------------------------------------------------------------

variable "pvc_size" {
  type        = string
  description = "Size of the PVC that backs /work (memory rows, sessions DB, skill drafts, reports)."
  default     = "5Gi"
}

variable "pvc_storage_class" {
  type        = string
  description = "StorageClass for the PVC. Empty = cluster default."
  default     = ""
}

# Cross-field validation lives in main.tf, in a `terraform_data` precondition.
