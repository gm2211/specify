# Example: watch-mode

The QA pod watches the listed namespaces directly. Label the Deployments
you want covered and a verify fires after every rollout — no CI plumbing
needed.

```sh
kubectl label deployment renzo specify.dev/target=true -n app
```

```sh
terraform init
terraform apply -var "slack_webhook_url=https://hooks.slack.com/T/B/X"
```

After apply:
- A Role + RoleBinding land in each watched namespace (`namespace` scope by
  default; flip to `cluster` in `discovery.rbac_scope` if you want a single
  ClusterRole).
- The pod's ServiceAccount is bound to those Roles.
- Reports stream to Slack; copies are also kept on the PVC.

To prove the loop end-to-end:

```sh
kubectl -n app rollout restart deployment/renzo
# A few seconds later, the QA pod logs:
#   k8s:rollout deployment/app/renzo …
#   inbox: msg_…
# Slack receives a message; /work/reports/<id>.json is written.
```
