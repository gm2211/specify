/**
 * src/agent/pattern-propagator.ts — In-session sibling-check propagation.
 *
 * When the user flags a pattern with kind=important_pattern (e.g. "always
 * check empty state on this form"), feedback.ts emits a
 * `feedback:propagate_pattern` event. This module subscribes to that event
 * and injects a follow-up user message into the running agent session
 * directing the agent to apply the same check to siblings.
 *
 * "Siblings" is intentionally fuzzy here — the agent decides what siblings
 * means in the current spec context (other forms, other CRUD endpoints,
 * other navigation links, etc.). The propagator just hands the agent the
 * pattern with a clear directive; the agent does the discovery.
 *
 * The injector reference is set when a verify run starts (via
 * `setActivePropagator`) and cleared on session end. Without an active
 * injector, the event is simply ignored.
 */

import { eventBus, type SpecifyEvent } from './event-bus.js';
import type { MessageInjector } from './message-injector.js';

let activeInjector: MessageInjector | null = null;
let detach: (() => void) | null = null;

export function setActivePropagator(injector: MessageInjector | null): void {
  activeInjector = injector;
  if (injector && !detach) {
    const listener = (e: SpecifyEvent): void => {
      if (e.type !== 'feedback:propagate_pattern') return;
      const text = (e.data?.text as string | undefined) ?? '';
      if (!text.trim()) return;
      const areaId = (e.data?.areaId as string | null | undefined) ?? null;
      const behaviorId = (e.data?.behaviorId as string | null | undefined) ?? null;
      const scope = areaId || behaviorId
        ? `(${areaId ?? '?'}/${behaviorId ?? '?'})`
        : '';
      const message = renderPropagationMessage(text, scope);
      try {
        activeInjector?.inject(message, 'next');
      } catch {
        // Injection is best-effort; don't crash the listener.
      }
    };
    eventBus.on('event', listener);
    detach = () => eventBus.off('event', listener);
  } else if (!injector && detach) {
    detach();
    detach = null;
  }
}

export function renderPropagationMessage(text: string, scope: string): string {
  return [
    `[user pattern feedback ${scope}]`,
    `The user flagged the following as an important pattern they want checked everywhere applicable:`,
    '',
    `> ${text.trim()}`,
    '',
    `Identify other elements/behaviors in the current spec that match this pattern (siblings: similar forms, similar endpoints, similar navigation, etc.) and apply the same check to each. Report findings inline as you go. If the pattern only applies to the original element, say so and move on.`,
  ].join('\n');
}

/** Test seam: snapshot of the active state. */
export function _internal_state(): { hasInjector: boolean; subscribed: boolean } {
  return { hasInjector: !!activeInjector, subscribed: !!detach };
}
