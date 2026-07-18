/**
 * src/model/mutators.ts — Adversarial trace mutator library (SP-3fh).
 *
 * The walker (src/model/walker.ts) generates COVERAGE walks — sequences of
 * transitions that touch every state / arc / feasible arc-pair a learned
 * navigation map knows. Coverage finds MISSING transitions. It does NOT find
 * ORDERING bugs: legal-but-unusual sequences the app never intended a user to
 * perform. Those are a different bug class — back-button after leaving an
 * authenticated page, double-submit of a payment form, cookie-clear mid-flow,
 * re-opening a completed checkout, jumping straight to a mid-flow URL without
 * its prerequisites.
 *
 * This module is a FIXED library of deterministic, seeded mutation operators
 * that mechanically perturb walker-generated traces into those adversarial
 * variants. It encodes the classic web-flow attacks, not a search — each
 * operator is a small, named, independently-testable transform over a `Trace`.
 *
 * Every produced variant carries:
 *
 *   - its operator name + the seed + full provenance (source trace id, source
 *     model hash, spec/target) so a failure is reproducible byte-for-byte;
 *   - an expected-outcome CONTRACT (a `ContractClass` plus a data-only
 *     `ContractCheck`) that a downstream executor (SP-w5d) can assert against
 *     the observed network signature + page predicates — the same two signals
 *     the model already records. The contract makes the result ASSERTABLE
 *     rather than "run it and eyeball it";
 *   - a `wellFormed` marker distinguishing variants that remain a contiguous,
 *     directly-executable model path from variants that are INTENTIONALLY an
 *     illegal sequence whose only correct outcome is a graceful rejection /
 *     redirect. Conflating "the app rejected our illegal request" (correct)
 *     with "the app crashed" (a bug) is the whole point of the contract.
 *
 * Signals the operators read out of the model:
 *
 *   - WRITE arcs (double-submit / revisit contracts) are detected from the
 *     arc's recorded network signature: a non-GET method (POST/PUT/PATCH/
 *     DELETE) that reached the network is a side-effecting request.
 *   - AUTHENTICATED / TERMINAL / IN-SCOPE states come from a pluggable
 *     `FlowClassifier`. The default derives them from the model itself: an
 *     opt-in predicate bit marks authenticated pages, a sink (no outgoing
 *     arcs) is terminal, and every state is in scope. Callers wire spec area
 *     tags (auth/checkout) through `inScope` to focus mutation on the flows
 *     that matter. No signal ⇒ no mutation: an operator that finds no
 *     candidate simply emits nothing rather than fabricating one.
 *
 * Determinism: `mutateSuite` is a pure function of `(suite, model, options)`.
 * Each operator derives its own PRNG from the base seed folded with the
 * operator name and source trace id, so choices are independent of iteration
 * order — same inputs ⇒ byte-identical mutation suite. This module is pure and
 * browser-free; it templates step sequences, it does not execute anything.
 */

import type { NavModel, ModelState, NetworkSignatureEntry } from './nav-model.js';
import { arcKey } from './nav-model.js';
import type { Trace, WalkTransition, TraceSuite } from './walker.js';

// ---------------------------------------------------------------------------
// Operator identity + contracts
// ---------------------------------------------------------------------------

/** The fixed set of adversarial ordering operators this library encodes. */
export type MutationOperatorName =
  | 'back-nav-after-auth-exit'
  | 'double-submit'
  | 'session-clear-midflow'
  | 'revisit-after-terminal'
  | 'direct-url-skip-prereqs';

export const ALL_OPERATORS: MutationOperatorName[] = [
  'back-nav-after-auth-exit',
  'double-submit',
  'session-clear-midflow',
  'revisit-after-terminal',
  'direct-url-skip-prereqs',
];

/**
 * The expected-outcome class a mutation asserts. Named so a human reviewing a
 * failure knows what SHOULD have happened.
 */
export type ContractClass =
  /** A re-fired side-effecting request must not produce a second side effect. */
  | 'no-second-side-effect'
  /** Losing/using a stale session must redirect to login, never re-expose auth content. */
  | 'redirect-to-login-on-auth-loss'
  /** A terminal (completed) state must not be re-processed on revisit. */
  | 'terminal-state-not-reprocessable'
  /** Entering a mid-flow state without its prerequisites must be rejected/redirected. */
  | 'reject-or-redirect-on-missing-prereq';

