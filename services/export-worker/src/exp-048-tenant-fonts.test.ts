/**
 * EXP-048 criteria 1 and 2 (export worker, Node.js only; the compile is a fake that records the
 * files it is given): a font a tenant added is in that tenant's jobs and in no other tenant's.
 *
 * - `tenantFonts` (tenant-fonts.ts) merges the tenant's faces into the job's manifest and returns
 *   them as `tenant-fonts/<hash>` files; it leaves out a face that does not permit server use, a
 *   WOFF2 face, a file that is missing or does not match its hash, and a name a shared family has,
 *   and names each in a `tenant_font_unavailable` warning.
 * - The export handler asks the source for the job's own tenant only. Two tenants whose sources
 *   hold the same hash get different results: the tenant that owns the file has it mounted, the
 *   other has neither the family nor the file, although both jobs read the same document.
 *
 * The class reads the files in a real compile: `packages/export-latex/src/exp-048-tenant-font.compile.test.ts`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  JobRunner,
  MemoryJobQueue,
  MemoryObjectStore,
  MemoryTenantFontStore,
  objectKeys,
  type JobQueue,
  type JobRecord,
} from '@docedit/document-service';
import { uuid7 } from '@docedit/model';
import { demoDocument } from '../test/documents.ts';
import { TEST_FONTS } from '../test/fonts.ts';
import type { ContentStores } from './content.ts';
import { createExportHandler } from './job.ts';
import { LIMITS, type CompileResult, type SandboxOptions } from './sandbox.ts';
import {
  lineHeightOf,
  tenantFontSource,
  tenantFonts,
  type TenantFontFace,
  type TenantFontSource,
} from './tenant-fonts.ts';

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** A font with only the tables the worker reads: `head` (units per em) and `OS/2` (win ascent, descent). */
function fakeFont(ascent: number, descent: number, tag: number): Uint8Array {
  const out = new Uint8Array(12 + 32 + 54 + 96);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x00010000);
  v.setUint16(4, 2);
  const put = (i: number, name: string, offset: number, length: number): void => {
    for (let k = 0; k < 4; k++) out[12 + 16 * i + k] = name.charCodeAt(k);
    v.setUint32(12 + 16 * i + 8, offset);
    v.setUint32(12 + 16 * i + 12, length);
  };
  put(0, 'head', 44, 54);
  put(1, 'OS/2', 98, 96);
  v.setUint16(44 + 18, 1000);
  v.setUint16(98 + 74, ascent);
  v.setUint16(98 + 76, descent);
  out[190] = tag; // makes each font's hash its own
  return out;
}

interface Stored extends TenantFontFace {
  bytes: Uint8Array;
}

function face(family: string, style: TenantFontFace['style'], tag: number, over = {}): Stored {
  const bytes = fakeFont(1000, 300, tag);
  return {
    sha256: sha(bytes),
    family,
    style,
    format: 'truetype',
    licence: 'Licensed to Acme',
    serverUse: true,
    bytes,
    ...over,
  };
}

/** A source in which each tenant holds its own faces; a read for another tenant's hash answers null. */
function source(byTenant: Record<string, Stored[]>): TenantFontSource & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    faces: async (tenant) => {
      asked.push(tenant);
      return (byTenant[tenant] ?? []).map(({ bytes: _b, ...f }) => f);
    },
    read: async (tenant, hash) =>
      (byTenant[tenant] ?? []).find((f) => f.sha256 === hash)?.bytes ?? null,
  };
}

