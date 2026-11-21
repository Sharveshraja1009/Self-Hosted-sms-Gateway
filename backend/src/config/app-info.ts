import { readFileSync } from 'node:fs';

/**
 * Build/runtime identity of the process, resolved once.
 *
 * Health endpoints, log lines and the dashboard footer all want to know "which
 * build is this?". `process.env.npm_package_version` only exists when started
 * through npm, so we read package.json directly - it sits two levels above both
 * `src/config/` (dev, via tsx) and `dist/config/` (production build).
 */

interface PackageJson {
  name?: string;
  version?: string;
}

function readPackageJson(): PackageJson {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    return JSON.parse(raw) as PackageJson;
  } catch {
    return {};
  }
}

const pkg = readPackageJson();

export const appInfo = Object.freeze({
  name: pkg.name ?? '@sms-gateway/backend',
  version: pkg.version ?? '0.0.0',
  nodeVersion: process.version,
  startedAt: new Date(),
});

/** Seconds since the process booted. */
export function uptimeSeconds(): number {
  return Math.floor(process.uptime());
}
