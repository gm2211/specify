/**
 * src/spec/narrative.ts — Narrative companion format
 *
 * A narrative document is a human-readable description of a product
 * that links prose sections to computable spec items. It lives alongside
 * the YAML spec as a companion .narrative.md file.
 *
 * Format:
 *   # Product Name
 *   <!-- spec:meta -->
 *
 *   ## Overview
 *   <!-- spec:overview -->
 *   Prose description...
 *
 *   ## Login Page
 *   <!-- spec:page:login -->
 *   Prose about the login page...
 *
 *   ### Successful Login
 *   <!-- spec:scenario:login/successful-login -->
 *   Prose about the happy path...
 *
 *   ## Checkout Flow
 *   <!-- spec:flow:checkout -->
 *   Prose about the checkout flow...
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A narrative document with sections linked to spec items. */
export interface NarrativeDocument {
  /** Product/project title. */
  title: string;

  /** High-level overview paragraph. */
  overview: string;

  /** Ordered sections — each maps to one or more spec items. */
  sections: NarrativeSection[];

  /** Path to the companion spec file (relative). */
  specPath?: string;
}

/** A section of the narrative linked to spec items. */
export interface NarrativeSection {
  /** Section heading. */
  title: string;

  /** Markdown prose for this section. */
  body: string;

  /** Spec item references (e.g., "page:login", "flow:checkout", "cli:help"). */
  specRefs: string[];

  /** Nested subsections. */
  children: NarrativeSection[];
}

// ---------------------------------------------------------------------------
// Conversion: Spec embedded narrative → NarrativeDocument
// ---------------------------------------------------------------------------

import type { Spec, SpecV1, NarrativeSection as SpecNarrativeSection } from './types.js';
import { isV1 } from './types.js';

/**
 * Convert embedded narrative sections (spec.narrative) into a NarrativeDocument
 * suitable for the review generator.
 *
 * Mapping:
 *   SpecNarrativeSection.section     → NarrativeSection.title
 *   SpecNarrativeSection.prose       → NarrativeSection.body
 *   SpecNarrativeSection.covers      → NarrativeSection.specRefs
 *   SpecNarrativeSection.requirements → appended as "requirement:{id}" in specRefs
 *   Spec.name                        → NarrativeDocument.title
 */
export function specNarrativeToDocument(spec: Spec): NarrativeDocument {
  if (!isV1(spec)) {
    return { title: spec.name, overview: spec.description ?? '', sections: [] };
  }
  const sections: NarrativeSection[] = (spec.narrative ?? []).map((ns: SpecNarrativeSection) => {
    const specRefs: string[] = [...(ns.covers ?? [])];
    for (const req of ns.requirements ?? []) {
      specRefs.push(`requirement:${req.id}`);
    }
    return {
      title: ns.section,
      body: ns.prose,
      specRefs,
      children: [],
    };
  });

  const overview = spec.description ?? '';

  return {
    title: spec.name,
    overview,
    sections,
  };
}

// ---------------------------------------------------------------------------
// Serialization: NarrativeDocument → Markdown
// ---------------------------------------------------------------------------

export function narrativeToMarkdown(doc: NarrativeDocument): string {
  const lines: string[] = [];

  lines.push(`# ${doc.title}`);
  if (doc.specPath) {
    lines.push(`<!-- spec-file: ${doc.specPath} -->`);
  }
  lines.push('');

  if (doc.overview) {
    lines.push('## Overview');
    lines.push('<!-- spec:overview -->');
    lines.push('');
    lines.push(doc.overview);
    lines.push('');
  }

  for (const section of doc.sections) {
    serializeSection(section, 2, lines);
  }

  return lines.join('\n');
}

function serializeSection(section: NarrativeSection, depth: number, lines: string[]): void {
  const heading = '#'.repeat(depth);
  lines.push(`${heading} ${section.title}`);

  for (const ref of section.specRefs) {
    lines.push(`<!-- spec:${ref} -->`);
  }

  lines.push('');
  if (section.body) {
    lines.push(section.body);
    lines.push('');
  }

  for (const child of section.children) {
    serializeSection(child, Math.min(depth + 1, 6), lines);
  }
}

// ---------------------------------------------------------------------------
// Parsing: Markdown → NarrativeDocument
// ---------------------------------------------------------------------------

export function markdownToNarrative(md: string): NarrativeDocument {
  const lines = md.split('\n');

  let title = '';
  let specPath: string | undefined;
  let overview = '';
  const sections: NarrativeSection[] = [];

  // Parse title from first H1
  const titleMatch = lines[0]?.match(/^#\s+(.+)/);
  if (titleMatch) {
    title = titleMatch[1].trim();
  }

  // Parse spec-file comment
  for (const line of lines.slice(0, 5)) {
    const specFileMatch = line.match(/<!--\s*spec-file:\s*(.+?)\s*-->/);
    if (specFileMatch) {
      specPath = specFileMatch[1];
    }
  }

  // Parse sections
  type PendingSection = { title: string; depth: number; specRefs: string[]; bodyLines: string[]; children: NarrativeSection[] };
  const stack: PendingSection[] = [];
  let inOverview = false;
  const overviewLines: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    // Check for heading
    const headingMatch = line.match(/^(#{2,6})\s+(.+)/);
    if (headingMatch) {
      const depth = headingMatch[1].length;
      const sectionTitle = headingMatch[2].trim();

      if (sectionTitle === 'Overview') {
        inOverview = true;
        continue;
      }

      inOverview = false;

      // Finalize sections on the stack that are at the same or deeper depth
      while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
        finalizeTop(stack, sections);
      }

      stack.push({
        title: sectionTitle,
        depth,
        specRefs: [],
        bodyLines: [],
        children: [],
      });
      continue;
    }

    // Check for spec reference comment
    const refMatch = line.match(/<!--\s*spec:(.+?)\s*-->/);
    if (refMatch) {
      const ref = refMatch[1];
      if (ref === 'overview') {
        inOverview = true;
        continue;
      }
      if (stack.length > 0) {
        stack[stack.length - 1].specRefs.push(ref);
      }
      continue;
    }

    // Accumulate body text
    if (inOverview) {
      overviewLines.push(line);
    } else if (stack.length > 0) {
      stack[stack.length - 1].bodyLines.push(line);
    }
  }

  // Finalize remaining stack
  while (stack.length > 0) {
    finalizeTop(stack, sections);
  }

  overview = overviewLines.join('\n').trim();

  return { title, overview, sections, specPath };
}

function finalizeTop(stack: Array<{ title: string; depth: number; specRefs: string[]; bodyLines: string[]; children: NarrativeSection[] }>, topLevel: NarrativeSection[]): void {
  const item = stack.pop()!;
  const section: NarrativeSection = {
    title: item.title,
    body: item.bodyLines.join('\n').trim(),
    specRefs: item.specRefs,
    children: item.children,
  };

  if (stack.length > 0) {
    stack[stack.length - 1].children.push(section);
  } else {
    topLevel.push(section);
  }
}
