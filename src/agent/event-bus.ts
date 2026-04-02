/**
 * src/agent/event-bus.ts — Inter-agent event pub/sub
 *
 * Singleton EventEmitter-based bus that enables real-time communication
 * between the verify agent, CLI, review server, and external agents.
 * Events are also available over SSE/WebSocket via the review server.
 */

import { EventEmitter } from 'node:events';

export interface SpecifyEvent {
  type: string;
  timestamp: string;
  sessionId?: string;
  data: Record<string, unknown>;
}

const RING_BUFFER_SIZE = 100;

class SpecifyEventBus extends EventEmitter {
  private ring: SpecifyEvent[] = [];

  publish(event: SpecifyEvent): void {
    this.ring.push(event);
    if (this.ring.length > RING_BUFFER_SIZE) {
      this.ring.shift();
    }
    this.emit('event', event);
  }

  /** Convenience: build and publish an event in one call. */
  send(type: string, data: Record<string, unknown> = {}, sessionId?: string): void {
    this.publish({
      type,
      timestamp: new Date().toISOString(),
      sessionId,
      data,
    });
  }

  /** Get recent events (for late subscribers catching up). */
  recent(count?: number): SpecifyEvent[] {
    const n = count ?? RING_BUFFER_SIZE;
    return this.ring.slice(-n);
  }

  /** Subscribe to events of a specific type. Returns unsubscribe function. */
  on(type: string, listener: (event: SpecifyEvent) => void): this {
    return super.on(type, listener);
  }

  /** Subscribe to all events. Returns unsubscribe function. */
  onAny(listener: (event: SpecifyEvent) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }
}

/** Singleton event bus instance. */
export const eventBus = new SpecifyEventBus();