/**
 * Whether the app is expected to TOLERATE the adversarial sequence (perform it
 * safely, with no bad side effect) or to REJECT it (redirect / error). Drift
 * (couldn't execute a step at all) is neither — the executor reports that
 * separately, per the epic's grounding-vs-assertion split.
 */
export type ExpectedOutcome = 'tolerate' | 'reject';

/**
 * A data-only, serializable assertion a downstream executor evaluates against
 * the observed run. Deliberately declarative (no functions) so it round-trips
 * through the persisted mutation artifact.
 */
export type ContractCheck =
  /**
   * The step at `injectedStepIndex` re-fires a side-effecting request; the
   * write signature `write` must NOT appear a second time (idempotent / deduped).
   */
  | { kind: 'no-repeated-write'; injectedStepIndex: number; write: NetworkSignatureEntry[] }
  /**
   * From `fromStepIndex` onward the session is invalid; any step that would
   * land on one of `authStates` must instead redirect to login (a 3xx) or land
   * on a non-authenticated page — never render authenticated content.
   */
  | { kind: 'expect-auth-redirect'; fromStepIndex: number; authStates: string[] }
  /**
   * The trace enters `target` directly without the `omittedPrerequisites`
   * arcs; the entry must be rejected or redirected away from `target`.
   */
  | { kind: 'expect-reject-or-redirect'; target: string; omittedPrerequisites: string[] };

/** The full expected-outcome contract attached to every mutated trace. */
export interface Contract {
  class: ContractClass;
  outcome: ExpectedOutcome;
  /** Human-readable statement of what should happen. */
  description: string;
  /** The machine-checkable assertion (network signatures + page predicates). */
  check: ContractCheck;
}

// ---------------------------------------------------------------------------
// Mutated step + trace types
// ---------------------------------------------------------------------------

/** A step lifted straight from the source walk — a real model arc. */
export interface ModelStep {
  kind: 'model';
  transition: WalkTransition;
}

/**
 * A step the operator INJECTED — a browser/CLI operation that is not a model
 * arc (a back-navigation, a direct goto, a cookie clear). Still executable;
 * just not something the learned map recorded as an edge.
 */
export interface SyntheticStep {
  kind: 'synthetic';
  /** The browser/CLI op, e.g. 'browser_back', 'browser_goto', 'browser_clear_cookies'. */
  action: string;
  /** Target urlTemplate for goto-style ops (absent for back/clear). */
  urlTemplate?: string;
  /** Best-effort state this step lands on, when known (for contract checking). */
  landsOn?: string;
  /** Why the operator injected this step. */
  note: string;
}

export type MutatedStep = ModelStep | SyntheticStep;

/** One adversarial variant of a source trace, with its reproducibility metadata. */
export interface MutatedTrace {
  /** Stable id: `${sourceTraceId}~${operator}~${ordinal}`. */
  id: string;
  operator: MutationOperatorName;
  /** Provenance: base seed the variant was produced under. */
  seed: number;
  /** Provenance: everything needed to regenerate this exact variant. */
  source: {
    traceId: string;
    modelHash: string;
    specId: string;
    targetKey: string;
  };
  /** State the variant starts from (may differ from the source when prereqs are skipped). */
  startState: string;
  startUrlTemplate: string;
  /** The perturbed step sequence. */
  steps: MutatedStep[];
  contract: Contract;
  /**
   * True marks a valid-if-unusual sequence the app is expected to TOLERATE and
   * execute normally (contract outcome 'tolerate') — e.g. a double-submit the
   * server should dedup, or a back-navigation that should stay safe. False
   * marks an INTENTIONALLY illegal sequence whose only correct outcome is the
   * contract's graceful rejection (outcome 'reject') — a session-cleared
   * continuation, a prerequisite-skipping direct entry. Mirrors
   * `contract.outcome`; kept as a top-level flag so a consumer can filter
   * tolerate-vs-reject expectations without reaching into the contract.
   */
  wellFormed: boolean;
}

