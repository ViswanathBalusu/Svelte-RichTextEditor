// BE-047 criterion 3 over HTTP (lane V-BE-043-056): `GET /v1/fonts` sends an ETag that changes with
// the set of fonts, and answers 304 to a repeat of the ETag it sent. The route test in
// fonts.route.test.ts checks the manifest version; this file checks the header the route sends.
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../../test/control-plane/support.ts';
import { loadFontCatalogue, type FontCatalogue } from './fonts.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const BASE = 'https://docs.example.test/fonts';
const dirs: string[] = [];
const harnesses: Harness[] = [];

afterAll(async () => {
  for (const h of harnesses) await h.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** One family with four faces, each file named by its SHA-256 as the converter writes them. */
function family(name: string) {
  const files = new Map<string, Buffer>();
  const face = (style: string) => {
    const bytes = Buffer.from(`${name}-${style}-etag-bytes`);
    const hash = sha(bytes);
    files.set(`${hash}.ttf`, bytes);
    return { file: `${hash}.ttf`, sha256: hash };
  };
  return {
    files,
    body: {
      name,
      licence: 'OFL-1.1',
      regular: face('regular'),
      bold: face('bold'),
      italic: face('italic'),
      boldItalic: face('boldItalic'),
    },
  };
}

async function catalogueOf(families: Array<ReturnType<typeof family>>): Promise<FontCatalogue> {
  const d = await mkdtemp(join(tmpdir(), 'docedit-font-etag-'));
  dirs.push(d);
  for (const f of families)
    for (const [name, bytes] of f.files) await writeFile(join(d, name), bytes);
  await writeFile(
    join(d, 'fonts.json'),
    JSON.stringify({ version: 1, families: families.map((f) => f.body) }),
  );
  return loadFontCatalogue(d, BASE);
}

async function serve(catalogue: FontCatalogue): Promise<Harness> {
  const h = await startHarness('memory', { fonts: catalogue });
  harnesses.push(h);
  return h;
}

describe('GET /v1/fonts ETag (PRO-067; BE-047 criterion 3)', () => {
  it('sends an ETag, answers 304 to a repeat of it, and changes the ETag when the set of fonts changes', async () => {
    const one = await serve(await catalogueOf([family('Serif Text')]));
    const first = await one.call('GET', '/v1/fonts', { token: one.serviceJwt() });
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^"f[0-9a-f]{32}"$/);

    const repeat = await one.call('GET', '/v1/fonts', {
      token: one.serviceJwt(),
      headers: { 'If-None-Match': etag! },
    });
    expect(repeat.status).toBe(304);

    const more = await serve(await catalogueOf([family('Serif Text'), family('Mono')]));
    const changed = await more.call('GET', '/v1/fonts', { token: more.serviceJwt() });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);
    // The old ETag no longer matches the new set, so the full manifest is sent again.
    const stale = await more.call('GET', '/v1/fonts', {
      token: more.serviceJwt(),
      headers: { 'If-None-Match': etag! },
    });
    expect(stale.status).toBe(200);
  });
});
