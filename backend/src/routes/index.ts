import { Router } from 'express';

import { appInfo } from '../config/app-info.js';
import { env } from '../config/env.js';
import { sendSuccess } from '../core/http-response.js';
import { authRouter } from '../modules/auth/auth.routes.js';
import { campaignRouter } from '../modules/campaign/campaign.routes.js';
import { gatewayRouter } from '../modules/gateway/gateway.routes.js';
import { GATEWAY_WS_PATH } from '../modules/gateway/gateway.socket.js';
import { healthRouter } from '../modules/health/health.routes.js';
import { releaseRouter } from '../modules/release/release.routes.js';
import { smsRouter } from '../modules/sms/sms.routes.js';

/**
 * The API router - the one place that knows the full public surface.
 *
 * Every module exposes its own router; this file is the table of contents.
 * Adding a feature means one import and one `use()` here, never a change to
 * app.ts.
 */
export const apiRouter: Router = Router();

/** Service discovery: what is this thing, and what can it do? */
apiRouter.get('/', (_req, res) => {
  sendSuccess(res, {
    name: appInfo.name,
    version: appInfo.version,
    status: 'operational',
    endpoints: {
      health: `${env.API_PREFIX}/health`,
      auth: `${env.API_PREFIX}/auth`,
      sms: `${env.API_PREFIX}/sms`,
      campaigns: `${env.API_PREFIX}/campaigns`,
      gateways: `${env.API_PREFIX}/gateways`,
      /** What the published Android app is, and where to download it. Public. */
      app: `${env.API_PREFIX}/app/latest`,
      // Advertised here so the Android app can discover it from one base URL
      // instead of having the path hard-coded in two places.
      gatewaySocket: GATEWAY_WS_PATH,
    },
  });
});

apiRouter.use('/health', healthRouter);
apiRouter.use('/auth', authRouter);
apiRouter.use('/sms', smsRouter);
apiRouter.use('/campaigns', campaignRouter);
apiRouter.use('/gateways', gatewayRouter);
// Unauthenticated on purpose: it describes an already-public file, and the point
// is to hand the download link to someone who has no login.
apiRouter.use('/app', releaseRouter);
