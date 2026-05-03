/**
 * src/cli/commands/deploy.ts — `specify deploy describe` + `print-tf`.
 *
 * Self-describing install surface. The intent is that another agent in
 * another repo can run `specify deploy describe --format=json`, parse the
 * output, and generate a working specify-qa.tf for that repo without
 * human hand-holding.
 *
 * `describe` returns a structured manifest: image coordinates, Terraform
 * module source + ref, mutually-exclusive variable groups (target / spec /
 * discovery / report sinks), required Secrets, outputs, an embedded
 * agent-install recipe, and a few worked examples.
 *
 * `print-tf <preset>` emits a working `.tf` snippet for one of:
 *   - minimal       — target_url + spec_inline + webhook + file sink
 *   - watch-mode    — same target/spec as minimal, but discovery=watch
 *   - webhook-mode  — explicit webhook discovery, slack sink
 *   - gitops-spec   — spec_git, watch mode, slack sink
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExitCode } from '../exit-codes.js';

export interface DeployCliOptions {
  verb?: string;
  format?: 'json' | 'text';
  preset?: string;
  /** Override `version` reported in `describe`. Used by tests. */
  versionOverride?: string;
  /** Output writer (defaults to process.stdout). Used by tests. */
  out?: NodeJS.WritableStream;
}

export async function deployCommand(opts: DeployCliOptions): Promise<number> {
  const out = opts.out ?? process.stdout;
  if (opts.verb === 'describe') {
    return runDescribe(out, opts);
  }
  if (opts.verb === 'print-tf') {
    return runPrintTf(out, opts.preset);
  }
  out.write(JSON.stringify({ error: 'unknown_verb', verb: opts.verb, supported: ['describe', 'print-tf'] }) + '\n');
  return ExitCode.PARSE_ERROR;
}

function runDescribe(out: NodeJS.WritableStream, opts: DeployCliOptions): number {
  const manifest = buildManifest(opts.versionOverride);
  if (opts.format === 'text') {
    out.write(renderText(manifest));
    return ExitCode.SUCCESS;
  }
  out.write(JSON.stringify(manifest, null, 2) + '\n');
  return ExitCode.SUCCESS;
}

