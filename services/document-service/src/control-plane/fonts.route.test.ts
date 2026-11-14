// The font manifest over HTTP (PRO-067; BE-047): `GET /v1/fonts` on the running service, the
// files it names fetched from the service's own `/fonts/` route, and the manifest version across
// two sets. The directory is written by the test; the harness is the in-memory one.
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../../test/control-plane/support.ts';
import {
  FONT_LICENCES,
  loadFontCatalogue,
  type FontCatalogue,
  type ManifestFamily,
} from './fonts.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const dirs: string[] = [];
const harnesses: Harness[] = [];

afterAll(async () => {
  for (const h of harnesses) await h.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** A family whose four faces are distinct files named by their SHA-256, as the converter writes them. */
function family(name: string, licence: string) {
  const files = new Map<string, Buffer>();
  const face = (style: string) => {
    const bytes = Buffer.from(`${name}-${style}-bytes`);
    const hash = sha(bytes);
    files.set(`${hash}.ttf`, bytes);
    return { file: `${hash}.ttf`, sha256: hash };
  };
  return {
    name,
    licence,
    files,
    body: {
      name,
      licence,
      regular: face('regular'),
      bold: face('bold'),
      italic: face('italic'),
      boldItalic: face('boldItalic'),
    },
  };
}

/** Writes a font directory for the given families and loads it as the service's font set. */
async function catalogueOf(
  families: Array<ReturnType<typeof family>>,
  baseUrl: string,
): Promise<FontCatalogue> {
  const d = await mkdtemp(join(tmpdir(), 'docedit-font-route-'));
  dirs.push(d);
  for (const f of families)
    for (const [name, bytes] of f.files) await writeFile(join(d, name), bytes);
  await writeFile(
    join(d, 'fonts.json'),
    JSON.stringify({ version: 1, families: families.map((f) => f.body) }),
  );
  return loadFontCatalogue(d, baseUrl);
}

async function serve(catalogue: FontCatalogue): Promise<Harness> {
  const h = await startHarness('memory', { fonts: catalogue });
  harnesses.push(h);
  return h;
}

async function manifestOf(h: Harness) {
  const res = await h.call('GET', '/v1/fonts', { token: h.serviceJwt() });
  expect(res.status).toBe(200);
  return res.json as {
    version: string;
    defaultFamily: string | null;
    families: ManifestFamily[];
  };
}

const OPEN = family('Serif Text', 'OFL-1.1');
const CLOSED = family('Closed Sans', 'LicenseRef-Proprietary');
const BASE = 'https://docs.example.test/fonts';

describe('GET /v1/fonts (PRO-067)', () => {
  it('returns the families with their styles, file URLs, hashes, licences and the manifest version (criterion 1)', async () => {
    const h = await serve(await catalogueOf([OPEN], BASE));
    const m = await manifestOf(h);
    expect(m.version).toMatch(/^[0-9a-f]{64}$/);
    expect(m.families).toHaveLength(1);
    const f = m.families[0]!;
    expect(f).toMatchObject({ family: 'Serif Text', licence: 'OFL-1.1', role: 'text' });
    expect(f.faces.map((x) => x.style).sort()).toEqual(
      ['bold', 'boldItalic', 'italic', 'regular'].sort(),
    );
    for (const face of f.faces) {
      expect(face.url.startsWith(`${BASE}/`)).toBe(true);
      expect(face.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(face.bytes).toBeGreaterThan(0);
    }
  });

  it('serves each file with content that matches its hash in the manifest (criterion 2)', async () => {
    const h = await serve(await catalogueOf([OPEN], BASE));
    const m = await manifestOf(h);
    for (const face of m.families[0]!.faces) {
      // The file URL names the service's own route; the test asks the service for the file by its name.
      const name = face.url.slice(face.url.lastIndexOf('/') + 1);
      const res = await fetch(`${h.base}/fonts/${name}`);
      expect(res.status).toBe(200);
      const body = Buffer.from(await res.arrayBuffer());
      expect(sha(body)).toBe(face.sha256);
      expect(res.headers.get('content-type')).toBeTruthy();
    }
  });

  it('changes the manifest version when the set of fonts changes, and keeps it otherwise (criterion 3)', async () => {
    const first = await manifestOf(await serve(await catalogueOf([OPEN], BASE)));
    const again = await manifestOf(await serve(await catalogueOf([OPEN], BASE)));
    const bigger = await manifestOf(
      await serve(await catalogueOf([OPEN, family('Mono', 'OFL-1.1')], BASE)),
    );
    expect(again.version).toBe(first.version);
    expect(bigger.version).not.toBe(first.version);
  });

  it('lists only families whose licences permit bundling and server use (criterion 4)', async () => {
    const h = await serve(await catalogueOf([OPEN, CLOSED], BASE));
    const m = await manifestOf(h);
    expect(m.families.map((f) => f.family)).toEqual(['Serif Text']);
    for (const f of m.families) expect(FONT_LICENCES).toContain(f.licence);
  });
});
