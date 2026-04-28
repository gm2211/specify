import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { eventBus } from './event-bus.js';
import { MessageInjector } from './message-injector.js';
import {
  renderPropagationMessage,
  setActivePropagator,
  _internal_state,
} from './pattern-propagator.js';

test('renderPropagationMessage: surfaces user text + scope', () => {
  const m = renderPropagationMessage('check empty state on search bars', '(forms/search)');
  assert.match(m, /user pattern feedback/);
  assert.match(m, /\(forms\/search\)/);
  assert.match(m, /check empty state/);
  assert.match(m, /siblings/);
});

test('setActivePropagator: subscribes when injector set, detaches when cleared', () => {
  const injector = new MessageInjector('seed');
  setActivePropagator(injector);
  assert.deepEqual(_internal_state(), { hasInjector: true, subscribed: true });
  setActivePropagator(null);
  assert.deepEqual(_internal_state(), { hasInjector: false, subscribed: false });
});

test('propagator injects when feedback:propagate_pattern fires', async () => {
  const injector = new MessageInjector('seed');
  const seen: string[] = [];

  // Capture queue inspection hook: monkey-patch inject for the test
  const origInject = injector.inject.bind(injector);
  (injector as unknown as { inject: (t: string) => void }).inject = (text: string): void => {
    seen.push(text);
    origInject(text);
  };

  setActivePropagator(injector);
  try {
    eventBus.send('feedback:propagate_pattern', {
      text: 'always check keyboard nav on submit buttons',
      areaId: 'forms',
      behaviorId: 'submit',
    }, 'ses_xx');
    // Sync emit: listener runs synchronously on emit; allow microtask flush.
    await Promise.resolve();
  } finally {
    setActivePropagator(null);
  }

  assert.equal(seen.length, 1);
  assert.match(seen[0], /keyboard nav/);
  assert.match(seen[0], /forms\/submit/);
});

test('propagator no-op when no injector is set', () => {
  // Should not throw even when no propagator is active.
  setActivePropagator(null);
  eventBus.send('feedback:propagate_pattern', { text: 'ignored', areaId: null, behaviorId: null });
  // Nothing to assert beyond "did not throw".
  assert.ok(true);
});