function runPrintTf(out: NodeJS.WritableStream, preset?: string): number {
  const presetName = preset ?? 'minimal';
  const tf = TF_PRESETS[presetName];
  if (!tf) {
    out.write(JSON.stringify({
      error: 'unknown_preset',
      preset: presetName,
      supported: Object.keys(TF_PRESETS),
    }) + '\n');
    return ExitCode.PARSE_ERROR;
  }
  out.write(tf);
  if (!tf.endsWith('\n')) out.write('\n');
  return ExitCode.SUCCESS;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

interface ManifestImage {
  registry: string;
  default_tag: string;
}

interface ManifestModule {
  source: string;
  ref: string;
  min_terraform: string;
  providers: string[];
}

interface OneOfOption {
  name: string;
  type: 'string' | 'object';
  shape?: Record<string, string>;
  companion_secret?: string;
}

interface OneOfGroup {
  name: string;
  doc: string;
  options: OneOfOption[];
}

interface ReportSinkOption {
  type: string;
  shape: Record<string, string>;
  enabled_by: string;
}

interface ManifestSecret {
  name: string;
  doc: string;
}

interface ManifestExample {
  name: string;
  description: string;
  hcl: string;
}

interface DescribeManifest {
  version: string;
  image: ManifestImage;
  terraform_module: ManifestModule;
  required_inputs: Array<{ name: string; type: string; doc: string }>;
  oneof_groups: OneOfGroup[];
  report_sinks: ReportSinkOption[];
  secrets_to_create: ManifestSecret[];
  outputs: string[];
  agent_install_recipe: string[];
  examples: ManifestExample[];
}

function buildManifest(versionOverride?: string): DescribeManifest {
  const version = versionOverride ?? readPackageVersion();
  return {
    version,
    image: {
      registry: 'ghcr.io/gm2211/specify-qa',
      default_tag: 'latest',
    },
    terraform_module: {
      source: 'github.com/gm2211/specify//deploy/terraform/modules/specify-qa',
      ref: 'main',
      min_terraform: '1.5.0',
      providers: ['hashicorp/kubernetes >= 2.20', 'hashicorp/random >= 3.5'],
    },
    required_inputs: [
      { name: 'name', type: 'string', doc: 'Base name for Deployment / Service / PVC / SA. Unique per namespace.' },
      { name: 'namespace', type: 'string', doc: 'K8s namespace; module does not create it.' },
      { name: 'anthropic_api_key_secret', type: 'string', doc: 'Name of an existing Secret with key `api-key`.' },
    ],
    oneof_groups: [
      {
        name: 'target',
        doc: 'How the QA pod reaches the app under test. Pick exactly one.',
        options: [
          { name: 'target_url', type: 'string' },
          { name: 'target_dns', type: 'string' },
          { name: 'target_cluster_ip', type: 'string' },
          { name: 'target_from_configmap', type: 'object', shape: { name: 'string', key: 'string' } },
        ],
      },
      {
        name: 'spec',
        doc: 'Where the spec comes from. Pick exactly one.',
        options: [
          { name: 'spec_inline', type: 'string' },
          { name: 'spec_url', type: 'string', companion_secret: 'spec_url_bearer (auto-generated if empty)' },
          { name: 'spec_git', type: 'object', shape: { repo: 'string', ref: 'string', path: 'string', deploy_key_secret: 'string?' } },
        ],
      },
      {
        name: 'discovery.mode',
        doc: 'How verifies are triggered. Default `webhook`.',
        options: [
          { name: 'webhook', type: 'string' },
          { name: 'watch', type: 'string' },
          { name: 'both', type: 'string' },
          { name: 'none', type: 'string' },
        ],
      },
    ],
    report_sinks: [
      { type: 'file', shape: { path: 'string' }, enabled_by: 'report_file_dir (default /work/reports)' },
      { type: 'slack', shape: { webhook_url: 'string' }, enabled_by: 'report_slack_webhook' },
    ],
    secrets_to_create: [
      { name: 'anthropic-api-key', doc: 'Secret with key `api-key`. Required.' },
      { name: '<name>-internal', doc: 'Module creates this — holds inbox token, optional spec URL bearer, optional Slack webhook.' },
    ],
    outputs: ['inbox_url', 'inbox_token', 'spec_url_bearer', 'service_dns', 'service_account_name', 'pvc_name'],
    agent_install_recipe: [
      'Read this manifest.',
      'Pick exactly one option from each oneof_group based on the consumer repo\'s patterns.',
      'Write a `<name>.tf` file under the consumer\'s Terraform tree wiring `module "specify_qa" { source = ... }`.',
      'Create the `anthropic-api-key` Secret using whatever pattern the repo uses (sops / sealed-secrets / external-secrets / raw).',
      'Run `terraform plan` and surface the diff to the user.',
      'On approval: `terraform apply`. Outputs `inbox_url` + `inbox_token` should be wired into any external trigger (CI, Argo Rollouts AnalysisRun, etc).',
    ],
    examples: [
      {
        name: 'minimal',
        description: 'Webhook-only QA pod, file-sink reports, inline spec.',
        hcl: TF_PRESETS.minimal,
      },
      {
        name: 'watch-mode',
        description: 'Same as minimal but the daemon watches its own namespace and triggers verifies on each rollout.',
        hcl: TF_PRESETS['watch-mode'],
      },
      {
        name: 'gitops-spec',
        description: 'Spec lives in a separate git repo; daemon clones it. Reports go to Slack.',
        hcl: TF_PRESETS['gitops-spec'],
      },
    ],
  };
}

function readPackageVersion(): string {
  // Walk up from this file until we find package.json so the version
  // is consistent with `npm version`.
  try {
    const here = fileURLToPath(import.meta.url);
    let dir = path.dirname(here);
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as { name?: string; version?: string };
        if (pkg.name === 'specify' && pkg.version) return pkg.version;
      }
      dir = path.dirname(dir);
    }
  } catch {
    // fall through
  }
  return '0.0.0';
}

