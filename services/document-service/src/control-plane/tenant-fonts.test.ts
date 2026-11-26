// What an export job of a tenant may load from the fonts tenants add (BE-048 criterion 3, the
// service's half; owner decisions 62 and 95). The check is a stub that reads the family from the
// bytes; the real check is covered by the asset worker's tests and by be-048-tenant-fonts.test.ts.
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryAudit } from '../data-plane/memory-ports.ts';
import { MemoryObjectStore } from '../objects/store.ts';
import { emptyCatalogue } from './fonts.ts';
import { MemoryTenantFontStore, TenantFontService, type FontChecker } from './tenant-fonts.ts';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const text = (s: string) => new TextEncoder().encode(s);

/** A "font" is the text `family|bold`; a check that fails for anything else. */
const check: FontChecker = async (bytes) => {
  const [family, bold] = new TextDecoder().decode(bytes).split('|');
  if (!family) return { ok: false, code: 'validation_failed', message: 'not a font' };
  return {
    ok: true,
    font: {
      family,
      weight: bold === 'b' ? 700 : 400,
      bold: bold === 'b',
      italic: false,
      format: 'truetype',
    },
  };
};

function service() {
  let t = 1_000;
  const objects = new MemoryObjectStore();
  const svc = new TenantFontService({
    store: new MemoryTenantFontStore(),
    objects,
    audit: new MemoryAudit(),
    check,
    fileBase: 'https://docs.example/v1/tenant-fonts',
    now: () => t++,
  });
  return { svc, objects };
}

const body = (bytes: Uint8Array, serverUse: boolean) => ({
  mime: 'font/ttf',
  content: Buffer.from(bytes).toString('base64'),
  licence: 'Brand licence',
  serverUse,
});

describe('the fonts of an export job (BE-048 criterion 3, service half)', () => {
  const a = randomUUID();
  const b = randomUUID();
  const shared = emptyCatalogue();

  it("does not give a tenant's font to the job of another tenant, with the same hash or not", async () => {
    const { svc, objects } = service();
    const file = text('Brand Serif|r');
    await svc.add(a, 'admin', body(file, true));
    const mine = await svc.jobFonts(a, shared);
    expect(mine.manifest.families.map((f) => f.family)).toEqual(['Brand Serif']);
    expect(await mine.read(sha(file))).toEqual(file);
    // Another tenant's job: no family, no bytes for that hash, though the object exists for A.
    const theirs = await svc.jobFonts(b, shared);
    expect(theirs.manifest.families).toEqual([]);
    expect(await theirs.read(sha(file))).toBeNull();
    expect(await objects.exists(`tenants/${a}/fonts/${sha(file)}`)).toBe(true);
    expect(await objects.exists(`tenants/${b}/fonts/${sha(file)}`)).toBe(false);
    // Once B adds the same file it is B's own copy, and A's removal leaves B's alone.
    await svc.add(b, 'admin', body(file, true));
    expect(await (await svc.jobFonts(b, shared)).read(sha(file))).toEqual(file);
    await svc.remove(a, 'admin', sha(file));
    expect(await (await svc.jobFonts(a, shared)).read(sha(file))).toBeNull();
    expect(await (await svc.jobFonts(b, shared)).read(sha(file))).toEqual(file);
  });

  it('leaves out a font whose declaration does not allow server use (decision 62), on screen it stays', async () => {
    const { svc } = service();
    const screenOnly = text('Screen Sans|r');
    const both = text('Both Sans|r');
    await svc.add(a, 'admin', body(screenOnly, false));
    await svc.add(a, 'admin', body(both, true));
    const job = await svc.jobFonts(a, shared);
    expect(job.manifest.families.map((f) => f.family)).toEqual(['Both Sans']);
    expect(await job.read(sha(screenOnly))).toBeNull();
    expect((await svc.manifest(a, shared)).families.map((f) => f.family)).toEqual([
      'Both Sans',
      'Screen Sans',
    ]);
  });

  it('changes the manifest version with the tenant set and with the server-use flag', async () => {
    const { svc } = service();
    const empty = (await svc.manifest(a, shared)).version;
    const file = text('Flag Sans|r');
    await svc.add(a, 'admin', body(file, true));
    const withFont = (await svc.manifest(a, shared)).version;
    await svc.remove(a, 'admin', sha(file));
    await svc.add(a, 'admin', body(file, false));
    const flagged = (await svc.manifest(a, shared)).version;
    expect(new Set([empty, withFont, flagged]).size).toBe(3);
  });

  it('gives a tenant without fonts the shared manifest unchanged', async () => {
    const { svc } = service();
    expect(await svc.manifest(a, shared)).toBe(shared.manifest);
  });
});
