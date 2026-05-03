# ----------------------------------------------------------------------------
# specify-qa — single-replica QA pod backed by a PVC.
#
# Layout:
#   - PVC at /work for memory rows, sessions DB, skill drafts, reports.
#   - ConfigMap for the inline spec (when spec_inline != null).
#   - Secret for inbox bearer + spec URL bearer (auto-generated as needed).
#   - Secret for the Slack webhook (when configured).
#   - Service exposing :4100 to siblings.
#   - Optional ServiceAccount + Role/ClusterRole + binding when discovery
#     mode is watch/both.
# ----------------------------------------------------------------------------

locals {
  target_kinds = compact([
    var.target_url != null ? "target_url" : null,
    var.target_dns != null ? "target_dns" : null,
    var.target_cluster_ip != null ? "target_cluster_ip" : null,
    var.target_from_configmap != null ? "target_from_configmap" : null,
  ])

  spec_kinds = compact([
    var.spec_inline != null ? "spec_inline" : null,
    var.spec_url != null ? "spec_url" : null,
    var.spec_git != null ? "spec_git" : null,
  ])

  resolved_target_url = (
    var.target_url != null ? var.target_url :
    var.target_dns != null ? "http://${var.target_dns}" :
    var.target_cluster_ip != null ? "http://${var.target_cluster_ip}" :
    null
  )

  discovery_mode       = coalesce(var.discovery.mode, "webhook")
  watch_enabled        = local.discovery_mode == "watch" || local.discovery_mode == "both"
  rbac_scope           = coalesce(var.discovery.rbac_scope, "namespace")
  watch_resources      = coalesce(var.discovery.resources, ["deployment", "statefulset"])
  watch_namespaces     = coalesce(var.discovery.namespaces, [])
  watch_label_selector = coalesce(var.discovery.label_selector, "specify.dev/target=true")

  labels = {
    "app.kubernetes.io/name"       = var.name
    "app.kubernetes.io/component"  = "specify-qa"
    "app.kubernetes.io/managed-by" = "terraform"
  }
}

resource "terraform_data" "preconditions" {
  lifecycle {
    precondition {
      condition     = length(local.target_kinds) == 1
      error_message = "Pick exactly one target_* (target_url | target_dns | target_cluster_ip | target_from_configmap)."
    }
    precondition {
      condition     = length(local.spec_kinds) == 1
      error_message = "Pick exactly one spec_* (spec_inline | spec_url | spec_git)."
    }
    precondition {
      condition     = (var.target_from_configmap == null) || (local.resolved_target_url == null)
      error_message = "target_from_configmap is mutually exclusive with the other target_* options."
    }
  }
}

# ----------------------------------------------------------------------------
# Random tokens (used when caller didn't supply them).
# ----------------------------------------------------------------------------

resource "random_password" "inbox_token" {
  count   = var.inbox_token == "" ? 1 : 0
  length  = 48
  special = false
}

resource "random_password" "spec_url_bearer" {
  count   = var.spec_url != null && var.spec_url_bearer == null ? 1 : 0
  length  = 48
  special = false
}

locals {
  effective_inbox_token     = var.inbox_token != "" ? var.inbox_token : (length(random_password.inbox_token) > 0 ? random_password.inbox_token[0].result : "")
  effective_spec_url_bearer = var.spec_url == null ? null : (var.spec_url_bearer != null ? var.spec_url_bearer : random_password.spec_url_bearer[0].result)
}

# ----------------------------------------------------------------------------
# Secrets.
# ----------------------------------------------------------------------------

resource "kubernetes_secret_v1" "internal" {
  metadata {
    name      = "${var.name}-internal"
    namespace = var.namespace
    labels    = local.labels
  }

  data = merge(
    {
      "inbox-token" = local.effective_inbox_token
    },
    local.effective_spec_url_bearer == null ? {} : {
      "spec-url-bearer" = local.effective_spec_url_bearer
    },
    var.report_slack_webhook == "" ? {} : {
      "slack-webhook" = var.report_slack_webhook
    },
  )
}

# ----------------------------------------------------------------------------
# ConfigMap for the inline spec (when configured).
# ----------------------------------------------------------------------------

resource "kubernetes_config_map_v1" "inline_spec" {
  count = var.spec_inline != null ? 1 : 0

  metadata {
    name      = "${var.name}-spec"
    namespace = var.namespace
    labels    = local.labels
  }

  data = {
    "specify.spec.yaml" = var.spec_inline
  }
}

# ----------------------------------------------------------------------------
# PVC.
# ----------------------------------------------------------------------------

resource "kubernetes_persistent_volume_claim_v1" "work" {
  metadata {
    name      = "${var.name}-work"
    namespace = var.namespace
    labels    = local.labels
  }

  spec {
    access_modes = ["ReadWriteOnce"]

    resources {
      requests = {
        storage = var.pvc_size
      }
    }

    storage_class_name = var.pvc_storage_class == "" ? null : var.pvc_storage_class
  }

  wait_until_bound = false
}

# ----------------------------------------------------------------------------
# ServiceAccount (always created — even in webhook-only mode it's tidy to
# pin the pod identity).
# ----------------------------------------------------------------------------

