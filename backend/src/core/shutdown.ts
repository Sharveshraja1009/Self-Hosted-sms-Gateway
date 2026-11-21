import { createLogger } from './logger.js';

/**
 * Graceful shutdown registry.
 *
 * When Kubernetes/Docker sends SIGTERM we must not drop an in-flight SMS on the
 * floor: the HTTP listener stops accepting, the BullMQ worker finishes its
 * current job, WebSocket clients get a clean close frame, then the MongoDB and
 * Redis pools drain. Each subsystem registers its own teardown here as it boots,
 * and we run them in reverse registration order (last in, first out) - the same
 * ordering a stack unwind would give you.
 */

const log = createLogger('shutdown');

export interface ShutdownHook {
  name: string;
  /** Higher runs first. Same priority falls back to reverse registration order. */
  priority?: number;
  handler: () => Promise<void> | void;
}

const hooks: ShutdownHook[] = [];
let shuttingDown = false;

export function onShutdown(name: string, handler: ShutdownHook['handler'], priority = 0): void {
  hooks.push({ name, handler, priority });
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** Rejects if `promise` has not settled within `ms`, so one stuck hook cannot hang the exit. */
function withTimeout(promise: Promise<void>, ms: number, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Shutdown hook "${name}" timed out after ${ms}ms`)), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Runs every registered hook. Never throws: a failing hook is logged and the
 * remaining hooks still run, because a half-closed process is worse than a
 * noisy one.
 */
export async function runShutdownHooks(timeoutMs: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  const ordered = [...hooks].reverse().sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  for (const hook of ordered) {
    try {
      log.info(`Closing ${hook.name}...`);
      await withTimeout(Promise.resolve(hook.handler()), timeoutMs, hook.name);
      log.info(`Closed ${hook.name}`);
    } catch (error) {
      log.error(`Failed to close ${hook.name}`, { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** Test-only: clears the registry between suites. */
export function resetShutdownHooks(): void {
  hooks.length = 0;
  shuttingDown = false;
}
