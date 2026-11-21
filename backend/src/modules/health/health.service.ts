import { appInfo, uptimeSeconds } from '../../config/app-info.js';
import { env } from '../../config/env.js';
import { isShuttingDown } from '../../core/shutdown.js';
import { healthRegistry, type ReadinessReport } from './health.registry.js';

/**
 * Health reporting.
 *
 * Deliberately three different questions, because orchestrators ask three
 * different things:
 *
 *  - liveness  "is the process alive?"        -> restart the container if not
 *  - readiness "can it serve traffic right now?" -> pull it out of the load balancer if not
 *  - info      "what exactly is running?"     -> for humans and dashboards
 *
 * Conflating liveness with readiness is a classic outage amplifier: a brief
 * MongoDB blip makes every replica fail its probe, every replica gets killed,
 * and now you have a cold-start stampede on top of a database problem.
 */

export interface LivenessResult {
  status: 'ok';
  uptimeSeconds: number;
}

export interface ReadinessResult extends ReadinessReport {
  status: 'ready' | 'not_ready';
  shuttingDown: boolean;
}

export interface InfoResult {
  name: string;
  version: string;
  environment: string;
  nodeVersion: string;
  pid: number;
  startedAt: string;
  uptimeSeconds: number;
  timezone: string;
  memory: {
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
  };
}

const toMb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 100) / 100;

export const healthService = {
  liveness(): LivenessResult {
    return { status: 'ok', uptimeSeconds: uptimeSeconds() };
  },

  async readiness(): Promise<ReadinessResult> {
    const report = await healthRegistry.runAll();

    // Mid-shutdown we are alive but must stop receiving new traffic.
    const draining = isShuttingDown();
    const ready = report.ready && !draining;

    return {
      status: ready ? 'ready' : 'not_ready',
      ready,
      shuttingDown: draining,
      checks: report.checks,
    };
  },

  info(): InfoResult {
    const memory = process.memoryUsage();

    return {
      name: appInfo.name,
      version: appInfo.version,
      environment: env.NODE_ENV,
      nodeVersion: appInfo.nodeVersion,
      pid: process.pid,
      startedAt: appInfo.startedAt.toISOString(),
      uptimeSeconds: uptimeSeconds(),
      timezone: env.TIMEZONE,
      memory: {
        rssMb: toMb(memory.rss),
        heapUsedMb: toMb(memory.heapUsed),
        heapTotalMb: toMb(memory.heapTotal),
      },
    };
  },
};