resource "kubernetes_service_account_v1" "this" {
  metadata {
    name      = var.name
    namespace = var.namespace
    labels    = local.labels
  }
}

# RBAC for k8s-watcher: rules vary by scope (namespace vs cluster).
resource "kubernetes_role_v1" "watch" {
  count = local.watch_enabled && local.rbac_scope == "namespace" ? length(local.watch_namespaces) : 0

  metadata {
    name      = "${var.name}-watch-${local.watch_namespaces[count.index]}"
    namespace = local.watch_namespaces[count.index]
    labels    = local.labels
  }

  rule {
    api_groups = ["apps"]
    resources  = local.watch_resources
    verbs      = ["get", "list", "watch"]
  }
}

resource "kubernetes_role_binding_v1" "watch" {
  count = local.watch_enabled && local.rbac_scope == "namespace" ? length(local.watch_namespaces) : 0

  metadata {
    name      = "${var.name}-watch-${local.watch_namespaces[count.index]}"
    namespace = local.watch_namespaces[count.index]
    labels    = local.labels
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Role"
    name      = kubernetes_role_v1.watch[count.index].metadata[0].name
  }

  subject {
    kind      = "ServiceAccount"
    name      = kubernetes_service_account_v1.this.metadata[0].name
    namespace = var.namespace
  }
}

resource "kubernetes_cluster_role_v1" "watch" {
  count = local.watch_enabled && local.rbac_scope == "cluster" ? 1 : 0

  metadata {
    name   = "${var.name}-watch"
    labels = local.labels
  }

  rule {
    api_groups = ["apps"]
    resources  = local.watch_resources
    verbs      = ["get", "list", "watch"]
  }
}

resource "kubernetes_cluster_role_binding_v1" "watch" {
  count = local.watch_enabled && local.rbac_scope == "cluster" ? 1 : 0

  metadata {
    name   = "${var.name}-watch"
    labels = local.labels
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "ClusterRole"
    name      = kubernetes_cluster_role_v1.watch[0].metadata[0].name
  }

  subject {
    kind      = "ServiceAccount"
    name      = kubernetes_service_account_v1.this.metadata[0].name
    namespace = var.namespace
  }
}

# ----------------------------------------------------------------------------
# Deployment.
# ----------------------------------------------------------------------------