describe('lineHeightOf', () => {
  it('is (win ascent + win descent) / units per em in thousandths', () => {
    expect(lineHeightOf(fakeFont(1000, 300, 0))).toBe(1300);
    expect(lineHeightOf(fakeFont(1362, 0, 0))).toBe(1362);
  });

  it('is null for bytes that are not a font', () => {
    expect(lineHeightOf(new Uint8Array(5))).toBeNull();
    expect(lineHeightOf(new Uint8Array(400))).toBeNull();
  });

  const local = fileURLToPath(new URL('../out/fonts-local/fonts.json', import.meta.url));
  it.skipIf(!existsSync(local))(
    'gives the line height the image build records for its faces',
    () => {
      const dir = fileURLToPath(new URL('../out/fonts-local/', import.meta.url));
      const m = JSON.parse(readFileSync(local, 'utf8')) as {
        families: Array<{ lineHeight: number; regular: { file: string } }>;
      };
      for (const f of m.families.slice(0, 3))
        expect(lineHeightOf(new Uint8Array(readFileSync(dir + f.regular.file)))).toBe(f.lineHeight);
    },
  );
});

describe('EXP-048 criterion 1: the tenant has its font in its job', () => {
  const t = 'tenant-a';
  const regular = face('Acme Sans', 'regular', 1);
  const bold = face('Acme Sans', 'bold', 2);

  it('adds the family to the manifest and the files to the compile', async () => {
    const r = await tenantFonts(source({ [t]: [regular, bold] }), t, TEST_FONTS);
    expect(r.diagnostics).toEqual([]);
    expect(r.manifest.families.map((f) => f.name)).toEqual(['Noto Serif', 'Acme Sans']);
    const fam = r.manifest.families[1]!;
    expect(fam.regular.file).toBe(`${regular.sha256}.ttf`);
    expect(fam.bold.file).toBe(`${bold.sha256}.ttf`);
    expect(fam.lineHeight).toBe(1300);
    expect(fam.serverUse).toBe(true);
    // The styles the tenant did not add take the nearest face it has.
    expect(fam.italic.file).toBe(fam.regular.file);
    expect(fam.boldItalic.file).toBe(fam.bold.file);
    expect(Object.keys(r.files).sort()).toEqual(
      [`tenant-fonts/${regular.sha256}.ttf`, `tenant-fonts/${bold.sha256}.ttf`].sort(),
    );
    expect(r.manifest.families[0]).toBe(TEST_FONTS.families[0]);
  });

  it('leaves out a face that does not permit server use, and names the family', async () => {
    const screen = face('Acme Screen', 'regular', 3, { serverUse: false });
    const r = await tenantFonts(source({ [t]: [screen, regular] }), t, TEST_FONTS);
    expect(r.manifest.families.map((f) => f.name)).toEqual(['Noto Serif', 'Acme Sans']);
    expect(Object.keys(r.files)).toEqual([`tenant-fonts/${regular.sha256}.ttf`]);
    expect(r.diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ['tenant_font_unavailable', 'warning'],
    ]);
    expect(r.diagnostics[0]!.message).toContain('Acme Screen');
  });

  it("does not load a WOFF2 face, but uses the family's other faces", async () => {
    const web = face('Acme Sans', 'italic', 4, { format: 'woff2' });
    const r = await tenantFonts(source({ [t]: [regular, web] }), t, TEST_FONTS);
    expect(r.manifest.families.map((f) => f.name)).toContain('Acme Sans');
    expect(Object.keys(r.files)).toEqual([`tenant-fonts/${regular.sha256}.ttf`]);
    expect(r.diagnostics[0]!.message).toContain('WOFF2');
  });

  it('leaves out a family whose file is missing or does not match its hash', async () => {
    const gone = face('Acme Gone', 'regular', 5);
    const src = source({ [t]: [gone, regular] });
    const read = src.read;
    const swapped = sha(fakeFont(1, 1, 9));
    src.read = async (tenant, hash) =>
      hash === gone.sha256 ? null : hash === swapped ? changed.bytes : read(tenant, hash);
    const changed = face('Acme Changed', 'regular', 6);
    const faces = src.faces;
    src.faces = async (tenant) => [...(await faces(tenant)), { ...changed, sha256: swapped }];
    const r = await tenantFonts(src, t, TEST_FONTS);
    expect(r.manifest.families.map((f) => f.name)).toEqual(['Noto Serif', 'Acme Sans']);
    expect(r.diagnostics.map((d) => d.message).join('\n')).toMatch(/Acme Gone.*missing/);
    expect(r.diagnostics.map((d) => d.message).join('\n')).toMatch(/Acme Changed.*hash/);
  });

  it('does not let a tenant family take the name of a shared family', async () => {
    const r = await tenantFonts(source({ [t]: [face('noto serif', 'regular', 7)] }), t, TEST_FONTS);
    expect(r.manifest.families).toEqual(TEST_FONTS.families);
    expect(r.diagnostics[0]!.message).toContain('noto serif');
  });
});

