/**
 * src/agent/memory-provider.ts — Pluggable interface over the learned-memory
 * store.
 *
 * The default implementation is file-backed and matches the existing on-disk
 * layout (`.specify/memory/<spec_id>/<target_key>.json`). Alternative
 * implementations (e.g. an MCP-bridged dialectic provider) can be wired in
 * without touching the agent loop.
 *
 * The interface is intentionally narrow:
 *   - read     : pull rows for a scope
 *   - write    : apply deltas + persist
 *   - prefetch : produce a prompt-ready summary string
 *   - shutdown : optional, for providers that hold resources
 */

import {
  applyDeltas,
  loadMemory,
  memoryPath,
  renderMemoryPrompt,
  saveMemory,
  targetKey as deriveTargetKey,
  type DeltaInput,
  type MemoryFile,
  type TargetDescriptor,
} from './memory.js';

export interface MemoryScope {
  specPath: string;
  specId: string;
  target: TargetDescriptor;
}

export function scopeTargetKey(scope: MemoryScope): string {
  return deriveTargetKey(scope.target);
}

export interface MemoryProvider {
  read(scope: MemoryScope): Promise<MemoryFile>;
  write(scope: MemoryScope, runId: string, deltas: DeltaInput[]): Promise<MemoryFile>;
  prefetch(scope: MemoryScope, budgetBytes?: number): Promise<string>;
  shutdown?(): Promise<void>;
}

export class FileBackedMemoryProvider implements MemoryProvider {
  private resolvePath(scope: MemoryScope): string {
    return memoryPath(scope.specPath, scope.specId, scope.target);
  }

  async read(scope: MemoryScope): Promise<MemoryFile> {
    return loadMemory(this.resolvePath(scope));
  }

  async write(scope: MemoryScope, runId: string, deltas: DeltaInput[]): Promise<MemoryFile> {
    const filePath = this.resolvePath(scope);
    const file = loadMemory(filePath);
    const next = applyDeltas(file, runId, deltas);
    saveMemory(filePath, next);
    return next;
  }

  async prefetch(scope: MemoryScope, budgetBytes?: number): Promise<string> {
    const file = await this.read(scope);
    return renderMemoryPrompt(file, budgetBytes);
  }
}

/**
 * Default provider used when the caller does not pass one explicitly. Tests
 * and alternate runtimes inject their own provider instead.
 */
export function defaultMemoryProvider(): MemoryProvider {
  return new FileBackedMemoryProvider();
}
