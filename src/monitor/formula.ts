/**
 * src/monitor/formula.ts — Finite-trace linear temporal logic (LTLf) formula AST.
 *
 * This is the correctness-critical core of a deterministic trace-monitor tier:
 * plain-language spec behaviors get compiled (in a later bead) into finite-trace
 * temporal-logic formulas that are evaluated over recorded run traces.
 *
 * The AST is a discriminated union on `op`. It covers the FUTURE-ONLY fragment of
 * LTL — no past operators (Y/O/S/H). Offline evaluation over a complete finite
 * trace makes the future-only fragment strictly sufficient: any past-time property
 * can be re-expressed against the recorded prefix without a past modality.
 *
 * Operators:
 *   pred     — atomic proposition, optionally parameterised by string args.
 *   not      — negation.
 *   and / or — n-ary conjunction / disjunction.
 *   implies  — material implication (left -> right).
 *   X        — strong next (there IS a next position and arg holds there).
 *   F        — eventually (finally).
 *   G        — always (globally).
 *   U        — strong until (left holds until right, and right must occur).
 */

import Ajv from 'ajv';

/** Atomic proposition. `name` is the predicate name, `args` optional string parameters. */
export interface PredFormula {
  op: 'pred';
  name: string;
  args?: string[];
}

export interface NotFormula {
  op: 'not';
  arg: Formula;
}

export interface AndFormula {
  op: 'and';
  args: Formula[];
}

export interface OrFormula {
  op: 'or';
  args: Formula[];
}

export interface ImpliesFormula {
  op: 'implies';
  left: Formula;
  right: Formula;
}

export interface NextFormula {
  op: 'X';
  arg: Formula;
}

export interface EventuallyFormula {
  op: 'F';
  arg: Formula;
}

export interface GloballyFormula {
  op: 'G';
  arg: Formula;
}

export interface UntilFormula {
  op: 'U';
  left: Formula;
  right: Formula;
}

/** Discriminated-union AST for a future-only LTLf formula. */
export type Formula =
  | PredFormula
  | NotFormula
  | AndFormula
  | OrFormula
  | ImpliesFormula
  | NextFormula
  | EventuallyFormula
  | GloballyFormula
  | UntilFormula;

// --- Constructor helpers (ergonomic, keep test / caller code readable) --------

export const pred = (name: string, args?: string[]): PredFormula =>
  args && args.length > 0 ? { op: 'pred', name, args } : { op: 'pred', name };
export const not = (arg: Formula): NotFormula => ({ op: 'not', arg });
export const and = (...args: Formula[]): AndFormula => ({ op: 'and', args });
export const or = (...args: Formula[]): OrFormula => ({ op: 'or', args });
export const implies = (left: Formula, right: Formula): ImpliesFormula => ({
  op: 'implies',
  left,
  right,
});
export const next = (arg: Formula): NextFormula => ({ op: 'X', arg });
export const eventually = (arg: Formula): EventuallyFormula => ({ op: 'F', arg });
export const globally = (arg: Formula): GloballyFormula => ({ op: 'G', arg });
export const until = (left: Formula, right: Formula): UntilFormula => ({
  op: 'U',
  left,
  right,
});

// --- Pretty-printer -----------------------------------------------------------

/** Ops whose rendering already carries surrounding parentheses. */
function isBracketed(f: Formula): boolean {
  return f.op === 'and' || f.op === 'or' || f.op === 'implies' || f.op === 'U';
}

function renderUnary(symbol: string, arg: Formula): string {
  const inner = render(arg);
  // If the argument already renders with its own brackets, reuse them:
  //   G + "(a -> b)"  =>  "G(a -> b)"   rather than  "G((a -> b))".
  return isBracketed(arg) ? `${symbol}${inner}` : `${symbol}(${inner})`;
}

/**
 * Render a formula to an unambiguous, readable string.
 *
 * Examples:
 *   G(pred:click(#login) -> F(pred:resp(/api/session, 200)))
 *   (pred:a & pred:b)
 *   !(pred:x)
 *   (pred:p U pred:q)
 */
