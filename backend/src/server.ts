import http from 'node:http';
import type { Express } from 'express';

import { appInfo } from './config/app-info.js';
import { env } from './config/env.js';
import { createLogger } from './core/logger.js';
import { onShutdown, runShutdownHooks } from './core/shutdown.js';

/**
 * The HTTP server lifecycle: bind, serve, drain, exit.
 *
 * Kept apart from `createApp()` so that tests never open a socket. This file is
 * also where the WebSocket server attaches in Phase 5 - it needs the raw
 * `http.Server` to handle the `upgrade` handshake, which is precisely why we
 * create the server explicitly instead of calling `app.listen()`.
 */

const log = createLogger('server');

export interface StartedServer {
  server: http.Server;
  stop: () => Promise<void>;
}

export async function startServer(app: Express): Promise<StartedServer> {
  const server = http.createServer(app);

  // A slow client must not be able to hold a socket open forever. `headersTimeout`
  // has to exceed `keepAliveTimeout`, or Node races itself and drops live keep-alive
  // connections behind a load balancer.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`Port ${env.PORT} is already in use.`));
      } else if (error.code === 'EACCES') {
        reject(new Error(`Insufficient privileges to bind port ${env.PORT}.`));
      } else {
        reject(error);
      }
    };

    server.once('error', onError);
    server.listen(env.PORT, env.HOST, () => {
      server.off('error', onError);
      resolve();
    });
  });

  log.info(`${appInfo.name} v${appInfo.version} listening on http://${env.HOST}:${env.PORT}`, {
    env: env.NODE_ENV,
    pid: process.pid,
    apiPrefix: env.API_PREFIX,
  });

  /** Stops accepting new connections and waits for in-flight requests to finish. */
  const closeHttpServer = (): Promise<void> =>
    new Promise((resolve) => {
      server.close(() => resolve());
      // Node 18.2+: politely end idle keep-alive sockets that would otherwise
      // keep `close()` pending until their timeout expires.
      server.closeIdleConnections();
    });

  // Priority 100: the listener must close *first*, so no new work arrives while
  // the database and queue connections behind it are being torn down.
  onShutdown('http server', closeHttpServer, 100);

  const stop = async (): Promise<void> => {
    await runShutdownHooks(env.SHUTDOWN_TIMEOUT_MS);
  };

  return { server, stop };
}

/**
 * Signal + crash handling.
 *
 * SIGTERM (orchestrator) and SIGINT (Ctrl-C) drain gracefully. An uncaught
 * exception or unhandled rejection means the process is in an unknown state:
 * we log it, attempt a drain, and exit non-zero so the supervisor restarts us
 * from a clean slate. Continuing to serve traffic from a corrupted process is
 * how a small bug becomes a data-integrity incident.
 */
export function registerProcessHandlers(stop: () => Promise<void>): void {
  let terminating = false;

  const terminate = async (signal: string, exitCode: number): Promise<void> => {
    if (terminating) {
      log.warn(`Received ${signal} during shutdown - forcing exit`);
      process.exit(exitCode);
    }
    terminating = true;

    log.info(`Received ${signal}, shutting down gracefully...`);

    // Hard deadline: if a hook wedges, we still exit rather than hang forever
    // and get SIGKILLed with in-flight state.
    const killTimer = setTimeout(() => {
      log.error('Graceful shutdown timed out - forcing exit');
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS + 5_000);
    killTimer.unref();

    try {
      await stop();
      log.info('Shutdown complete');
      process.exit(exitCode);
    } catch (error) {
      log.error('Error during shutdown', { error: error instanceof Error ? error.message : String(error) });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void terminate('SIGTERM', 0));
  process.on('SIGINT', () => void terminate('SIGINT', 0));

  process.on('uncaughtException', (error) => {
    log.error('Uncaught exception - the process is in an undefined state', {
      error: error.message,
      stack: error.stack,
    });
    void terminate('uncaughtException', 1);
  });

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled promise rejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    void terminate('unhandledRejection', 1);
  });
}
