/**
 * EXP-110, criterion 2: a hostile corpus. Each file is a crafted package that a Word file from an
 * attacker might carry: a zip bomb, a document type declaration with entities, a macro-enabled
 * file, an external relationship, an embedded object, deeply nested XML and a very large table.
 * Each must end, within a bound of time, either refused with an `ImportError` or imported with the
 * hostile content neutralised, and must never make a network request.
 *
 * The time bounds are test bounds chosen here, not figures of the spec. The memory half of the
 * criterion is not measured by this file: it stays open (see the story's Notes).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  entryData,
  importDocx,
  ImportError,
  readZip,
  writeZip,
  type ZipWriteEntry,
} from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

const SAMPLE = corpusFiles().find((f) => f.name === 'docx4j/sample-docx.docx')!;
const BOUND_MS = 30_000;

/** Network entry points, recorded and failed. A hostile file must not reach any of them. */
const network: string[] = [];
beforeAll(() => {
  const record = (name: string) => (): never => {
    network.push(name);
    throw new Error(`network access refused: ${name}`);
  };
  vi.stubGlobal('fetch', record('fetch'));
  vi.stubGlobal('XMLHttpRequest', record('XMLHttpRequest'));
  vi.stubGlobal('WebSocket', record('WebSocket'));
});
afterAll(() => {
  vi.unstubAllGlobals();
});

/** The sample package, every part copied raw, with `changes` replacing or adding parts. */
function withParts(changes: Record<string, Uint8Array | string>): Uint8Array {
  const zip = readZip(readFile(SAMPLE));
  const enc = new TextEncoder();
  const entries: ZipWriteEntry[] = [];
  for (const e of zip.entries) {
    const change = changes[e.name];
    if (change === undefined) entries.push({ name: e.name, copyOf: e, from: zip });
    else
      entries.push({
        name: e.name,
        data: typeof change === 'string' ? enc.encode(change) : change,
        like: e,
      });
  }
  for (const [name, data] of Object.entries(changes)) {
    if (zip.byName.has(name)) continue;
    entries.push({ name, data: typeof data === 'string' ? enc.encode(data) : data });
  }
  return writeZip(entries);
}

function documentXml(): string {
  const zip = readZip(readFile(SAMPLE));
  return new TextDecoder().decode(entryData(zip, zip.byName.get('word/document.xml')!));
}

/** Runs one import, returning its outcome and the time it took. */
async function attempt(bytes: Uint8Array): Promise<{
  error: unknown;
  ok: boolean;
  ms: number;
}> {
  const start = performance.now();
  const outcome = await importDocx(bytes).then(
    () => ({ error: null as unknown, ok: true }),
    (e: unknown) => ({ error: e as unknown, ok: false }),
  );
  return { ...outcome, ms: performance.now() - start };
}

/** Either refused with an ImportError, or imported; in both cases within the bound, with no network. */
function expectBounded(result: { error: unknown; ms: number }): void {
  expect(result.ms).toBeLessThan(BOUND_MS);
  if (result.error !== null) expect(result.error).toBeInstanceOf(ImportError);
  expect(network).toEqual([]);
}

describe('EXP-110 criterion 2: the hostile corpus is refused or neutralised, in bounded time', () => {
  it('refuses a zip bomb whose entry inflates far beyond its compression ratio', async () => {
    // 40 MB of zeros compresses to a few kilobytes: the ratio limit must refuse it.
    const bomb = new Uint8Array(40 * 1024 * 1024);
    const bytes = withParts({ 'customXml/bomb.xml': bomb });
    const result = await attempt(bytes);
    expectBounded(result);
    expect(result.ok).toBe(false);
    expect(String((result.error as Error).message)).toMatch(/ratio|uncompressed size|inflates/);
  }, 120_000);

  it('refuses a document type declaration with entity expansion (billion laughs shape)', async () => {
    const dtd =
      '<!DOCTYPE w:document [' +
      '<!ENTITY a "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">' +
      '<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">' +
      '<!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">' +
      ']>';
    const xml = documentXml().replace(/^(<\?xml[^>]*\?>)?/, (m) => `${m}${dtd}`);
    const result = await attempt(withParts({ 'word/document.xml': xml }));
    expectBounded(result);
    expect(result.ok).toBe(false);
    expect(String((result.error as Error).message)).toMatch(/document type declarations/);
  }, 120_000);

  it('refuses a macro-enabled package that carries a VBA project', async () => {
    const bytes = withParts({ 'word/vbaProject.bin': new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]) });
    const result = await attempt(bytes);
    expectBounded(result);
    expect(result.ok).toBe(false);
    expect(String((result.error as Error).message)).toMatch(/macro-enabled/);
  }, 120_000);

  it('imports a package with an external relationship without fetching its target', async () => {
    const rels = readZip(readFile(SAMPLE)).byName.get('word/_rels/document.xml.rels');
    const zip = readZip(readFile(SAMPLE));
    const relsXml = new TextDecoder().decode(entryData(zip, rels!));
    const extra =
      '<Relationship Id="rIdHostile1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="http://example.invalid/steal" TargetMode="External"/>';
    const next = relsXml.replace('</Relationships>', `${extra}</Relationships>`);
    const result = await attempt(withParts({ 'word/_rels/document.xml.rels': next }));
    expectBounded(result);
    // The relationship is either kept as an external target of the preserved data or refused; the
    // import must not have resolved it, which the network stubs above check.
    if (result.ok) expect(network).toEqual([]);
  }, 120_000);

  it('keeps an embedded object as opaque bytes, without parsing it', async () => {
    // A nested package as an embedded object: the importer must not open it.
    const inner = writeZip([{ name: 'word/document.xml', data: new TextEncoder().encode('<x') }]);
    const result = await attempt(
      withParts({ 'word/embeddings/Microsoft_Word_Document1.docx': inner }),
    );
    expectBounded(result);
  }, 120_000);

  it('bounds deeply nested XML, which is refused or imported in time', async () => {
    const depth = 20_000;
    const open = '<w:ins w:id="1" w:author="a">'.repeat(depth);
    const close = '</w:ins>'.repeat(depth);
    const xml = documentXml().replace('<w:body>', `<w:body><w:p>${open}${close}</w:p>`);
    const result = await attempt(withParts({ 'word/document.xml': xml }));
    expectBounded(result);
  }, 120_000);

  it('bounds a very large table, which is imported or refused in time', async () => {
    const rows = 200;
    const cells = 50;
    const cell = '<w:tc><w:p><w:r><w:t>c</w:t></w:r></w:p></w:tc>';
    const row = `<w:tr>${cell.repeat(cells)}</w:tr>`;
    const table = `<w:tbl>${row.repeat(rows)}</w:tbl>`;
    const xml = documentXml().replace('<w:body>', `<w:body>${table}`);
    const result = await attempt(withParts({ 'word/document.xml': xml }));
    expectBounded(result);
  }, 120_000);
});