export function render(f: Formula): string {
  switch (f.op) {
    case 'pred':
      return f.args && f.args.length > 0
        ? `pred:${f.name}(${f.args.join(', ')})`
        : `pred:${f.name}`;
    case 'not':
      return renderUnary('!', f.arg);
    case 'and':
      return `(${f.args.map((a) => render(a)).join(' & ')})`;
    case 'or':
      return `(${f.args.map((a) => render(a)).join(' | ')})`;
    case 'implies':
      return `(${render(f.left)} -> ${render(f.right)})`;
    case 'X':
      return renderUnary('X', f.arg);
    case 'F':
      return renderUnary('F', f.arg);
    case 'G':
      return renderUnary('G', f.arg);
    case 'U':
      return `(${render(f.left)} U ${render(f.right)})`;
  }
}

// --- JSON Schema (recursive, ajv $ref) ----------------------------------------
//
// Follows the definitions/$ref style used by src/spec/schema.ts. The recursive
// reference `#/definitions/formula` lets a single schema validate arbitrarily
// deep ASTs.

export const formulaSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'LTLf Formula',
  description: 'Future-only finite-trace linear temporal logic formula AST.',
  $ref: '#/definitions/formula',
  definitions: {
    formula: {
      oneOf: [
        { $ref: '#/definitions/pred' },
        { $ref: '#/definitions/not' },
        { $ref: '#/definitions/and' },
        { $ref: '#/definitions/or' },
        { $ref: '#/definitions/implies' },
        { $ref: '#/definitions/unaryTemporal' },
        { $ref: '#/definitions/until' },
      ],
    },
    pred: {
      type: 'object',
      required: ['op', 'name'],
      additionalProperties: false,
      properties: {
        op: { const: 'pred' },
        name: { type: 'string', minLength: 1 },
        args: { type: 'array', items: { type: 'string' } },
      },
    },
    not: {
      type: 'object',
      required: ['op', 'arg'],
      additionalProperties: false,
      properties: {
        op: { const: 'not' },
        arg: { $ref: '#/definitions/formula' },
      },
    },
    and: {
      type: 'object',
      required: ['op', 'args'],
      additionalProperties: false,
      properties: {
        op: { const: 'and' },
        args: { type: 'array', minItems: 1, items: { $ref: '#/definitions/formula' } },
      },
    },
    or: {
      type: 'object',
      required: ['op', 'args'],
      additionalProperties: false,
      properties: {
        op: { const: 'or' },
        args: { type: 'array', minItems: 1, items: { $ref: '#/definitions/formula' } },
      },
    },
    implies: {
      type: 'object',
      required: ['op', 'left', 'right'],
      additionalProperties: false,
      properties: {
        op: { const: 'implies' },
        left: { $ref: '#/definitions/formula' },
        right: { $ref: '#/definitions/formula' },
      },
    },
    unaryTemporal: {
      type: 'object',
      required: ['op', 'arg'],
      additionalProperties: false,
      properties: {
        op: { enum: ['X', 'F', 'G'] },
        arg: { $ref: '#/definitions/formula' },
      },
    },
    until: {
      type: 'object',
      required: ['op', 'left', 'right'],
      additionalProperties: false,
      properties: {
        op: { const: 'U' },
        left: { $ref: '#/definitions/formula' },
        right: { $ref: '#/definitions/formula' },
      },
    },
  },
} as const;

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(formulaSchema);

export interface FormulaValidation {
  valid: boolean;
  errors: string[];
}

/** Validate an unknown value against the formula schema. */
export function validateFormula(value: unknown): FormulaValidation {
  const valid = validate(value) as boolean;
  const errors = valid
    ? []
    : (validate.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`);
  return { valid, errors };
}

/** Narrowing helper: assert a value is a well-formed Formula. */
export function isFormula(value: unknown): value is Formula {
  return validateFormula(value).valid;
}
