output "service_name" {
  description = "Name of the ClusterIP Service exposing the daemon."
  value       = kubernetes_service_v1.this.metadata[0].name
}

output "service_dns" {
  description = "Cluster-internal DNS for the daemon (e.g. for sibling apps that POST to /inbox)."
  value       = "${kubernetes_service_v1.this.metadata[0].name}.${var.namespace}.svc.cluster.local"
}

output "inbox_url" {
  description = "Daemon inbox URL inside the cluster."
  value       = "http://${kubernetes_service_v1.this.metadata[0].name}.${var.namespace}.svc.cluster.local:4100/inbox"
}

output "inbox_token" {
  description = "Bearer token for /inbox. Re-emit through your Secret-management pattern when wiring webhooks."
  value       = local.effective_inbox_token
  sensitive   = true
}

output "spec_url_bearer" {
  description = "Bearer the QA pod uses to fetch spec_url. Stamp this into the app under test so it accepts the call."
  value       = local.effective_spec_url_bearer
  sensitive   = true
}

output "service_account_name" {
  description = "ServiceAccount the pod runs as. Useful for stamping NetworkPolicy rules."
  value       = kubernetes_service_account_v1.this.metadata[0].name
}

output "pvc_name" {
  description = "PVC backing /work. Inspect for memory rows / sessions / reports."
  value       = kubernetes_persistent_volume_claim_v1.work.metadata[0].name
}
