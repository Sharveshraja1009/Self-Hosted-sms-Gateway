import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Ambient per-request context.
 *
 * Passing a `requestId` (and later a `userId`) down through every service and
 * repository call would pollute every signature in the codebase. `AsyncLocalStorage`
 * keeps it in the async execution context instead, so the logger can stamp every
 * line - including ones emitted five layers deep inside a queue producer - with
 * the request that caused it. This is what makes an incident traceable.
 */

export interface RequestContext {
  requestId: string;
  /** Populated by the auth middleware in Phase 2. */
  userId?: string;
  /** Populated by the gateway auth middleware in Phase 5. */
  gatewayId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `callback` with `context` attached to the current async execution path. */
export function runWithContext<T>(context: RequestContext, callback: () => T): T {
  return storage.run(context, callback);
}

/** The context of the in-flight request, or undefined outside of one (e.g. workers). */
export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * Mutates the active context. Used by auth middleware once the caller's identity
 * is known, so that subsequent log lines carry it.
 */
export function setContextValue<K extends keyof RequestContext>(key: K, value: RequestContext[K]): void {
  const store = storage.getStore();
  if (store) {
    store[key] = value;
  }
}