describe("EXP-048 criterion 2: another tenant's job does not mount it", () => {
  it('gives the other tenant no family and no file for the same hash', async () => {
    const regular = face('Acme Sans', 'regular', 1);
    const src = source({ 'tenant-a': [regular] });
    const a = await tenantFonts(src, 'tenant-a', TEST_FONTS);
    const b = await tenantFonts(src, 'tenant-b', TEST_FONTS);
    expect(Object.keys(a.files)).toHaveLength(1);
    expect(b.files).toEqual({});
    expect(b.manifest).toEqual(TEST_FONTS);
    expect(src.asked).toEqual(['tenant-a', 'tenant-b']);
  });

  it('does not read the bytes of a hash the tenant does not hold, even when it is listed', async () => {
    // A source that lists a face for tenant B whose bytes are tenant A's: the read answers for B only.
    const regular = face('Acme Sans', 'regular', 1);
    const src = source({ 'tenant-a': [regular], 'tenant-b': [] });
    src.faces = async () => [{ ...regular, bytes: undefined as never } as TenantFontFace];
    const b = await tenantFonts(src, 'tenant-b', TEST_FONTS);
    expect(b.files).toEqual({});
    expect(b.diagnostics[0]!.message).toContain('Acme Sans');
  });
});

// ---------------------------------------------------------------------------------------------
// The handler, with a fake compile.

const INCARNATION = 'inc-exp048';

function stores(): ContentStores {
  const content = demoDocument().envelope;
  return {
    logs: {
      head: async () => ({ seq: 0, epoch: 1, owner: null, incarnation: INCARNATION }),
      read: async () => [],
    },
    checkpoints: {
      latest: async () => ({ seq: 0, content }) as never,
      get: async () => null,
    },
    documents: {
      get: async (ref) =>
        ({
          id: ref.doc,
          tenant: ref.tenant,
          title: 'Fonts',
          incarnation: INCARNATION,
          deletedAt: null,
        }) as never,
    },
  };
}

const RAW_LAYOUT = JSON.stringify({
  v: 1,
  level: 2,
  pages: [{ n: 1, start: [1, 0, 3_000_000], first: [1, 1] }],
  blocks: { '1': [1, 3_000_000, 0] },
  lines: [[1, 0, 1, 3_000_000]],
});

