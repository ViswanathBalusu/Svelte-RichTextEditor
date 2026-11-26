/**
 * The raw compile log is served by the asset origin as plain text (EXP-066 criterion 3; 09 §9.2;
 * owner decision 66). The origin runs as a real HTTP server on 127.0.0.1.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assetKeys } from '../src/keys.ts';
import { MemoryAssetObjects } from '../src/objects.ts';
import { startAssetOrigin, type RunningOrigin } from '../src/origin.ts';
import { signExportUrl, type AssetUrlKeys } from '../src/signing.ts';

const keys: AssetUrlKeys = { current: { id: 'k1', secret: randomBytes(32) }, previous: [] };
const NOW = 1_800_000_000_000;
const tenant = randomUUID();
const job = randomUUID();
// A log can hold anything the engine printed, including text a document author chose.
const HOSTILE = '<html><script>alert(1)</script></html>\n! Undefined control sequence.\n';

describe('the raw log on the asset origin (EXP-066 criterion 3)', () => {
  const objects = new MemoryAssetObjects();
  let origin: RunningOrigin;

  beforeAll(async () => {
    // The store's own content type is wrong on purpose: the origin never uses it.
    await objects.put(
      assetKeys.exportFile(tenant, job, 'compile.log'),
      new TextEncoder().encode(HOSTILE),
      {
        contentType: 'text/html',
      },
    );
    origin = await startAssetOrigin({ objects, keys, now: () => NOW });
  });
  afterAll(() => origin.close());

  const sign = (name: string) =>
    signExportUrl({ origin: origin.url, tenant, job, name, expiresAt: NOW + 300_000, keys });

  it('serves the log as plain text with nosniff, a sandboxing policy and a download disposition', async () => {
    const res = await fetch(sign('compile.log'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="compile.log"');
    // The bytes are the log's, unchanged: it is not rewritten, only never rendered.
    expect(await res.text()).toBe(HOSTILE);
  });

  it('never serves a log under a content type that a browser would render', async () => {
    // The name decides the type; a name that asks for HTML or SVG is not a log, and the signer
    // and the origin both hold to the table of served kinds.
    const res = await fetch(sign('compile.log'));
    expect(res.headers.get('content-type')).not.toMatch(/html|svg|xml|javascript/);
    await res.arrayBuffer();
  });

  it('refuses a log URL after its expiry and a URL altered to another job', async () => {
    const url = sign('compile.log');
    const other = await fetch(url.replace(job, randomUUID()));
    expect(other.status).toBe(403);
    expect(other.headers.get('x-content-type-options')).toBe('nosniff');
    await other.arrayBuffer();
    const late = await startAssetOrigin({ objects, keys, now: () => NOW + 400_000 });
    try {
      const res = await fetch(url.replace(origin.url, late.url));
      expect(res.status).toBe(403);
      await res.arrayBuffer();
    } finally {
      await late.close();
    }
  });
});
