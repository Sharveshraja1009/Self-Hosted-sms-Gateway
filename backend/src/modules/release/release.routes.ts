import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { Router } from 'express';
import type { Request, Response } from 'express';

import { createLogger } from '../../core/logger.js';
import { NotFoundError } from '../../core/errors.js';
import { sendSuccess } from '../../core/http-response.js';

/**
 * The published Android app: what it is, and where to get it.
 *
 * The APK has always been downloadable at `/admin/sms-gateway.apk`, but that is a
 * raw static file: opening the link starts a 55MB download with no indication of
 * what version it is, whether it is newer than what is already on the phone, or
 * whether it finished intact. This endpoint is what turns that into something a
 * person can look at before committing to it.
 *
 * Size and date are read from the FILE, every time. They are facts about the
 * artefact, and a metadata file claiming a size the artefact does not have is
 * worse than no metadata at all. Only the things the file cannot tell us - the
 * version and the release notes - come from the sidecar, which is the one thing
 * to edit when publishing a build.
 *
 * Deliberately unauthenticated: it describes a file that is already public, and
 * the whole point is to hand the link to someone who does not have a login.
 */
const log = createLogger('release');

export const releaseRouter: Router = Router();

/** Where the published artefact lives. `process.cwd()` is backend/ - see app.ts. */
function releaseDir(): string {
  return path.join(process.cwd(), 'public', 'admin');
}

const APK_FILENAME = 'sms-gateway.apk';
const SIDECAR_FILENAME = 'app-release.json';

/** The public URL of the artefact. Unchanged, so every link already handed out still works. */
const APK_URL = `/admin/${APK_FILENAME}`;

interface Sidecar {
  version?: string;
  versionCode?: number;
  notes?: string[];
  minAndroid?: string;
}

/**
 * The editable half of the metadata.
 *
 * Absent or malformed is NOT an error: the page still has a size, a date and a
 * working download button, which is most of the value. A release that shipped
 * without someone remembering to update a JSON file should still be installable.
 */
async function readSidecar(): Promise<Sidecar> {
  try {
    const raw = await readFile(path.join(releaseDir(), SIDECAR_FILENAME), 'utf8');
    const parsed: unknown = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object') return {};

    const { version, versionCode, notes, minAndroid } = parsed as Record<string, unknown>;

    return {
      ...(typeof version === 'string' ? { version } : {}),
      ...(typeof versionCode === 'number' ? { versionCode } : {}),
      ...(Array.isArray(notes) ? { notes: notes.filter((n): n is string => typeof n === 'string') } : {}),
      ...(typeof minAndroid === 'string' ? { minAndroid } : {}),
    };
  } catch (error) {
    // ENOENT is the ordinary case (no sidecar yet); anything else is worth a line
    // in the log but still must not break the page.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('Could not read the app release sidecar', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return {};
  }
}

/** Bytes as something a human reads before deciding to download over mobile data. */
function humanSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const latest = async (_req: Request, res: Response): Promise<void> => {
  const filePath = path.join(releaseDir(), APK_FILENAME);

  let file;
  try {
    file = await stat(filePath);
  } catch {
    // The panel is deployed but the APK was never copied across. Say so plainly -
    // this is an operator error with an obvious fix, not a mystery.
    throw new NotFoundError('No APK has been published on this server');
  }

  const sidecar = await readSidecar();

  sendSuccess(res, {
    filename: APK_FILENAME,
    url: APK_URL,
    sizeBytes: file.size,
    sizeLabel: humanSize(file.size),
    updatedAt: file.mtime.toISOString(),
    version: sidecar.version ?? null,
    versionCode: sidecar.versionCode ?? null,
    minAndroid: sidecar.minAndroid ?? null,
    notes: sidecar.notes ?? [],
  });
};

releaseRouter.get('/latest', latest);
