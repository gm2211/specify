/**
 * src/agent/message-injector.ts — Async message queue for injecting
 * user messages into a running Agent SDK query() session.
 *
 * The Agent SDK accepts `prompt: string | AsyncIterable<SDKUserMessage>`.
 * This class implements AsyncIterable so we can feed the initial prompt
 * and then inject additional messages from humans or other agents.
 */

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

function makeUserMessage(text: string, priority: 'now' | 'next' | 'later' = 'next'): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    priority,
    session_id: '',
  };
}

export class MessageInjector implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waitResolve: (() => void) | null = null;
  private done = false;

  constructor(private initialPrompt: string) {}

  /** Inject a message into the running agent session. */
  inject(text: string, priority: 'now' | 'next' | 'later' = 'next'): void {
    if (this.done) return;
    this.queue.push(makeUserMessage(text, priority));
    if (this.waitResolve) {
      this.waitResolve();
      this.waitResolve = null;
    }
  }

  /** Signal that no more messages will be injected. */
  close(): void {
    this.done = true;
    if (this.waitResolve) {
      this.waitResolve();
      this.waitResolve = null;
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    // Yield the initial prompt first
    yield makeUserMessage(this.initialPrompt);

    // Then yield injected messages as they arrive
    while (!this.done) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else {
        // Wait for a new message or close signal
        await new Promise<void>((resolve) => {
          this.waitResolve = resolve;
        });
      }
    }

    // Drain remaining queue
    while (this.queue.length > 0) {
      yield this.queue.shift()!;
    }
  }
}
