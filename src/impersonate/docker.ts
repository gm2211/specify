/**
 * src/impersonate/docker.ts — Docker container management for MockServer
 *
 * Manages the MockServer Docker container lifecycle using child_process
 * (no dockerode dependency). Provides health checking, expectation loading,
 * and cleanup.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type { MockServerExpectation } from './types.js';

const execAsync = promisify(exec);

/** Check whether the Docker daemon is available and responsive. */
export async function checkDockerAvailable(): Promise<boolean> {
  try {
    await execAsync('docker info', { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll a URL until it responds successfully or the timeout expires.
 * Returns true if the endpoint became available, false on timeout.
 */
async function waitForHealth(url: string, timeoutMs: number, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return false;
}

/**
 * Start a MockServer Docker container on the given port.
 *
 * Runs `docker run -d -p {port}:1080 mockserver/mockserver:latest` and
 * waits up to 15 seconds for the health endpoint to respond. If the
 * health check fails, the container is stopped and removed, and an
 * error is thrown.
 *
 * @returns The container ID
 */
export async function startMockServer(port: number): Promise<string> {
  const { stdout } = await execAsync(
    `docker run -d -p ${port}:1080 mockserver/mockserver:latest`,
    { timeout: 60_000 },
  );
  const containerId = stdout.trim();

  const statusUrl = `http://localhost:${port}/mockserver/status`;
  const healthy = await waitForHealth(statusUrl, 15_000);

  if (!healthy) {
    // Clean up the unhealthy container
    await execAsync(`docker stop ${containerId} && docker rm ${containerId}`).catch(() => {});
    throw new Error(`MockServer failed to become healthy within 15s on port ${port}`);
  }

  return containerId;
}

/**
 * Load expectations into a running MockServer instance.
 *
 * Uses PUT /mockserver/expectation with the expectations array as the body.
 */
export async function loadExpectations(port: number, expectations: MockServerExpectation[]): Promise<void> {
  const response = await fetch(`http://localhost:${port}/mockserver/expectation`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(expectations),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Failed to load expectations: HTTP ${response.status} — ${body}`);
  }
}

/** Stop and remove a MockServer container by ID. */
export async function stopMockServer(containerId: string): Promise<void> {
  await execAsync(`docker stop ${containerId} && docker rm ${containerId}`, { timeout: 30_000 });
}

/** Check whether a MockServer instance is running and report its status. */
export async function getMockServerStatus(port: number): Promise<{ running: boolean; expectationCount?: number }> {
  try {
    const response = await fetch(`http://localhost:${port}/mockserver/status`);
    if (!response.ok) return { running: false };

    const data = await response.json() as Record<string, unknown>;
    const expectationCount = typeof data.expectationCount === 'number'
      ? data.expectationCount
      : undefined;

    return { running: true, expectationCount };
  } catch {
    return { running: false };
  }
}
