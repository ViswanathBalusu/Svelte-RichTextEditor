/**
 * SEC-039 criterion 7: the importer fuzz target of SEC-059 runs in CI and finds no crash or hang.
 *
 * SEC-059 lists the DOCX importer as a phase-2 target (`docx-importer` in fuzz.test.ts). The
 * target itself is the export-docx fuzz of EXP-110 (packages/export-docx/test/fuzz.test.ts). This
 * file runs the same kind of target from the security suite, with the SEC-059 oracles:
 *
 * - a crash is any exception other than `ImportError`, the importer's one refusal type;
 * - a hang is an import slower than its bound. The bound is a test bound, not a spec value:
 *   1 second plus ten times the unmutated sample's import time, measured in `beforeAll`;
 * - a network request is a call to `fetch`, `XMLHttpRequest` or `WebSocket`, all stubbed to record.
 *
 * Inputs: byte flips and truncations of the sample package, XML fragments inserted into the main
 * part (so the parser and the importer see them under a valid CRC), and random bytes. Drawn by
 * fast-check at a fixed seed, so every run is repeatable. `FUZZ_RUNS` raises the run count.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  entryData,
  ImportError,
  importDocx,
  readZip,
  writeZip,
  type ZipWriteEntry,
} from '../../../packages/export-docx/src/index.ts';

const SAMPLE = fileURLToPath(
  new URL('../../../packages/export-docx/corpus/docx4j/sample-docx.docx', import.meta.url),
);
const sampleBytes = new Uint8Array(readFileSync(SAMPLE));
const RUNS = Number(process.env['FUZZ_RUNS'] ?? 150);
const SEED = 39;

const FRAGMENTS = [
  '<w:p/>',
  '<w:p>',
  '</w:p>',
  '<w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>',
  '<w:sz w:val="99999999999999999999"/>',
  '<w:ins w:id="1" w:author="a"><w:r><w:t>y</w:t></w:r></w:ins>',
  '<w:hyperlink r:id="rIdNoSuch"><w:r><w:t>l</w:t></w:r></w:hyperlink>',
  '<w:fldSimple w:instr="INCLUDETEXT &quot;http://example.invalid/x&quot;"/>',
  '&#0;',
  '&#xD800;',
  '&#x110000;',
  '<![CDATA[',
  '<!-- -->',
  '<!DOCTYPE w [<!ENTITY a "aaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]>',
  '<!ENTITY x SYSTEM "http://example.invalid/e">',
  '\u0000',
  '￾',
] as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const fraction = fc.double({ min: 0, max: 1, noNaN: true });

/** A sample with some bytes replaced: the container layer and the compressed data both see it. */
const byteFlips: fc.Arbitrary<Uint8Array> = fc
  .array(fc.record({ at: fraction, value: fc.nat(255) }), { minLength: 1, maxLength: 6 })
  .map((flips) => {
    const out = sampleBytes.slice();
    for (const f of flips) out[Math.min(out.length - 1, Math.floor(f.at * out.length))] = f.value;
    return out;
  });

/** A prefix of the sample. */
const truncations: fc.Arbitrary<Uint8Array> = fraction.map((f) =>
  sampleBytes.slice(0, Math.floor(f * sampleBytes.length)),
);

/** Random bytes that are not a package at all. */
const randomBytes: fc.Arbitrary<Uint8Array> = fc
  .uint8Array({ maxLength: 4096 })
  .map((b) => new Uint8Array(b));

/** One XML fragment inserted into the main part, repackaged so that the CRC of the part is valid. */
const fragmentInserts: fc.Arbitrary<Uint8Array> = fc
  .record({ at: fraction, fragment: fc.constantFrom(...FRAGMENTS) })
  .map(({ at, fragment }) => {
    const zip = readZip(sampleBytes);
    const entries: ZipWriteEntry[] = zip.entries.map((e) => {
      if (e.name !== 'word/document.xml') return { name: e.name, copyOf: e, from: zip };
      const text = decoder.decode(entryData(zip, e));
      const cut = Math.floor(at * (text.length + 1));
      const next = text.slice(0, cut) + fragment + text.slice(cut);
      return { name: e.name, data: encoder.encode(next), like: e };
    });
    return writeZip(entries);
  });

const inputs: fc.Arbitrary<Uint8Array> = fc.oneof(
  byteFlips,
  truncations,
  randomBytes,
  fragmentInserts,
);

const tally = { imported: 0, refused: 0 };
const networkCalls: unknown[] = [];
let limitMs = 0;

beforeAll(async () => {
  const refuse = (what: string) =>
    function (...args: unknown[]): never {
      networkCalls.push([what, ...args]);
      throw new Error(`a network request was made through ${what}`);
    };
  vi.stubGlobal('fetch', refuse('fetch'));
  vi.stubGlobal('XMLHttpRequest', refuse('XMLHttpRequest'));
  vi.stubGlobal('WebSocket', refuse('WebSocket'));
  await importDocx(sampleBytes);
  const start = performance.now();
  await importDocx(sampleBytes);
  limitMs = 1_000 + 10 * (performance.now() - start);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

/** Imports the bytes. A non-`ImportError` exception is a crash; an import over the bound is a hang. */
async function importChecked(bytes: Uint8Array): Promise<void> {
  const start = performance.now();
  try {
    await importDocx(bytes);
    tally.imported++;
  } catch (e) {
    if (!(e instanceof ImportError)) throw e;
    tally.refused++;
  }
  const elapsed = performance.now() - start;
  expect(elapsed, 'an import finishes within its bound').toBeLessThanOrEqual(limitMs);
}

describe('SEC-039 criterion 7: the DOCX importer fuzz target finds no crash or hang', () => {
  it('survives byte flips, truncations, random bytes and fragments inserted into the main part', async () => {
    await fc.assert(
      fc.asyncProperty(inputs, async (bytes) => {
        await importChecked(bytes);
      }),
      { numRuns: RUNS, seed: SEED, verbose: false },
    );
  }, 300_000);

  it('is not vacuous: some inputs are refused and some are imported', () => {
    expect(tally.refused).toBeGreaterThan(0);
    expect(tally.imported).toBeGreaterThan(0);
  });

  it('made no network request in any of the runs above', () => {
    expect(networkCalls).toEqual([]);
  });
});
