import type { OpenSpecScan } from './openspec.js';

export type PolicyRule = 'unlinked' | 'waived-with-links' | 'no-before' | 'no-verify';

export interface PolicyFinding {
  rule: PolicyRule;
  requirementId: string;
  message: string;
  /** Set when the finding is about an active OpenSpec change's version of the requirement. */
  change?: string;
}

/**
 * Coverage policy over the scanned specs:
 * - every requirement has a `Formal:` link or a `Formal: none (reason)` waiver, not both;
 * - every Quint property expected to hold has a link to the same property with `expect=fails`;
 * - every requirement with a formal link names a test with `Verify:`.
 */
export function evaluatePolicy(scan: OpenSpecScan): PolicyFinding[] {
  const findings: PolicyFinding[] = [];
  const waived = new Set(scan.waivers.map((waiver) => waiver.requirementId));
  const verified = new Set(scan.verifies.map((verify) => verify.requirementId));
  for (const requirementId of scan.requirementIds) {
    const references = scan.references.filter((ref) => ref.requirementId === requirementId);
    if (!references.length) {
      if (!waived.has(requirementId)) {
        findings.push({
          rule: 'unlinked',
          requirementId,
          message: 'no Formal link and no waiver; add a link or "Formal: none (reason)"',
        });
      }
      continue;
    }
    if (waived.has(requirementId)) {
      findings.push({
        rule: 'waived-with-links',
        requirementId,
        message: 'has both a waiver and Formal links; remove one',
      });
    }
    const checks = references.flatMap((ref) => (ref.check ? [ref.check] : []));
    const quint = checks.flatMap((check) => (check.tool === 'quint' ? [check] : []));
    const mustFail = new Set(
      quint.filter((check) => check.expect === 'fails').map((check) => check.property),
    );
    const unguarded = new Set(
      quint
        .filter((check) => check.expect === 'holds' && !mustFail.has(check.property))
        .map((check) => check.property),
    );
    for (const property of unguarded) {
      findings.push({
        rule: 'no-before',
        requirementId,
        message: `${property} has no expect=fails link, so nothing shows it can fail; link a before model or mutation`,
      });
    }
    if (checks.length && !verified.has(requirementId)) {
      findings.push({
        rule: 'no-verify',
        requirementId,
        message: 'no Verify line ties its model to a test; add "Verify: test <test name>"',
      });
    }
  }
  return findings;
}
