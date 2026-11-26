/**
 * Signed URLs and the asset origin (BE-045 criteria 2 to 5; SEC-040 criterion 4; SEC-046 criteria
 * 2 to 4), and the declared-upload check of BE-042 (criterion 4's limit and criterion 5's ignored
 * hash, on the worker's side). The origin runs as a real HTTP server on 127.0.0.1.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assetKeys } from '../src/keys.ts';
import { MemoryAssetObjects } from '../src/objects.ts';
import { startAssetOrigin, type RunningOrigin } from '../src/origin.ts';
import { DEFAULT_CONTENT_LIMITS } from '../src/sandbox/limits.ts';
import { DOCX, GIF, JPEG, PNG, SVG } from '../src/sandbox/types.ts';
import { assetUrlExpiry, signAssetUrl, verifyAssetUrl, type AssetUrlKeys } from '../src/signing.ts';
import { checkDeclaredUpload } from '../src/upload.ts';
import { png } from './fixtures.ts';

const key = (id: string) => ({ id, secret: randomBytes(32) });
const keys: AssetUrlKeys = { current: key('k2'), previous: [key('k1')] };
const NOW = 1_800_000_000_000;

const tenant = randomUUID();
const body = png();
const sha = createHash('sha256').update(body).digest('hex');

describe('signed URLs (BE-045 criteria 2 and 3; SEC-046 criteria 2 to 4)', () => {
  const url = signAssetUrl({
    origin: 'https://assets.example-usercontent.net',
    tenant,
    sha256: sha,
    mime: PNG,
    expiresAt: NOW + 300_000,
    keys,
  });
  const path = (u: string) => {
    const x = new URL(u);
    return x.pathname + x.search;
  };

  it('names one object and verifies until it expires', () => {
    expect(url).toMatch(
      new RegExp(
        `^https://assets\\.example-usercontent\\.net/a/${tenant}/${sha}\\.png\\?exp=\\d+&kid=k2&sig=[A-Za-z0-9_-]{43}$`,
      ),
    );
    expect(verifyAssetUrl(path(url), keys, NOW)).toMatchObject({
      ok: true,
      tenant,
      sha256: sha,
      kind: { contentType: PNG },
    });
    expect(verifyAssetUrl(path(url), keys, NOW + 299_999).ok).toBe(true);
    expect(verifyAssetUrl(path(url), keys, NOW + 300_000)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('fails when the tenant, the object, the kind, the expiry, the key or the signature is altered', () => {
    const p = path(url);
    const other = randomUUID();
    const otherSha = createHash('sha256').update('other').digest('hex');
    const altered = [
      p.replace(tenant, other),
      p.replace(sha, otherSha),
      p.replace('.png', '.svg'),
      p.replace('.png', '.gif'),
      p.replace(/exp=(\d+)/, (_m, e: string) => `exp=${Number(e) + 1}`),
      p.replace('kid=k2', 'kid=k1'),
      p.replace(/sig=(.)/, (_m, c: string) => `sig=${c === 'A' ? 'B' : 'A'}`),
    ];
    for (const a of altered) expect(verifyAssetUrl(a, keys, NOW).ok, a).toBe(false);
    expect(verifyAssetUrl(p.replace('kid=k2', 'kid=k9'), keys, NOW)).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
  });

  it('refuses a URL for one object used for another, even with the same key and expiry (SEC-046 criterion 4)', () => {
    // ADR 0106, open question 2: the signature must cover the object, not only the expiry.
    const otherSha = createHash('sha256').update('another object').digest('hex');
    const otherUrl = signAssetUrl({
      origin: 'https://assets.example-usercontent.net',
      tenant,
      sha256: otherSha,
      mime: PNG,
      expiresAt: NOW + 300_000,
      keys,
    });
    const a = new URL(url);
    const b = new URL(otherUrl);
    expect(a.searchParams.get('exp')).toBe(b.searchParams.get('exp'));
    // A's signature on B's path, and B's signature on A's path.
    const aSigOnB = `${b.pathname}?exp=${a.searchParams.get('exp')}&kid=k2&sig=${a.searchParams.get('sig')}`;
    const bSigOnA = `${a.pathname}?exp=${b.searchParams.get('exp')}&kid=k2&sig=${b.searchParams.get('sig')}`;
    expect(verifyAssetUrl(aSigOnB, keys, NOW).ok).toBe(false);
    expect(verifyAssetUrl(bSigOnA, keys, NOW).ok).toBe(false);
    // Each URL still verifies for its own object.
    expect(verifyAssetUrl(path(url), keys, NOW).ok).toBe(true);
    expect(verifyAssetUrl(path(otherUrl), keys, NOW).ok).toBe(true);
  });

  it('fails on any extra, missing or repeated query parameter', () => {
    const p = path(url);
    for (const a of [
      `${p}&x=1`,
      `${p}&exp=1`,
      p.replace(/&kid=k2/, ''),
      p.split('?')[0]!,
      `${p}#frag`,
    ])
      expect(verifyAssetUrl(a, keys, NOW).ok, a).toBe(false);
  });

  it('accepts a URL signed with the previous key while it runs out (rotation)', () => {
    const old = signAssetUrl({
      origin: 'https://a.example',
      tenant,
      sha256: sha,
      mime: PNG,
      expiresAt: NOW + 60_000,
      keys: { current: keys.previous![0]! },
    });
    expect(verifyAssetUrl(path(old), keys, NOW).ok).toBe(true);
    expect(verifyAssetUrl(path(old), { current: keys.current }, NOW).ok).toBe(false);
  });

  it('refuses a URL that expires later than the longest lifetime the origin allows', () => {
    const long = signAssetUrl({
      origin: 'https://a.example',
      tenant,
      sha256: sha,
      mime: PNG,
      expiresAt: NOW + 7 * 24 * 3_600_000,
      keys,
    });
    expect(verifyAssetUrl(path(long), keys, NOW)).toEqual({ ok: false, reason: 'too_long' });
  });

  it('gives the same URL within one window, so that browsers can cache it', () => {
    const a = assetUrlExpiry(NOW + 1_000);
    const b = assetUrlExpiry(NOW + 50_000);
    expect(a).toBe(b);
    expect(a - (NOW + 50_000)).toBeGreaterThan(200_000);
    expect(a - NOW).toBeLessThanOrEqual(300_000);
  });

  it('refuses to sign what it cannot serve', () => {
    expect(() =>
      signAssetUrl({
        origin: 'https://a.example',
        tenant,
        sha256: sha,
        mime: 'text/html',
        expiresAt: NOW,
        keys,
      }),
    ).toThrow();
    expect(() =>
      signAssetUrl({
        origin: 'https://a.example',
        tenant: 'x',
        sha256: sha,
        mime: PNG,
        expiresAt: NOW,
        keys,
      }),
    ).toThrow();
    expect(() =>
      signAssetUrl({
        origin: 'https://a.example/path',
        tenant,
        sha256: sha,
        mime: PNG,
        expiresAt: NOW,
        keys,
      }),
    ).toThrow();
  });
});

describe('the asset origin (BE-045 criteria 2 to 5; SEC-040 criterion 4; SEC-046 criteria 2 to 4)', () => {
  const objects = new MemoryAssetObjects();
  let origin: RunningOrigin;
  let now = NOW;
  const refused: string[] = [];
  const svgBody = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>\n',
  );
  const svgSha = createHash('sha256').update(svgBody).digest('hex');

  beforeAll(async () => {
    // The store's own content type is wrong on purpose: the origin never uses it.
    await objects.put(assetKeys.final(tenant, sha), body, { contentType: 'text/html' });
    await objects.put(assetKeys.final(tenant, svgSha), svgBody, { contentType: 'text/html' });
    origin = await startAssetOrigin({
      objects,
      keys,
      now: () => now,
      onRefused: (r) => refused.push(r),
    });
  });
  afterAll(() => origin.close());

  const sign = (s: string, mime: string, t = tenant, life = 300_000) =>
    signAssetUrl({ origin: origin.url, tenant: t, sha256: s, mime, expiresAt: now + life, keys });

  it('serves the one object with a fixed content type, nosniff, a sandboxing policy and long caching', async () => {
    const res = await fetch(sign(sha, PNG));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(PNG);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(res.headers.get('content-disposition')).toBe('inline');
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(res.headers.get('etag')).toBe(`"${sha}"`);
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(body))).toBe(true);
  });

  it('serves SVG as an attachment, never as a page', async () => {
    const res = await fetch(sign(svgSha, SVG));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(SVG);
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${svgSha}.svg"`);
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    await res.arrayBuffer();
  });

  it('serves a Word file as an attachment with the fixed Word content type, never as a page (EXP-108 criterion 2)', async () => {
    // The stored bytes are not a page; the headers are what keeps a browser from rendering them.
    const docx = new TextEncoder().encode('PK not read by the origin');
    const docxSha = createHash('sha256').update(docx).digest('hex');
    await objects.put(assetKeys.final(tenant, docxSha), docx, { contentType: 'text/html' });
    const res = await fetch(sign(docxSha, DOCX));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(DOCX);
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${docxSha}.docx"`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(docx))).toBe(true);
    // The same object under another kind in the URL is refused: the kind is part of the signature.
    expect((await fetch(sign(docxSha, DOCX).replace('.docx', '.html'))).status).toBe(404);
  });

  it('answers a revalidation with 304 and HEAD without a body', async () => {
    const u = sign(sha, PNG);
    const r304 = await fetch(u, { headers: { 'if-none-match': `"${sha}"` } });
    expect(r304.status).toBe(304);
    const head = await fetch(u, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(body.length));
  });

  it('refuses altered, expired, foreign and unsigned URLs, and other methods', async () => {
    const u = sign(sha, PNG);
    const other = randomUUID();
    const expired = sign(sha, PNG, tenant, 1_000);
    for (const [url, status] of [
      [u.replace(tenant, other), 403],
      [u.replace(/sig=(.)/, (_m, c: string) => `sig=${c === 'A' ? 'B' : 'A'}`), 403],
      [u.replace('.png', '.svg'), 403],
      [u.split('?')[0]!, 403],
      [`${origin.url}/a/${tenant}/${sha}.html`, 404],
      [`${origin.url}/`, 404],
      [sign(createHash('sha256').update('none').digest('hex'), PNG), 404],
    ] as const) {
      const res = await fetch(url);
      expect(res.status, url).toBe(status);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      await res.arrayBuffer();
    }
    now += 2_000;
    expect((await fetch(expired)).status).toBe(403);
    expect((await fetch(u, { method: 'POST' })).status).toBe(405);
    expect((await fetch(u, { method: 'PUT', body: 'x' })).status).toBe(405);
    expect(refused).toEqual(
      expect.arrayContaining(['bad_signature', 'malformed', 'not_found', 'expired', 'missing']),
    );
  });

  it('refuses to serve an object whose bytes no longer have their hash', async () => {
    const t = randomUUID();
    const s = createHash('sha256').update('original').digest('hex');
    await objects.put(assetKeys.final(t, s), new TextEncoder().encode('tampered'), {
      contentType: PNG,
    });
    const res = await fetch(sign(s, PNG, t));
    expect(res.status).toBe(502);
    await res.arrayBuffer();
  });
});

describe('the declared upload (BE-042 criteria 4 and 5, the worker side)', () => {
  it('accepts the types and sizes the worker can process', () => {
    expect(checkDeclaredUpload({ filename: 'a.png', mime: PNG, size: 1000 })).toEqual({
      ok: true,
      mime: PNG,
      maxBytes: DEFAULT_CONTENT_LIMITS.imageMaxBytes,
    });
    expect(checkDeclaredUpload({ filename: 'a.jpg', mime: 'image/jpg', size: 1 })).toMatchObject({
      ok: true,
      mime: JPEG,
    });
    expect(checkDeclaredUpload({ filename: 'a.gif', mime: GIF, size: 1 })).toMatchObject({
      ok: true,
    });
    expect(
      checkDeclaredUpload({
        filename: 'a.docx',
        mime: DOCX,
        size: DEFAULT_CONTENT_LIMITS.docxMaxBytes,
      }),
    ).toMatchObject({ ok: true });
  });

  it('answers too_large above the limit and validation_failed for other types', () => {
    expect(
      checkDeclaredUpload({
        filename: 'a.png',
        mime: PNG,
        size: DEFAULT_CONTENT_LIMITS.imageMaxBytes + 1,
      }),
    ).toMatchObject({
      ok: false,
      code: 'too_large',
    });
    expect(
      checkDeclaredUpload({
        filename: 'a.svg',
        mime: SVG,
        size: DEFAULT_CONTENT_LIMITS.svgMaxBytes + 1,
      }),
    ).toMatchObject({ code: 'too_large' });
    expect(checkDeclaredUpload({ filename: 'a.html', mime: 'text/html', size: 10 })).toMatchObject({
      ok: false,
      code: 'validation_failed',
      reason: 'unsupported_type',
    });
    expect(checkDeclaredUpload({ filename: 'a.png', mime: PNG, size: 0 })).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
    expect(checkDeclaredUpload({ filename: 'a.png', mime: PNG, size: 1.5 })).toMatchObject({
      ok: false,
    });
  });

  it('has no place for a declared hash: one in the request changes nothing', () => {
    const withHash = { filename: 'a.png', mime: PNG, size: 1000, sha256: '0'.repeat(64) } as {
      filename: string;
      mime: string;
      size: number;
    };
    expect(checkDeclaredUpload(withHash)).toEqual(
      checkDeclaredUpload({ filename: 'a.png', mime: PNG, size: 1000 }),
    );
  });
});
