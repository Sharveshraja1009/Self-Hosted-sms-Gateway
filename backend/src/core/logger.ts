import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import winston from 'winston';

import { appInfo } from '../config/app-info.js';
import { env, isProduction, isTest } from '../config/env.js';
import { getContext } from './request-context.js';

/**
 * Structured logging.
 *
 * Two audiences, one logger:
 *  - Humans in `npm run dev` get a colourised single line they can scan.
 *  - Log shippers in production get newline-delimited JSON they can index.
 *
 * Every line is automatically stamped with the ambient request/user/gateway id
 * from AsyncLocalStorage, so you can grep an entire request's journey - HTTP in,
 * queue job, WebSocket push - by a single correlation id.
 */

const LOG_DIRECTORY = path.isAbsolute(env.LOG_DIR) ? env.LOG_DIR : path.resolve(process.cwd(), env.LOG_DIR);

if (env.LOG_TO_FILE && !existsSync(LOG_DIRECTORY)) {
  mkdirSync(LOG_DIRECTORY, { recursive: true });
}

/** Injects the ambient correlation ids into every log record. */
const withRequestContext = winston.format((info) => {
  const context = getContext();
  if (context) {
    info.requestId ??= context.requestId;
    if (context.userId) info.userId ??= context.userId;
    if (context.gatewayId) info.gatewayId ??= context.gatewayId;
  }
  return info;
});

const jsonFormat = winston.format.combine(
  withRequestContext(),
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

const prettyFormat = winston.format.combine(
  withRequestContext(),
  winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.colorize({ level: true }),
  winston.format.printf((info) => {
    const { timestamp, level, message, stack, requestId, ...rest } = info as winston.Logform.TransformableInfo & {
      timestamp?: string;
      stack?: string;
      requestId?: string;
    };

    // `service` and `env` are constant defaultMeta - noise on a dev terminal.
    delete (rest as Record<string, unknown>).service;
    delete (rest as Record<string, unknown>).env;

    const correlation = requestId ? ` [90m(${requestId.slice(0, 8)})[39m` : '';
    const extras = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
    const trace = stack ? `\n${stack}` : '';

    return `${timestamp} ${level}${correlation} ${String(message)}${extras}${trace}`;
  }),
);

const transports: winston.transport[] = [
  new winston.transports.Console({
    format: isProduction ? jsonFormat : prettyFormat,
    // Tests should not spam the reporter; errors still surface.
    silent: isTest && env.LOG_LEVEL !== 'debug',
    handleExceptions: true,
    handleRejections: true,
  }),
];

if (env.LOG_TO_FILE) {
  transports.push(
    new winston.transports.File({
      filename: path.join(LOG_DIRECTORY, 'error.log'),
      level: 'error',
      format: jsonFormat,
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 5,
      tailable: true,
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIRECTORY, 'combined.log'),
      format: jsonFormat,
      maxsize: 20 * 1024 * 1024, // 20 MB
      maxFiles: 5,
      tailable: true,
    }),
  );
}

export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  levels: winston.config.npm.levels,
  defaultMeta: {
    service: appInfo.name,
    env: env.NODE_ENV,
  },
  transports,
  exitOnError: false,
});

/**
 * A logger bound to a subsystem, e.g. `createLogger('queue:sms')`.
 * Keeps `component` on every line so you can filter a single subsystem's output.
 */
export function createLogger(component: string): winston.Logger {
  return logger.child({ component });
}

/** Winston's `stream` shim, so third-party middleware can pipe into our logger. */
export const loggerStream = {
  write(message: string): void {
    logger.http(message.trim());
  },
};