async function exportFor(
  tenant: string,
  fonts: TenantFontSource,
): Promise<{ job: JobRecord; files: Record<string, string | Uint8Array> }> {
  let seen: Record<string, string | Uint8Array> = {};
  const compile = async (
    files: Readonly<Record<string, string | Uint8Array>>,
    opts: SandboxOptions,
  ): Promise<CompileResult> => {
    seen = { ...files };
    const n = opts.maxPasses ?? 2;
    return {
      ok: true,
      exitCode: 0,
      timedOut: false,
      outputOverflow: false,
      cancelled: false,
      passes: Array.from({ length: n }, (_, i) => ({ pass: i + 1, rc: 0, ms: 100 })),
      converged: n > 1,
      pdf: new TextEncoder().encode('%PDF-2.0 test'),
      log: 'This is LuaHBTeX\n',
      layoutRaw: RAW_LAYOUT,
      stderr: '',
      wallMs: 1500,
      stdout: new Uint8Array(),
      name: 'docedit-exp048',
      limits: { ...LIMITS },
      passTimeoutSeconds: 110,
    };
  };
  const handler = createExportHandler({
    stores: stores(),
    outputs: { putExport: async () => {} },
    fonts: async () => TEST_FONTS,
    tenantFonts: fonts,
    imageId: async () => `sha256:${'c'.repeat(64)}`,
    compile,
  });
  const queue: JobQueue = new MemoryJobQueue();
  const runner = new JobRunner({
    queue,
    handlers: { export: handler },
    worker: 'w-exp048',
    leaseMs: 60_000,
    idleMs: 10,
    retryAfterMs: 0,
  });
  const doc = uuid7();
  const job = await queue.enqueue(tenant, {
    kind: 'export',
    doc,
    createdBy: 'user-1',
    payload: {
      doc,
      target: 'pdf',
      seq: 0,
      incarnation: INCARNATION,
      options: {},
      requester: 'user-1',
      role: 'editor',
      view: 'v',
      hiddenRegions: [],
      hiddenValues: [],
    },
  });
  await runner.runOnce();
  return { job: (await queue.get(tenant, job.id)) as JobRecord, files: seen };
}

describe("EXP-048: the export handler mounts a tenant's fonts for that tenant's job only", () => {
  const regular = face('Acme Sans', 'regular', 1);

  it("compiles the owner's job with the font file and a manifest that names it", async () => {
    const owner = uuid7();
    const { job, files } = await exportFor(owner, source({ [owner]: [regular] }));
    expect(job.state).toBe('completed');
    expect(Object.keys(files)).toContain(`tenant-fonts/${regular.sha256}.ttf`);
    expect(files[`tenant-fonts/${regular.sha256}.ttf`]).toEqual(regular.bytes);
    expect(String(files['styles.tex'])).toContain(`${regular.sha256}.ttf`);
  });

  it("compiles another tenant's job without the file and without the name, for the same hash", async () => {
    const owner = uuid7();
    const other = uuid7();
    const src = source({ [owner]: [regular] });
    const { job, files } = await exportFor(other, src);
    expect(job.state).toBe('completed');
    expect(src.asked).toEqual([other]);
    expect(Object.keys(files).filter((n) => n.startsWith('tenant-fonts/'))).toEqual([]);
    expect(String(files['styles.tex'])).not.toContain(regular.sha256);
  });
});

describe('EXP-048: the source of the worker reads the rows and the object prefix of a tenant', () => {
  const A = uuid7();
  const B = uuid7();
  it('serves tenant A its font and tenant B nothing, from one store and one bucket', async () => {
    const regular = face('Acme Sans', 'regular', 1);
    const store = new MemoryTenantFontStore();
    const objects = new MemoryObjectStore();
    await store.add({
      tenant: A,
      sha256: regular.sha256,
      family: regular.family,
      style: regular.style,
      weight: 400,
      italic: false,
      format: 'truetype',
      bytes: regular.bytes.length,
      licence: regular.licence,
      serverUse: true,
      addedBy: 'admin',
      addedAt: 0,
    });
    await objects.put(`${objectKeys.prefix(A)}fonts/${regular.sha256}`, regular.bytes);
    const src = tenantFontSource(store, objects);
    const a = await tenantFonts(src, A, TEST_FONTS);
    const b = await tenantFonts(src, B, TEST_FONTS);
    expect(a.manifest.families.map((f) => f.name)).toContain('Acme Sans');
    expect(Object.keys(a.files)).toEqual([`tenant-fonts/${regular.sha256}.ttf`]);
    expect(b.manifest).toEqual(TEST_FONTS);
    expect(b.files).toEqual({});
    // The bytes of A's hash are not under B's prefix.
    expect(await src.read(B, regular.sha256)).toBeNull();
  });
});
