/**
 * src/agent/skill-synthesizer.ts — Turn a mined pattern into a draft skill.
 *
 * Drafts land in `.specify/skill-drafts/<id>.md` until the user reviews
 * them in the webapp (see SP-bgd / drafts review pane). Approved drafts
 * move to `.specify/skills/<name>/SKILL.md` and become replayable.
 *
 * Two describers are supported:
 *   - heuristic: pure-text, deterministic, no API dependency. Always
 *                available; produces a usable starter draft from the
 *                pattern signature + example events.
 *   - llm: optional, plugged in by the caller via opts.describe — generates
 *          a polished natural-language description and step list. Out of
 *          scope for this module; the caller decides whether to invoke
 *          Claude (subject to user-authorised API budget).
 *
 * The synthesizer never writes outside `.specify/skill-drafts/` and never
 * promotes a draft to an active skill on its own.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CandidatePattern } from './pattern-miner.js';

export interface SynthOptions {
  /** Spec path (used to resolve the drafts directory). */
  specPath: string;
  /** Override the drafts dir. Default: `<spec_dir>/.specify/skill-drafts`. */
  draftsDir?: string;
  /** Optional describer; falls back to heuristic when omitted. */
  describe?: (pattern: CandidatePattern) => Promise<DescribedSkill> | DescribedSkill;
}

export interface DescribedSkill {
  name: string;
  description: string;
  /** Markdown body (workflow steps, prerequisites, etc.) — appears below frontmatter. */
  body: string;
  /** Tags for the SKILL.md metadata block. */
  tags?: string[];
}

export interface DraftRecord {
  id: string;
  filePath: string;
  pattern: CandidatePattern;
  skill: DescribedSkill;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}

export function defaultDraftsDir(specPath: string): string {
  return path.join(path.dirname(path.resolve(specPath)), '.specify', 'skill-drafts');
}

export async function synthesizeDraft(pattern: CandidatePattern, opts: SynthOptions): Promise<DraftRecord> {
  const skill = await Promise.resolve(opts.describe ? opts.describe(pattern) : heuristicDescribe(pattern));
  const draftsDir = opts.draftsDir ?? defaultDraftsDir(opts.specPath);
  fs.mkdirSync(draftsDir, { recursive: true });
  const filePath = path.join(draftsDir, `${pattern.id}.md`);
  const createdAt = new Date().toISOString();
  const md = renderSkillMarkdown(skill, pattern, createdAt);
  fs.writeFileSync(filePath, md, 'utf-8');
  return {
    id: pattern.id,
    filePath,
    pattern,
    skill,
    status: 'pending',
    createdAt,
  };
}

export function listDrafts(specPath: string, draftsDir?: string): DraftRecord[] {
  const dir = draftsDir ?? defaultDraftsDir(specPath);
  if (!fs.existsSync(dir)) return [];
  const out: DraftRecord[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.md')) continue;
    const filePath = path.join(dir, entry);
    try {
      const text = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseSkillMarkdown(text);
      if (!parsed) continue;
      out.push({
        id: entry.replace(/\.md$/, ''),
        filePath,
        pattern: parsed.pattern,
        skill: parsed.skill,
        status: parsed.status,
        createdAt: parsed.createdAt,
      });
    } catch {
      // skip malformed drafts
    }
  }
  return out;
}

export function setDraftStatus(filePath: string, status: 'approved' | 'rejected'): void {
  const text = fs.readFileSync(filePath, 'utf-8');
  const updated = text.replace(/^status:.*$/m, `status: ${JSON.stringify(status)}`);
  fs.writeFileSync(filePath, updated, 'utf-8');
}

export function heuristicDescribe(pattern: CandidatePattern): DescribedSkill {
  // Cheap human-readable derivation. The reviewer can rewrite this.
  const niceName = pattern.tokens
    .map((t) => sanitizeName(t.kind.split(':').pop() ?? t.kind))
    .filter(Boolean)
    .join('-')
    .slice(0, 60);
  const name = `mined-${niceName || pattern.id}`;

  const stepLines = pattern.tokens.map((t, i) => {
    const verb = humaniseKind(t.kind);
    return `${i + 1}. **${t.role}** ${verb}`;
  });

  const exampleLines: string[] = [];
  for (const ex of pattern.examples.slice(0, 2)) {
    exampleLines.push(`### Example session ${ex.sessionId}`);
    for (const e of ex.events) {
      const trimmed = e.content.length > 140 ? e.content.slice(0, 140) + '…' : e.content;
      exampleLines.push(`- \`${e.role}/${e.kind}\` — ${trimmed}`);
    }
    exampleLines.push('');
  }

  const body = [
    `## Overview`,
    '',
    `Mined recurring sequence observed across ${pattern.sessionCount} sessions (${pattern.occurrences} occurrences).`,
    `Signature: \`${pattern.signature}\``,
    '',
    `## Steps (heuristic)`,
    '',
    ...stepLines,
    '',
    `## Examples`,
    '',
    ...exampleLines,
    `## Notes for reviewer`,
    '',
    `Replace this body with a natural-language description of the workflow before approving. The heuristic above is a starter — keep what is right, remove what isn't.`,
    '',
  ].join('\n');

  return {
    name,
    description: `Mined skill: ${pattern.signature.slice(0, 80)} (${pattern.sessionCount} sessions)`,
    body,
    tags: ['mined', 'draft'],
  };
}

