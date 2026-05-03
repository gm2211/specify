# GitOps-spec specify-qa install.
#
# The spec lives in its own git repo. The QA pod clones at startup (and on
# POST /control/reload-spec) so spec rotations decouple from app deploys.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = ">= 2.20"
    }
  }
}

provider "kubernetes" {
  config_path = "~/.kube/config"
}

variable "spec_repo" {
  type        = string
  description = "Git repo URL containing the spec (SSH form recommended)."
}

variable "spec_ref" {
  type        = string
  description = "Branch / tag / sha."
  default     = "main"
}

variable "spec_path" {
  type        = string
  description = "Path inside the repo."
  default     = "specify.spec.yaml"
}

variable "deploy_key_secret" {
  type        = string
  description = "Existing k8s Secret name with key `id_ed25519`."
  default     = null
}

variable "slack_webhook_url" {
  type      = string
  sensitive = true
  default   = ""
}

module "qa" {
  source = "../../modules/specify-qa"

  name      = "renzo-qa"
  namespace = "qa"

  target_url = "http://renzo.app.svc.cluster.local:8080"

  spec_git = {
    repo              = var.spec_repo
    ref               = var.spec_ref
    path              = var.spec_path
    deploy_key_secret = var.deploy_key_secret
  }

  discovery = {
    mode       = "watch"
    namespaces = ["app"]
  }

  report_slack_webhook     = var.slack_webhook_url
  anthropic_api_key_secret = "anthropic-api-key"
}

output "inbox_url"   { value = module.qa.inbox_url }
output "service_dns" { value = module.qa.service_dns }
