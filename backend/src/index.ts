import { appInfo } from './config/app-info.js';
import { env } from './config/env.js';
import { logger } from './core/logger.js';
import { connectMongo } from './infra/mongo.js';
import { startCampaignRunner } from './modules/campaign/campaign.runner.js';
import { attachGatewayWebSocket } from './modules/gateway/gateway.socket.js';
import { rebuildFromMessages } from './modules/sms/sim-quota.js';
import { createMongoRepositories } from './repositories/mongo/index.js';
import { repositories, setRepositories } from './repositories/index.js';
import { createApp } from './app.js';
import { registerProcessHandlers, startServer } from './server.js';

/**
 * Composition root.
 *
 * The only file allowed to wire concrete implementations together and cause side
 * effects. Everything it touches is a pure factory, which is what keeps the rest
 * of the codebase testable.
 *
 * Boot order is load-bearing:
 *   1. Connect MongoDB           - ensure indexes, register the readiness probe.
 *   2. Bind the repository ports - services stop talking to RAM and start
 *                                  talking to MongoDB. This is the *whole* swap.
 *   3. Build the Express app.
 *   4. Open the listener         - only now can a request arrive, and by then
 *                                  every dependency it needs is proven up.
 *   5. Arm signal handlers.
 *
 * Connecting the database *before* listening is the point: a server that accepts
 * traffic it cannot serve is worse than one that is briefly not there at all.
 * Index creation happens inside step 1 for the same reason - the unique index on
 * `users.email` is what makes concurrent registration safe, so no request may be
 * served before it exists.
 */
async function bootstrap(): Promise<void> {
  logger.info(`Starting ${appInfo.name} v${appInfo.version}`, {
    env: env.NODE_ENV,
    node: appInfo.nodeVersion,
    timezone: env.TIMEZONE,
  });

  // 1 + 2. Datastore, then the port binding that makes every service use it.
  const db = await connectMongo();
  setRepositories(createMongoRepositories(db));

  // Crash recovery. Every gateway the *previous* process believed was ONLINE is,
  // by definition, not: its socket died with that process. Without this, the
  // dashboard shows phantom online phones forever and the dispatcher hands
  // messages to sockets that no longer exist.
  const stale = await repositories().gateways.markAllOffline();
  if (stale > 0) {
    logger.warn(`Marked ${stale} stale gateway(s) offline after restart`);
  }

  // Rebuild today's per-SIM usage from the messages already dispatched. Before the
  // listener opens, deliberately: a restart at noon must not let a SIM that has
  // already spent 90 of its 100 start again from zero. This is the daily cap's
  // memory, and the cap is what stops a carrier blacklisting the user's numbers.
  await rebuildFromMessages();

  // 3 + 4.
  const app = createApp();
  const { server, stop } = await startServer(app);

  // The WebSocket attaches to the raw http.Server, not to Express: it needs the
  // `upgrade` event, which is why server.ts creates the server explicitly instead
  // of calling app.listen().
  attachGatewayWebSocket(server);

  // The campaign runner is a background timer that drains RUNNING campaigns one
  // paced send at a time. Started here, after the repositories point at MongoDB,
  // so any campaign left RUNNING by the previous process is picked back up and
  // continues from its cursor - no message is re-sent, none is skipped.
  startCampaignRunner();

  // 5.
  registerProcessHandlers(stop);
}

bootstrap().catch((error: unknown) => {
  logger.error('Fatal error during startup', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  // Exit non-zero so Docker/systemd/Kubernetes see the failure and back off,
  // instead of a zombie container that answers nothing.
  process.exit(1);
});