resource "kubernetes_deployment_v1" "this" {
  depends_on = [terraform_data.preconditions]

  metadata {
    name      = var.name
    namespace = var.namespace
    labels    = local.labels
  }

  spec {
    replicas = 1

    strategy {
      type = "Recreate" # Only one pod can hold the PVC (RWO) at a time.
    }

    selector {
      match_labels = {
        "app.kubernetes.io/name" = var.name
      }
    }

    template {
      metadata {
        labels = local.labels
      }

      spec {
        service_account_name = kubernetes_service_account_v1.this.metadata[0].name

        # When target_from_configmap is set, an init container reads the
        # value into /work/runtime/target_url so the daemon picks it up.
        dynamic "init_container" {
          for_each = var.target_from_configmap != null ? [var.target_from_configmap] : []
          content {
            name    = "resolve-target"
            image   = "busybox:1.36"
            command = ["/bin/sh", "-c"]
            args = [<<-EOT
              mkdir -p /work/runtime
              cp /target/${init_container.value.key} /work/runtime/target_url
            EOT
            ]
            volume_mount {
              name       = "work"
              mount_path = "/work"
            }
            volume_mount {
              name       = "target-cm"
              mount_path = "/target"
            }
          }
        }

        container {
          name              = "specify"
          image             = var.image
          image_pull_policy = var.image_pull_policy

          # The Dockerfile already CMDs into `daemon --host 0.0.0.0 --port 4100`.
          # Override only when callers need to.

          env {
            name = "ANTHROPIC_API_KEY"
            value_from {
              secret_key_ref {
                name = var.anthropic_api_key_secret
                key  = "api-key"
              }
            }
          }

          env {
            name = "SPECIFY_INBOX_TOKEN"
            value_from {
              secret_key_ref {
                name = kubernetes_secret_v1.internal.metadata[0].name
                key  = "inbox-token"
              }
            }
          }

          dynamic "env" {
            for_each = local.resolved_target_url != null ? [local.resolved_target_url] : []
            content {
              name  = "SPECIFY_TARGET_URL"
              value = env.value
            }
          }

          # Spec sourcing — exactly one of these blocks is active per validation above.
          dynamic "env" {
            for_each = var.spec_inline != null ? [1] : []
            content {
              name  = "SPECIFY_SPEC_INLINE_PATH"
              value = "/work/spec/specify.spec.yaml"
            }
          }

          dynamic "env" {
            for_each = var.spec_url != null ? [var.spec_url] : []
            content {
              name  = "SPECIFY_SPEC_URL"
              value = env.value
            }
          }

          dynamic "env" {
            for_each = var.spec_url != null ? [1] : []
            content {
              name  = "SPECIFY_SPEC_URL_BEARER_FILE"
              value = "/run/secrets/specify/spec-url-bearer"
            }
          }

          dynamic "env" {
            for_each = var.spec_git != null ? [var.spec_git] : []
            content {
              name  = "SPECIFY_SPEC_GIT_REPO"
              value = env.value.repo
            }
          }
          dynamic "env" {
            for_each = var.spec_git != null ? [var.spec_git] : []
            content {
              name  = "SPECIFY_SPEC_GIT_REF"
              value = env.value.ref
            }
          }
          dynamic "env" {
            for_each = var.spec_git != null ? [var.spec_git] : []
            content {
              name  = "SPECIFY_SPEC_GIT_PATH"
              value = env.value.path
            }
          }
          dynamic "env" {
            for_each = (var.spec_git != null && try(var.spec_git.deploy_key_secret, null) != null) ? [var.spec_git] : []
            content {
              name  = "SPECIFY_SPEC_GIT_DEPLOY_KEY_FILE"
              value = "/run/secrets/git/id_ed25519"
            }
          }

          # Discovery.
          dynamic "env" {
            for_each = local.watch_enabled ? [1] : []
            content {
              name  = "SPECIFY_K8S_WATCH"
              value = "true"
            }
          }
          dynamic "env" {
            for_each = local.watch_enabled && length(local.watch_namespaces) > 0 ? [1] : []
            content {
              name  = "SPECIFY_K8S_NAMESPACES"
              value = join(",", local.watch_namespaces)
            }
          }
          dynamic "env" {
            for_each = local.watch_enabled ? [1] : []
            content {
              name  = "SPECIFY_K8S_LABEL_SELECTOR"
              value = local.watch_label_selector
            }
          }
          dynamic "env" {
            for_each = local.watch_enabled ? [1] : []
            content {
              name  = "SPECIFY_K8S_RESOURCES"
              value = join(",", local.watch_resources)
            }
          }

          # Reports.
          env {
            name  = "SPECIFY_REPORT_FILE_DIR"
            value = var.report_file_dir
          }
          dynamic "env" {
            for_each = var.report_slack_webhook != "" ? [1] : []
            content {
              name  = "SPECIFY_REPORT_SLACK_WEBHOOK_FILE"
              value = "/run/secrets/specify/slack-webhook"
            }
          }

          port {
            name           = "http"
            container_port = 4100
          }

          liveness_probe {
            http_get {
              path = "/health"
              port = 4100
            }
            initial_delay_seconds = 10
            period_seconds        = 20
          }

          readiness_probe {
            http_get {
              path = "/health"
              port = 4100
            }
            period_seconds = 10
          }

          resources {
            requests = {
              cpu    = coalesce(var.resources.cpu_request, "200m")
              memory = coalesce(var.resources.memory_request, "512Mi")
            }
            limits = {
              cpu    = coalesce(var.resources.cpu_limit, "1000m")
              memory = coalesce(var.resources.memory_limit, "2Gi")
            }
          }

          volume_mount {
            name       = "work"
            mount_path = "/work"
          }

          volume_mount {
            name       = "internal"
            mount_path = "/run/secrets/specify"
            read_only  = true
          }

          dynamic "volume_mount" {
            for_each = var.spec_inline != null ? [1] : []
            content {
              name       = "spec"
              mount_path = "/work/spec"
              read_only  = true
            }
          }

          dynamic "volume_mount" {
            for_each = (var.spec_git != null && try(var.spec_git.deploy_key_secret, null) != null) ? [var.spec_git] : []
            content {
              name       = "git-deploy-key"
              mount_path = "/run/secrets/git"
              read_only  = true
            }
          }
        }

        volume {
          name = "work"
          persistent_volume_claim {
            claim_name = kubernetes_persistent_volume_claim_v1.work.metadata[0].name
          }
        }

        volume {
          name = "internal"
          secret {
            secret_name = kubernetes_secret_v1.internal.metadata[0].name
          }
        }

        dynamic "volume" {
          for_each = var.spec_inline != null ? [1] : []
          content {
            name = "spec"
            config_map {
              name = kubernetes_config_map_v1.inline_spec[0].metadata[0].name
            }
          }
        }

        dynamic "volume" {
          for_each = var.target_from_configmap != null ? [var.target_from_configmap] : []
          content {
            name = "target-cm"
            config_map {
              name = volume.value.name
            }
          }
        }

        dynamic "volume" {
          for_each = (var.spec_git != null && try(var.spec_git.deploy_key_secret, null) != null) ? [var.spec_git] : []
          content {
            name = "git-deploy-key"
            secret {
              secret_name  = volume.value.deploy_key_secret
              default_mode = "0400"
            }
          }
        }
      }
    }
  }
}

# ----------------------------------------------------------------------------
# Service.
# ----------------------------------------------------------------------------

resource "kubernetes_service_v1" "this" {
  metadata {
    name      = var.name
    namespace = var.namespace
    labels    = local.labels
  }

  spec {
    selector = {
      "app.kubernetes.io/name" = var.name
    }

    port {
      name        = "http"
      port        = 4100
      target_port = "http"
    }

    type = "ClusterIP"
  }
}