function humaniseKind(kind: string): string {
  switch (kind) {
    case 'browser:click': return 'clicks an element';
    case 'browser:input': return 'types into a field';
    case 'browser:navigation': return 'navigates to a new URL';
    case 'browser:console': return 'observes a console message';
    case 'agent:tool_use': return 'invokes a tool';
    case 'agent:text': return 'replies in text';
    case 'tool_call': return 'calls a tool';
    case 'message': return 'sends a message';
    default: return `emits \`${kind}\``;
  }
}

function sanitizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function renderSkillMarkdown(skill: DescribedSkill, pattern: CandidatePattern, createdAt: string): string {
  const fm: Record<string, unknown> = {
    name: skill.name,
    description: skill.description,
    version: '0.1.0-draft',
    metadata: {
      specify: {
        tags: skill.tags ?? ['mined', 'draft'],
        category: 'auto-mined',
        pattern_id: pattern.id,
        pattern_signature: pattern.signature,
        pattern_session_count: pattern.sessionCount,
        pattern_occurrences: pattern.occurrences,
      },
    },
    status: 'pending',
    createdAt,
  };
  return [
    '---',
    yamlEncode(fm),
    '---',
    '',
    `# ${skill.name}`,
    '',
    skill.body.trim(),
    '',
  ].join('\n');
}

interface ParsedDraft {
  skill: DescribedSkill;
  pattern: CandidatePattern;
  status: DraftRecord['status'];
  createdAt: string;
}

function parseSkillMarkdown(text: string): ParsedDraft | null {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const fm = yamlDecode(m[1]);
  const meta = ((fm.metadata as Record<string, unknown> | undefined)?.specify) as Record<string, unknown> | undefined;
  const tokens: Array<{ role: string; kind: string }> = String(meta?.pattern_signature ?? '')
    .split(' → ')
    .map((s) => {
      const [role, ...rest] = s.split('/');
      return { role: role ?? '', kind: rest.join('/') };
    });
  const pattern: CandidatePattern = {
    id: String(meta?.pattern_id ?? 'unknown'),
    signature: String(meta?.pattern_signature ?? ''),
    tokens,
    occurrences: Number(meta?.pattern_occurrences ?? 0),
    sessionCount: Number(meta?.pattern_session_count ?? 0),
    examples: [],
  };
  const skill: DescribedSkill = {
    name: String(fm.name ?? 'unnamed'),
    description: String(fm.description ?? ''),
    body: text.slice(m[0].length).replace(/^# .*\n/, '').trim(),
    tags: Array.isArray(meta?.tags) ? meta?.tags as string[] : [],
  };
  return {
    skill,
    pattern,
    status: (fm.status as DraftRecord['status']) ?? 'pending',
    createdAt: String(fm.createdAt ?? ''),
  };
}

// Tiny YAML serialiser for the limited frontmatter shape we emit. Avoids a
// js-yaml dependency at the cost of accepting only the schema we control.
function yamlEncode(o: Record<string, unknown>, indent = 0): string {
  const pad = '  '.repeat(indent);
  const lines: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      lines.push(`${pad}${k}:`);
      lines.push(yamlEncode(v as Record<string, unknown>, indent + 1));
    } else if (Array.isArray(v)) {
      lines.push(`${pad}${k}: [${v.map((item) => JSON.stringify(item)).join(', ')}]`);
    } else if (typeof v === 'string') {
      lines.push(`${pad}${k}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`${pad}${k}: ${String(v)}`);
    }
  }
  return lines.join('\n');
}

function yamlDecode(text: string): Record<string, unknown> {
  // Minimal decoder paired with yamlEncode — handles only the shape we
  // produce (top-level scalars, one nested object, array literal).
  const out: Record<string, unknown> = {};
  const lines = text.split('\n');
  let i = 0;
  const eat = (depth: number, container: Record<string, unknown>): void => {
    while (i < lines.length) {
      const line = lines[i];
      const m = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
      if (!m) { i++; continue; }
      const lead = m[1].length / 2;
      if (lead < depth) return;
      i++;
      const key = m[2];
      const rest = m[3];
      if (rest === '') {
        const child: Record<string, unknown> = {};
        eat(depth + 1, child);
        container[key] = child;
      } else if (rest.startsWith('[')) {
        try {
          container[key] = JSON.parse(rest);
        } catch {
          container[key] = [];
        }
      } else if (rest.startsWith('"')) {
        try {
          container[key] = JSON.parse(rest);
        } catch {
          container[key] = rest.slice(1, -1);
        }
      } else if (/^-?\d+$/.test(rest)) {
        container[key] = Number(rest);
      } else {
        container[key] = rest;
      }
    }
  };
  eat(0, out);
  return out;
}
