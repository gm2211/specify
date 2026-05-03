# Example: minimal

Webhook-mode QA pod with an inline spec and the file report sink. Easiest
path to "I see a verify run finishing on a real cluster".

```sh
# Pre-reqs once: namespace + Secret.
kubectl create namespace qa
kubectl -n qa create secret generic anthropic-api-key --from-literal=api-key=sk-…

terraform init
terraform apply

# Trigger a verify (replace the bearer with the sensitive output).
INBOX_URL=$(terraform output -raw inbox_url)
INBOX_TOKEN=$(terraform output -raw inbox_token)

curl -X POST "$INBOX_URL" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"task":"verify","prompt":"Verify against the active spec.","sender":"manual"}'

# Inspect reports on the PVC:
kubectl -n qa exec deploy/demo-qa -- ls /work/reports
```
