/**
 * Feature gates for speculative agent surfaces.
 *
 * Defaults should keep the public API small. Opt-in flags make experimental
 * loops available without advertising them in every run.
 */

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function envFlag(name: string): boolean {
  const raw = process.env[name];
  return raw ? TRUE_VALUES.has(raw.trim().toLowerCase()) : false;
}

export function learnedSkillsEnabled(): boolean {
  return envFlag('SPECIFY_ENABLE_LEARNED_SKILLS');
}
