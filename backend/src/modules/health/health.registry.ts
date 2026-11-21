import { createLogger } from '../../core/logger.js';

/**
 * Dependency health registry.
 *
 * The health endpoint must not hard-code knowledge of MongoDB, Redis or BullMQ -
 * that would force us to edit it every phase, and worse, would make the HTTP
 * layer depend on the datastore layer. Instead each subsystem registers its own
 * probe as it boots:
 *
 *   infra/mongo.ts: healthRegistry.register('mongo', () => db.command({ping: 1}))
 *   Phase 4:        healthRegistry.register('redis', () => redis.ping())
 *
 * Every probe runs concurrently and under a timeout, so one wedged dependency
 * cannot make the readiness endpoint itself hang - which would get the whole
 * container killed by the orchestrator for the wrong reason.
 */

const log = createLogger('health');

export type HealthStatus = 'up' | 'down';

export interface CheckOutcome {
  status: HealthStatus;
  error?: string;
  details?: Record<string, unknown>;
}

export interface CheckResult extends CheckOutcome {
  latencyMs: number;
  critical: boolean;
}

/** Resolve (optionally with details) for healthy; throw or return `down` for unhealthy. */
export type HealthCheckFn = () => Promise<CheckOutcome | void> | CheckOutcome | void;

interface RegisteredCheck {
  fn: HealthCheckFn;
  /** A failing critical check makes the service NOT ready (503). */
  critical: boolean;
  timeoutMs: number;
}

export interface ReadinessReport {
  ready: boolean;
  checks: Record<string, CheckResult>;
}

const DEFAULT_TIMEOUT_MS = 3_000;

class HealthRegistry {
  private readonly checks = new Map<string, RegisteredCheck>();

  register(
    name: string,
    fn: HealthCheckFn,
    options: { critical?: boolean; timeoutMs?: number } = {},
  ): void {
    this.checks.set(name, {
      fn,
      critical: options.critical ?? true,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    log.debug(`Registered health check "${name}"`, { critical: options.critical ?? true });
  }

  unregister(name: string): void {
    this.checks.delete(name);
  }

  /** Test-only: drop every registration so suites start from a clean slate. */
  reset(): void {
    this.checks.clear();
  }

  names(): string[] {
    return [...this.checks.keys()];
  }

  private async runOne(name: string, check: RegisteredCheck): Promise<CheckResult> {
    const startedAt = process.hrtime.bigint();

    const timeout = new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error(`Health check timed out after ${check.timeoutMs}ms`)),
        check.timeoutMs,
      ).unref();
    });

    try {
      const outcome = await Promise.race([Promise.resolve(check.fn()), timeout]);
      const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

      return {
        status: outcome?.status ?? 'up',
        ...(outcome?.details ? { details: outcome.details } : {}),
        ...(outcome?.error ? { error: outcome.error } : {}),
        latencyMs: Math.round(latencyMs * 100) / 100,
        critical: check.critical,
      };
    } catch (error) {
      const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const message = error instanceof Error ? error.message : String(error);

      log.warn(`Health check "${name}" failed`, { error: message });

      return {
        status: 'down',
        error: message,
        latencyMs: Math.round(latencyMs * 100) / 100,
        critical: check.critical,
      };
    }
  }

  /** Runs every probe in parallel. Ready iff no *critical* probe is down. */
  async runAll(): Promise<ReadinessReport> {
    const entries = [...this.checks.entries()];

    const results = await Promise.all(
      entries.map(async ([name, check]) => [name, await this.runOne(name, check)] as const),
    );

    const checks = Object.fromEntries(results) as Record<string, CheckResult>;
    const ready = results.every(([, result]) => result.status === 'up' || !result.critical);

    return { ready, checks };
  }
}

export const healthRegistry = new HealthRegistry();
