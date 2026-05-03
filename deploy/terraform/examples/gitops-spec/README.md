# Example: gitops-spec

The spec lives in its own repo; the QA pod clones it at startup. To rotate
the spec, push to the configured ref and POST `/control/reload-spec` on
the daemon — no rebuild required.

```sh
# If the repo is private, store the deploy key first:
kubectl -n qa create secret generic renzo-spec-deploy-key \
  --from-file=id_ed25519=$HOME/.ssh/renzo-spec.id_ed25519

terraform init
terraform apply \
  -var spec_repo=git@github.com:org/renzo-spec.git \
  -var spec_ref=main \
  -var spec_path=specify.spec.yaml \
  -var deploy_key_secret=renzo-spec-deploy-key \
  -var slack_webhook_url=https://hooks.slack.com/T/B/X
```

Rotate the spec without redeploying:

```sh
INBOX_URL=$(terraform output -raw inbox_url)
INBOX_TOKEN=$(terraform output -raw inbox_token)
curl -X POST "${INBOX_URL%/inbox}/control/reload-spec" \
  -H "Authorization: Bearer $INBOX_TOKEN"
# → { ok: true, hash: "<sha256>", name: "Renzo", source: { kind: "git", … } }
```

The new hash is stamped onto subsequent memory rows so behaviour expectations
from prior spec versions remain queryable.
