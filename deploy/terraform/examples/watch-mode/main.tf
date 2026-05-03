# Watch-mode specify-qa install.
#
# Daemon opens k8s informers on Deployments / StatefulSets in the listed
# namespaces and verifies on every rollout-complete. No external CI plumbing
# needed beyond labelling the apps under test with `specify.dev/target=true`.

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

variable "slack_webhook_url" {
  type        = string
  sensitive   = true
  description = "Slack incoming-webhook URL for QA reports."
  default     = ""
}

module "qa" {
  source = "../../modules/specify-qa"

  name      = "renzo-qa"
  namespace = "qa"

  target_url  = "http://renzo.app.svc.cluster.local:8080"
  spec_inline = file("${path.module}/specify.spec.yaml")

  discovery = {
    mode       = "watch"
    namespaces = ["app", "staging"]
  }

  report_slack_webhook     = var.slack_webhook_url
  anthropic_api_key_secret = "anthropic-api-key"
}

output "inbox_url"      { value = module.qa.inbox_url }
output "service_dns"    { value = module.qa.service_dns }
output "service_account" { value = module.qa.service_account_name }
