# Minimal specify-qa install.
#
# Drops a webhook-mode QA pod into the `qa` namespace. Reports land on the
# PVC at /work/reports/<run_id>.json (file sink). External CI is expected
# to POST verify webhooks to the inbox URL exposed via outputs.
#
# Prerequisites:
#   1. The `qa` namespace exists.
#   2. A k8s Secret named `anthropic-api-key` with key `api-key` exists.
#   3. A spec file `specify.spec.yaml` sits next to this main.tf.

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

module "qa" {
  source = "../../modules/specify-qa"

  name      = "demo-qa"
  namespace = "qa"

  target_url  = "http://demo.app.svc.cluster.local:8080"
  spec_inline = file("${path.module}/specify.spec.yaml")

  anthropic_api_key_secret = "anthropic-api-key"
}

output "inbox_url" {
  description = "POST verify webhooks here."
  value       = module.qa.inbox_url
}

output "inbox_token" {
  description = "Bearer for the inbox URL."
  value       = module.qa.inbox_token
  sensitive   = true
}

output "service_dns" {
  value = module.qa.service_dns
}