function renderText(m: DescribeManifest): string {
  const lines: string[] = [];
  lines.push(`specify-qa v${m.version}`);
  lines.push(`image:        ${m.image.registry}:${m.image.default_tag}`);
  lines.push(`tf module:    ${m.terraform_module.source}?ref=${m.terraform_module.ref}`);
  lines.push(`tf >= ${m.terraform_module.min_terraform}`);
  lines.push('');
  lines.push('Required inputs:');
  for (const i of m.required_inputs) lines.push(`  ${i.name} (${i.type}) — ${i.doc}`);
  lines.push('');
  lines.push('Pick-one groups:');
  for (const g of m.oneof_groups) {
    lines.push(`  ${g.name}: ${g.options.map((o) => o.name).join(' | ')}`);
  }
  lines.push('');
  lines.push('Outputs: ' + m.outputs.join(', '));
  lines.push('');
  lines.push('Run `specify deploy print-tf <preset>` for a working .tf snippet.');
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// TF presets — kept inline so the CLI is self-contained.
// ---------------------------------------------------------------------------

const TF_PRESETS: Record<string, string> = {
  minimal: `module "specify_qa" {
  source = "github.com/gm2211/specify//deploy/terraform/modules/specify-qa?ref=main"

  name      = "app-qa"
  namespace = "qa"

  target_url               = "http://app.app.svc.cluster.local:8080"
  spec_inline              = file("\${path.module}/specify.spec.yaml")
  anthropic_api_key_secret = "anthropic-api-key"
}
`,
  'watch-mode': `module "specify_qa" {
  source = "github.com/gm2211/specify//deploy/terraform/modules/specify-qa?ref=main"

  name      = "app-qa"
  namespace = "qa"

  target_url  = "http://app.app.svc.cluster.local:8080"
  spec_inline = file("\${path.module}/specify.spec.yaml")

  discovery = {
    mode       = "watch"
    namespaces = ["app"]
  }

  anthropic_api_key_secret = "anthropic-api-key"
}
`,
  'webhook-mode': `module "specify_qa" {
  source = "github.com/gm2211/specify//deploy/terraform/modules/specify-qa?ref=main"

  name      = "app-qa"
  namespace = "qa"

  target_url  = "http://app.app.svc.cluster.local:8080"
  spec_inline = file("\${path.module}/specify.spec.yaml")

  # Default discovery.mode is "webhook"; CI POSTs to module.specify_qa.inbox_url
  report_slack_webhook = var.slack_webhook_url

  anthropic_api_key_secret = "anthropic-api-key"
}

output "specify_qa_inbox" {
  value     = module.specify_qa.inbox_url
  sensitive = false
}

output "specify_qa_token" {
  value     = module.specify_qa.inbox_token
  sensitive = true
}
`,
  'gitops-spec': `module "specify_qa" {
  source = "github.com/gm2211/specify//deploy/terraform/modules/specify-qa?ref=main"

  name      = "app-qa"
  namespace = "qa"

  target_url = "http://app.app.svc.cluster.local:8080"

  spec_git = {
    repo              = "git@github.com:org/app-spec.git"
    ref               = "main"
    path              = "specify.spec.yaml"
    deploy_key_secret = "app-spec-deploy-key"
  }

  discovery = {
    mode       = "watch"
    namespaces = ["app"]
  }

  report_slack_webhook     = var.slack_webhook_url
  anthropic_api_key_secret = "anthropic-api-key"
}
`,
};

export const _internals = { buildManifest, TF_PRESETS };