/** A generated mutation suite plus provenance and an operator coverage matrix. */
export interface MutationSuite {
  version: 1;
  specId: string;
  targetKey: string;
  /** Provenance: hash of the model the source suite was generated from. */
  modelHash: string;
  /** Provenance: seed of the SOURCE walker suite. */
  sourceSeed: number;
  /** Provenance: seed used for mutation choices. */
  seed: number;
  /** Operators that were run. */
  operators: MutationOperatorName[];
  mutations: MutatedTrace[];
  /** Operator → number of variants emitted. The coverage matrix. */
  operatorCounts: Record<MutationOperatorName, number>;
}

// ---------------------------------------------------------------------------
// Flow classifier — the auth/terminal/scope signals
// ---------------------------------------------------------------------------

/**
 * Classifies model states for the operators that need semantic signal beyond
 * raw graph structure. All methods MUST be deterministic. Callers wire spec
 * area tags (auth/checkout) into `inScope` to focus mutation.
 */
export interface FlowClassifier {
  /** Is this page behind authentication? */
  isAuthenticated(state: ModelState): boolean;
  /** Is this a terminal (completed) state — e.g. an order-confirmation page? */
  isTerminal(state: ModelState, model: NavModel): boolean;
  /** Is this state in a flow worth mutating? Default: every state. */
  inScope(state: ModelState): boolean;
}

export interface DefaultClassifierOptions {
  /** Predicate bit that marks an authenticated page. Default 'authenticated'. */
  authPredicateKey?: string;
  /**
   * Predicate bit that marks a terminal page. Default 'terminal'. A state is
   * also terminal when it is a sink (has no outgoing arcs).
   */
  terminalPredicateKey?: string;
  /** Restrict mutation to these state ids (spec-tag scoping). Default: all. */
  inScopeStateIds?: Set<string>;
}

/**
 * The default classifier, derived from the model itself: an opt-in predicate
 * bit marks authenticated / terminal pages, and a sink state is terminal. With
 * no predicates and no scope set, only the sink-terminal signal fires — so the
 * auth-dependent operators emit nothing until a caller supplies real signal.
 */
