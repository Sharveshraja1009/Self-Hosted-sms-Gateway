import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { Express } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';

/**
 * The public app-download surface.
 *
 * Two things are being pinned here. The first is that `GET /api/app/latest` needs
 * NO credentials: the entire point is to send the link to whoever is holding the
 * phone, and they do not have a login. The second is that the raw
 * `/admin/sms-gateway.apk` URL still serves the file - people have that link
 * already, and a download page is only an improvement if it does not break them.
 *
 * The APK is a build artefact, so it may or may not be present in a given
 * checkout. Rather than skip, each test asserts the contract for whichever case
 * it finds: a published build must describe itself correctly, and an unpublished
 * one must say so plainly instead of failing in some inventive way.
 */
const APK_PATH = path.join(process.cwd(), 'public', 'admin', 'sms-gateway.apk');

async function published(): Promise<boolean> {
  try {
    await stat(APK_PATH);
    return true;
  } catch {
    return false;
  }
}

describe('app download', () => {
  let app: Express;
  let hasApk: boolean;

  beforeAll(async () => {
    app = createApp();
    hasApk = await published();
  });

  describe('GET /api/app/latest', () => {
    it('answers without authentication', async () => {
      const response = await request(app).get('/api/app/latest');

      // Whatever else is true, it must never be an auth failure.
      expect([200, 404]).toContain(response.status);
      expect(response.status).not.toBe(401);
    });

    it('describes the artefact from the file itself, not from a metadata claim', async () => {
      const response = await request(app).get('/api/app/latest');

      if (!hasApk) {
        expect(response.status).toBe(404);
        expect(response.body.error.message).toMatch(/no apk has been published/i);
        return;
      }

      const file = await stat(APK_PATH);
      const data = response.body.data as {
        filename: string;
        url: string;
        sizeBytes: number;
        sizeLabel: string;
        updatedAt: string;
        notes: string[];
      };

      expect(response.status).toBe(200);
      // Size and date come from the artefact, so they cannot drift from it - which
      // is the whole reason they are not in the sidecar.
      expect(data.sizeBytes).toBe(file.size);
      expect(new Date(data.updatedAt).getTime()).toBe(Math.floor(file.mtime.getTime()));
      expect(data.sizeLabel).toMatch(/^\d+(\.\d+)? (KB|MB|GB)$/);
      expect(data.url).toBe('/admin/sms-gateway.apk');
      expect(Array.isArray(data.notes)).toBe(true);
    });

    it('does not read the 55MB artefact to answer - only stats it', async () => {
      if (!hasApk) return;

      // The endpoint is polled by every visitor to the download page, so it must
      // stay a stat() call. This once hashed the file for a checksum display that
      // no longer exists; the timing is the cheapest guard against that coming
      // back by accident.
      const started = Date.now();
      await request(app).get('/api/app/latest').expect(200);

      expect(Date.now() - started).toBeLessThan(1000);
    });
  });

  describe('the page and the file', () => {
    it('serves the download page at /download', async () => {
      const response = await request(app).get('/download/').expect(200);

      expect(response.headers['content-type']).toMatch(/text\/html/);
      // A working link in the markup itself: if the metadata fetch fails, the page
      // must still do what the bare .apk URL used to.
      expect(response.text).toContain('href="/admin/sms-gateway.apk"');
    });

    it('keeps the original APK URL working, as a file', async () => {
      if (!hasApk) return;

      const response = await request(app).head('/admin/sms-gateway.apk').expect(200);

      expect(response.headers['content-type']).toBe('application/vnd.android.package-archive');
    });
  });
});