export function defaultFlowClassifier(
  model: NavModel,
  opts: DefaultClassifierOptions = {},
): FlowClassifier {
  const authKey = opts.authPredicateKey ?? 'authenticated';
  const terminalKey = opts.terminalPredicateKey ?? 'terminal';
  const outDegree = new Map<string, number>();
  for (const tr of model.transitions) {
    outDegree.set(tr.from, (outDegree.get(tr.from) ?? 0) + tr.targets.length);
  }
  const scope = opts.inScopeStateIds;
  return {
    isAuthenticated: (state) => state.predicates[authKey] === true,
    isTerminal: (state) => state.predicates[terminalKey] === true || (outDegree.get(state.id) ?? 0) === 0,
    inScope: (state) => (scope ? scope.has(state.id) : true),
  };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MutatorOptions {
  /** Seed for mutation choices. Default: the source suite's seed. */
  seed?: number;
  /** Operators to run. Default: all. */
  operators?: MutationOperatorName[];
  /** Semantic-signal classifier. Default: {@link defaultFlowClassifier}. */
  classifier?: FlowClassifier;
  /**
   * Max variants a single operator emits per source trace. When a trace offers
   * more candidate injection points, a seeded sample of this many is taken.
   * Default 4.
   */
  maxVariantsPerOperator?: number;
}

const DEFAULT_MAX_VARIANTS = 4;

/** HTTP methods that carry a side effect — a "write". */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32 (repo convention; see walker.ts / fault-injector.ts).
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** djb2 string hash, for folding operator name + trace id into a seed. */
function strHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

/**
 * Derive an operator's per-trace PRNG so choices are independent of the order
 * traces/operators are visited: same (seed, operator, trace) ⇒ same stream.
 */
function operatorRng(seed: number, operator: string, traceId: string): () => number {
  return mulberry32((seed ^ strHash(`${operator} ${traceId}`)) >>> 0);
}

/**
 * Deterministically take up to `n` items from `items`. Under the cap, returns
 * all in the given order; over the cap, seeded-shuffles a copy and slices,
 * then restores the original relative order for a stable emission sequence.
 */
function sample<T>(items: T[], n: number, rng: () => number): T[] {
  if (items.length <= n) return items;
  const idx = items.map((_, i) => i);
  // Fisher–Yates with the seeded PRNG.
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const chosen = idx.slice(0, n).sort((a, b) => a - b);
  return chosen.map((i) => items[i]);
}

// ---------------------------------------------------------------------------
// Model index — the signals operators query
// ---------------------------------------------------------------------------

interface ModelIndex {
  stateById: Map<string, ModelState>;
  urlOf: (id: string) => string;
  /** arcKey → the arc's deduped network signature. */
  signatureOf: Map<string, NetworkSignatureEntry[]>;
}

function indexModel(model: NavModel): ModelIndex {
  const stateById = new Map(model.states.map((s) => [s.id, s]));
  const signatureOf = new Map<string, NetworkSignatureEntry[]>();
  for (const tr of model.transitions) {
    for (const t of tr.targets) {
      signatureOf.set(arcKey(tr.from, tr.actionKey, t.to), t.networkSignature);
    }
  }
  return {
    stateById,
    urlOf: (id) => stateById.get(id)?.urlTemplate ?? id,
    signatureOf,
  };
}

/** The subset of an arc's network signature that is a side-effecting write. */
function writeEntriesOf(index: ModelIndex, arc: string): NetworkSignatureEntry[] {
  const sig = index.signatureOf.get(arc) ?? [];
  return sig.filter((e) => WRITE_METHODS.has(e.method.toUpperCase()));
}

function isWriteArc(index: ModelIndex, arc: string): boolean {
  return writeEntriesOf(index, arc).length > 0;
}

// ---------------------------------------------------------------------------
// Operator machinery
// ---------------------------------------------------------------------------

/** Everything an operator needs: the model, its index, the classifier, and options. */
interface OperatorContext {
  model: NavModel;
  index: ModelIndex;
  classifier: FlowClassifier;
  seed: number;
  maxVariants: number;
  source: MutatedTrace['source'];
}

type MutationOperator = (trace: Trace, ctx: OperatorContext) => MutatedTrace[];

const modelStep = (transition: WalkTransition): ModelStep => ({ kind: 'model', transition });

function isAuthState(ctx: OperatorContext, stateId: string): boolean {
  const st = ctx.index.stateById.get(stateId);
  return st ? ctx.classifier.isAuthenticated(st) : false;
}

function inScope(ctx: OperatorContext, stateId: string): boolean {
  const st = ctx.index.stateById.get(stateId);
  return st ? ctx.classifier.inScope(st) : false;
}

// --- back-nav-after-auth-exit ----------------------------------------------
// After a transition that leaves an authenticated state (from auth → non-auth,
// i.e. a logout-shaped step), inject a back-navigation to the auth page. The
// app must NOT re-expose authenticated content from the browser cache.
const backNavAfterAuthExit: MutationOperator = (trace, ctx) => {
  const rng = operatorRng(ctx.seed, 'back-nav-after-auth-exit', trace.id);
  const candidates: number[] = [];
  for (let i = 0; i < trace.transitions.length; i++) {
    const t = trace.transitions[i];
    if (!inScope(ctx, t.from)) continue;
    if (isAuthState(ctx, t.from) && !isAuthState(ctx, t.to)) candidates.push(i);
  }
  return sample(candidates, ctx.maxVariants, rng).map((i, ord) => {
    const exit = trace.transitions[i];
    const steps: MutatedStep[] = [];
    for (let k = 0; k <= i; k++) steps.push(modelStep(trace.transitions[k]));
    const backStep: SyntheticStep = {
      kind: 'synthetic',
      action: 'browser_back',
      landsOn: exit.from,
      note: `back-navigation to authenticated page ${exit.fromUrlTemplate} after leaving it`,
    };
    steps.push(backStep);
    for (let k = i + 1; k < trace.transitions.length; k++) steps.push(modelStep(trace.transitions[k]));
    return {
      id: `${trace.id}~back-nav-after-auth-exit~${ord}`,
      operator: 'back-nav-after-auth-exit',
      seed: ctx.seed,
      source: ctx.source,
      startState: trace.startState,
      startUrlTemplate: trace.startUrlTemplate,
      steps,
      contract: {
        class: 'redirect-to-login-on-auth-loss',
        outcome: 'tolerate',
        description: `Pressing back to ${exit.fromUrlTemplate} after leaving the authenticated area must not re-render authenticated content; expect a login redirect or a non-authenticated page.`,
        check: {
          kind: 'expect-auth-redirect',
          fromStepIndex: i + 1,
          authStates: [exit.from],
        },
      },
      // A back-navigation to a page just left is a valid-if-unusual browser
      // action the app should tolerate safely.
      wellFormed: true,
    };
  });
};

// --- double-submit ---------------------------------------------------------
// Re-fire a side-effecting (write) transition immediately. The second fire
// must produce no second side effect (idempotency / server-side dedup).
const doubleSubmit: MutationOperator = (trace, ctx) => {
  const rng = operatorRng(ctx.seed, 'double-submit', trace.id);
  const candidates: number[] = [];
  for (let i = 0; i < trace.transitions.length; i++) {
    const t = trace.transitions[i];
    if (inScope(ctx, t.from) && isWriteArc(ctx.index, t.arc)) candidates.push(i);
  }
  return sample(candidates, ctx.maxVariants, rng).map((i, ord) => {
    const dup = trace.transitions[i];
    const steps: MutatedStep[] = [];
    for (let k = 0; k <= i; k++) steps.push(modelStep(trace.transitions[k]));
    // Fire the same write a second time, back-to-back.
    steps.push(modelStep(dup));
    for (let k = i + 1; k < trace.transitions.length; k++) steps.push(modelStep(trace.transitions[k]));
    const write = writeEntriesOf(ctx.index, dup.arc);
    return {
      id: `${trace.id}~double-submit~${ord}`,
      operator: 'double-submit',
      seed: ctx.seed,
      source: ctx.source,
      startState: trace.startState,
      startUrlTemplate: trace.startUrlTemplate,
      steps,
      contract: {
        class: 'no-second-side-effect',
        outcome: 'tolerate',
        description: `Re-submitting ${dup.actionKey} on ${dup.fromUrlTemplate} must not repeat its write; expect the second fire to be deduped (no repeated ${write.map((w) => w.method).join('/')} 2xx).`,
        check: { kind: 'no-repeated-write', injectedStepIndex: i + 1, write },
      },
      // A re-submit is a valid-if-unusual action the server should dedup.
      wellFormed: true,
    };
  });
};

// --- session-clear-midflow -------------------------------------------------
// Clear cookies/session partway through, then continue the walk. Any later
// step that would land on an authenticated page must now redirect to login.
const sessionClearMidflow: MutationOperator = (trace, ctx) => {
  const rng = operatorRng(ctx.seed, 'session-clear-midflow', trace.id);
  const n = trace.transitions.length;
  const candidates: number[] = [];
  // Insert after transition i (0..n-2); there must be a later step that lands
  // on an authenticated page for the clear to have an assertable effect.
  for (let i = 0; i < n - 1; i++) {
    if (!inScope(ctx, trace.transitions[i].to)) continue;
    const laterAuth = trace.transitions.slice(i + 1).some((t) => isAuthState(ctx, t.to));
    if (laterAuth) candidates.push(i);
  }
  return sample(candidates, ctx.maxVariants, rng).map((i, ord) => {
    const steps: MutatedStep[] = [];
    for (let k = 0; k <= i; k++) steps.push(modelStep(trace.transitions[k]));
    const clearStep: SyntheticStep = {
      kind: 'synthetic',
      action: 'browser_clear_cookies',
      landsOn: trace.transitions[i].to,
      note: `clear session cookies mid-flow at ${trace.transitions[i].toUrlTemplate}`,
    };
    steps.push(clearStep);
    for (let k = i + 1; k < n; k++) steps.push(modelStep(trace.transitions[k]));
    const authStates = [
      ...new Set(trace.transitions.slice(i + 1).map((t) => t.to).filter((s) => isAuthState(ctx, s))),
    ].sort();
    return {
      id: `${trace.id}~session-clear-midflow~${ord}`,
      operator: 'session-clear-midflow',
      seed: ctx.seed,
      source: ctx.source,
      startState: trace.startState,
      startUrlTemplate: trace.startUrlTemplate,
      steps,
      contract: {
        class: 'redirect-to-login-on-auth-loss',
        outcome: 'reject',
        description: `After clearing the session at ${trace.transitions[i].toUrlTemplate}, continuing into an authenticated page must redirect to login, not serve stale authenticated content.`,
        check: { kind: 'expect-auth-redirect', fromStepIndex: i + 2, authStates },
      },
      wellFormed: false,
    };
  });
};

// --- revisit-after-terminal ------------------------------------------------
// After the walk reaches a terminal (completed) state, re-enter it directly.
// Re-opening a completed flow must not re-process it (no second charge).
const revisitAfterTerminal: MutationOperator = (trace, ctx) => {
  const rng = operatorRng(ctx.seed, 'revisit-after-terminal', trace.id);
  const candidates: number[] = [];
  for (let i = 0; i < trace.transitions.length; i++) {
    const t = trace.transitions[i];
    const st = ctx.index.stateById.get(t.to);
    if (st && ctx.classifier.inScope(st) && ctx.classifier.isTerminal(st, ctx.model)) {
      candidates.push(i);
    }
  }
  return sample(candidates, ctx.maxVariants, rng).map((i, ord) => {
    const arrival = trace.transitions[i];
    const steps: MutatedStep[] = [];
    for (let k = 0; k <= i; k++) steps.push(modelStep(trace.transitions[k]));
    const revisit: SyntheticStep = {
      kind: 'synthetic',
      action: 'browser_goto',
      urlTemplate: arrival.toUrlTemplate,
      landsOn: arrival.to,
      note: `re-enter terminal state ${arrival.toUrlTemplate} after completing it`,
    };
    steps.push(revisit);
    const write = writeEntriesOf(ctx.index, arrival.arc);
    const reprocesses = write.length > 0;
    return {
      id: `${trace.id}~revisit-after-terminal~${ord}`,
      operator: 'revisit-after-terminal',
      seed: ctx.seed,
      source: ctx.source,
      startState: trace.startState,
      startUrlTemplate: trace.startUrlTemplate,
      steps,
      contract: reprocesses
        ? {
            class: 'terminal-state-not-reprocessable',
            outcome: 'tolerate',
            description: `Re-opening completed ${arrival.toUrlTemplate} must not re-run its side effect (${write.map((w) => w.method).join('/')}); expect an already-complete view, not a repeated write.`,
            check: { kind: 'no-repeated-write', injectedStepIndex: i + 1, write },
          }
        : {
            class: 'terminal-state-not-reprocessable',
            outcome: 'reject',
            description: `Re-opening completed ${arrival.toUrlTemplate} must not restart the flow; expect a redirect away or an already-complete view.`,
            check: { kind: 'expect-reject-or-redirect', target: arrival.to, omittedPrerequisites: [] },
          },
      // Re-opening a completed page that re-issued a write is a tolerate case
      // (must not re-charge); one with no write should redirect away (reject).
      wellFormed: reprocesses,
    };
  });
};

// --- direct-url-skip-prereqs -----------------------------------------------
// Jump straight to a mid-flow state's URL, omitting the transitions that
// normally reach it. Entering without prerequisites must be rejected/redirected.
const directUrlSkipPrereqs: MutationOperator = (trace, ctx) => {
  const rng = operatorRng(ctx.seed, 'direct-url-skip-prereqs', trace.id);
  const n = trace.transitions.length;
  // A mid state is transitions[j-1].to for j in 1..n (reached after >=1 prereq).
  // Skip the tail-less final landing only if it has no continuation (still a
  // valid target). We require at least one omitted prerequisite (j>=1).
  const candidates: number[] = [];
  for (let j = 1; j <= n; j++) {
    const mid = trace.transitions[j - 1].to;
    if (inScope(ctx, mid)) candidates.push(j);
  }
  return sample(candidates, ctx.maxVariants, rng).map((j, ord) => {
    const mid = trace.transitions[j - 1].to;
    const omitted = trace.transitions.slice(0, j).map((t) => t.arc);
    const tail = trace.transitions.slice(j).map((t) => modelStep(t));
    return {
      id: `${trace.id}~direct-url-skip-prereqs~${ord}`,
      operator: 'direct-url-skip-prereqs',
      seed: ctx.seed,
      source: ctx.source,
      // The variant STARTS at the mid state (the direct goto), skipping prereqs.
      startState: mid,
      startUrlTemplate: ctx.index.urlOf(mid),
      steps: tail,
      contract: {
        class: 'reject-or-redirect-on-missing-prereq',
        outcome: 'reject',
        description: `Navigating directly to ${ctx.index.urlOf(mid)} without its ${omitted.length} prerequisite step(s) must be rejected or redirected to the flow's entry.`,
        check: { kind: 'expect-reject-or-redirect', target: mid, omittedPrerequisites: omitted },
      },
      // The tail is a contiguous model path, but the ENTRY skips prerequisites,
      // so the sequence as a whole is intentionally not a legal walk.
      wellFormed: false,
    };
  });
};

/** The operator registry — name → transform. */
export const MUTATION_OPERATORS: Record<MutationOperatorName, MutationOperator> = {
  'back-nav-after-auth-exit': backNavAfterAuthExit,
  'double-submit': doubleSubmit,
  'session-clear-midflow': sessionClearMidflow,
  'revisit-after-terminal': revisitAfterTerminal,
  'direct-url-skip-prereqs': directUrlSkipPrereqs,
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Perturb a walker trace suite into an adversarial mutation suite. Pure and
 * deterministic given `(suite, model, options)`. Each requested operator is
 * applied to every source trace; a trace that offers no candidate for an
 * operator simply yields nothing for it.
 */
export function mutateSuite(
  suite: TraceSuite,
  model: NavModel,
  options: MutatorOptions = {},
): MutationSuite {
  const seed = options.seed ?? suite.seed;
  const operators = options.operators ?? ALL_OPERATORS;
  const classifier = options.classifier ?? defaultFlowClassifier(model);
  const maxVariants = options.maxVariantsPerOperator ?? DEFAULT_MAX_VARIANTS;
  const index = indexModel(model);
  const source = {
    // filled per trace below
    traceId: '',
    modelHash: suite.modelHash,
    specId: suite.specId,
    targetKey: suite.targetKey,
  };

  const mutations: MutatedTrace[] = [];
  const operatorCounts = Object.fromEntries(
    ALL_OPERATORS.map((op) => [op, 0]),
  ) as Record<MutationOperatorName, number>;

  // Traces in emission order; operators in the requested (or canonical) order.
  const orderedOps = ALL_OPERATORS.filter((op) => operators.includes(op));
  for (const trace of suite.traces) {
    for (const op of orderedOps) {
      const ctx: OperatorContext = {
        model,
        index,
        classifier,
        seed,
        maxVariants,
        source: { ...source, traceId: trace.id },
      };
      const produced = MUTATION_OPERATORS[op](trace, ctx);
      operatorCounts[op] += produced.length;
      mutations.push(...produced);
    }
  }

  return {
    version: 1,
    specId: suite.specId,
    targetKey: suite.targetKey,
    modelHash: suite.modelHash,
    sourceSeed: suite.seed,
    seed,
    operators: orderedOps,
    mutations,
    operatorCounts,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** One-line human summary of a mutation suite, for a CLI/report footer. */
export function renderMutationSummary(suite: MutationSuite): string {
  const parts = suite.operators
    .map((op) => `${op} ${suite.operatorCounts[op]}`)
    .join(', ');
  return `Mutation suite: ${suite.mutations.length} variant${
    suite.mutations.length === 1 ? '' : 's'
  } [${parts}]`;
}

/**
 * The step actions of a mutated trace, in order — the substrate SP-w5d lowers
 * to an executable script. Model steps contribute their recipe action;
 * synthetic steps contribute their injected action.
 */
export function mutatedStepActions(mutated: MutatedTrace): string[] {
  return mutated.steps.map((s) => (s.kind === 'model' ? s.transition.recipe.action : s.action));
}
