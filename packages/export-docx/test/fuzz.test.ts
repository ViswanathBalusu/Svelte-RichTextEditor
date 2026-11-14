/**
 * EXP-110, criterion 3: random and mutated packages, fed to the importer, never crash it, never
 * hang it and never make a network request. Seeds are three real corpus files. Drawn by fast-check
 * at fixed seeds, so every run is repeatable.
 *
 * Three families of input, so that mutations reach every layer:
 * - Part mutations: an XML part is decompressed, mutated (byte flips, truncation, deletion,
 *   duplication, random bytes, inserted tags, attributes, entities, a document type declaration,
 *   external relationships, and deep nesting) and packaged again with `writeZip`, so the CRC and
 *   sizes are right and the mutated XML reaches the parser and the importer.
 * - Container mutations: byte flips and field overwrites in the central directory, in the local
 *   headers and anywhere in the file, positions drawn over the whole of each region.
 * - Random packages: entries with seed names or random names and random or XML-like content.
 *
 * Oracles. A crash is any exception other than `ImportError` (the importer's one refusal type; it
 * wraps ZIP, XML and UTF-8 refusals). A hang is an import slower than its bound: 1 second plus ten
 * times the unmutated seed's import time, measured at the start of the run. That bound is a test
 * bound chosen here, not a figure of the spec; on the development machine (Node.js 22, 2026-11-13)
 * the seeds import in about 9, 15 and 127 ms. An import that never returns blocks the event loop,
 * and only the test timeout catches it. A network request is a call to `fetch`, `XMLHttpRequest`
 * or `WebSocket`, all stubbed to record and throw.
 *
 * The test also counts where each input ended, and requires that part mutations mostly get past
 * the ZIP layer: a fuzz whose inputs all stop at the CRC check tests nothing else.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import {
  importDocx,
  ImportError,
  readZip,
  writeZip,
  entryData,
  ZipError,
  XmlError,
} from '../src/index.ts';
import type { ZipArchive, ZipWriteEntry } from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

interface Seed {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly zip: ZipArchive;
  /** Names of the XML parts (`.xml` and `.rels`). */
  readonly xmlParts: readonly string[];
  /** Milliseconds for one import of the unmutated seed, measured in `beforeAll`. */
  baseline: number;
}

const SEEDS: Seed[] = ['python-docx/tab-stops.docx', 'poi/comment.docx', 'docx4j/tables.docx'].map(
  (name) => {
    const bytes = readFile(corpusFiles().find((x) => x.name === name)!);
    const zip = readZip(bytes);
    const xmlParts = zip.entries.map((e) => e.name).filter((n) => /\.(xml|rels)$/.test(n));
    return { name, bytes, zip, xmlParts, baseline: 0 };
  },
);

/** Text fragments that exercise the XML parser and the importer's readers. */
const FRAGMENTS = [
  '<w:p>',
  '</w:p>',
  '<w:r><w:t xml:space="preserve">x</w:t></w:r>',
  '</w:r>',
  '<w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>',
  '<w:tc><w:tcPr><w:gridSpan w:val="65535"/><w:vMerge/></w:tcPr></w:tc>',
  '<w:gridCol w:w="-5"/>',
  '<w:numPr><w:ilvl w:val="99"/><w:numId w:val="-1"/></w:numPr>',
  '<w:pStyle w:val="NoSuchStyle"/>',
  '<w:sz w:val="99999999999999999999"/>',
  '<w:ins w:id="1" w:author="a"><w:r><w:t>y</w:t></w:r></w:ins>',
  '<w:del w:id="2" w:author="a"><w:r><w:delText>z</w:delText></w:r></w:del>',
  '<w:footnoteReference w:id="12345"/>',
  '<w:commentRangeStart w:id="7"/>',
  '<w:hyperlink r:id="rIdNoSuch"><w:r><w:t>l</w:t></w:r></w:hyperlink>',
  '<w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId999" r:link="rId998"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>',
  '<mc:AlternateContent><mc:Choice Requires="wps"><w:p/></mc:Choice><mc:Fallback/></mc:AlternateContent>',
  '<w:sectPr><w:pgSz w:w="0" w:h="-1"/><w:cols w:num="0"/></w:sectPr>',
  '<w:fldSimple w:instr="INCLUDETEXT &quot;http://example.invalid/x&quot;"/>',
  '<Relationship Id="rIdExt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="http://example.invalid/a.png" TargetMode="External"/>',
  '<Relationship Id="rIdTpl" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="file:///C:/x.dotm" TargetMode="External"/>',
  '<Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/>',
  ' w:val="',
  ' w:val="1" w:val="2"',
  ' xmlns:w="urn:not-wordml"',
  ' xmlns:="x"',
  '"',
  '>',
  '<',
  '&amp;',
  '&undefined;',
  '&#0;',
  '&#xD800;',
  '&#x110000;',
  '<![CDATA[',
  ']]>',
  '<!-- -->',
  '<?pi x?>',
  '<?xml version="1.0"?>',
  '<!DOCTYPE w [<!ENTITY a "aaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]>',
  '<!ENTITY x SYSTEM "http://example.invalid/e">',
  '\u0000',
  '\uFFFE',
  'é',
] as const;

const NEST_TAGS = [
  'w:p',
  'w:r',
  'w:tbl',
  'w:tc',
  'w:sdt',
  'w:sdtContent',
  'w:ins',
  'w:hyperlink',
  'w:smartTag',
  'w:customXml',
  'mc:AlternateContent',
  'x',
] as const;

const encoder = new TextEncoder();
const fraction = fc.double({ min: 0, max: 1, noNaN: true });

type PartMutation =
  | { kind: 'flip'; at: number; value: number }
  | { kind: 'truncate'; at: number }
  | { kind: 'delete'; at: number; length: number }
  | { kind: 'duplicate'; at: number; to: number; length: number }
  | { kind: 'bytes'; at: number; bytes: number[] }
  | { kind: 'text'; at: number; text: string }
  | { kind: 'nest'; at: number; tag: string; depth: number; closed: boolean };

const partMutation: fc.Arbitrary<PartMutation> = fc.oneof(
  fc.record({ kind: fc.constant('flip' as const), at: fraction, value: fc.nat(255) }),
  fc.record({ kind: fc.constant('truncate' as const), at: fraction }),
  fc.record({
    kind: fc.constant('delete' as const),
    at: fraction,
    length: fc.integer({ min: 1, max: 200 }),
  }),
  fc.record({
    kind: fc.constant('duplicate' as const),
    at: fraction,
    to: fraction,
    length: fc.integer({ min: 1, max: 400 }),
  }),
  fc.record({
    kind: fc.constant('bytes' as const),
    at: fraction,
    bytes: fc.array(fc.nat(255), { minLength: 1, maxLength: 32 }),
  }),
  fc.record({
    kind: fc.constant('text' as const),
    at: fraction,
    text: fc.constantFrom(...FRAGMENTS),
  }),
  fc.record({
    kind: fc.constant('text' as const),
    at: fraction,
    text: fc.string({ maxLength: 40 }),
  }),
  fc.record({
    kind: fc.constant('nest' as const),
    at: fraction,
    tag: fc.constantFrom(...NEST_TAGS),
    depth: fc.oneof(fc.integer({ min: 1, max: 50 }), fc.integer({ min: 1_000, max: 20_000 })),
    closed: fc.boolean(),
  }),
);

const splice = (data: Uint8Array, at: number, remove: number, insert: Uint8Array): Uint8Array => {
  const out = new Uint8Array(data.length - remove + insert.length);
  out.set(data.subarray(0, at), 0);
  out.set(insert, at);
  out.set(data.subarray(at + remove), at + insert.length);
  return out;
};

/** A position in [0, length] from a fraction. */
const pos = (f: number, length: number): number => Math.min(length, Math.floor(f * (length + 1)));

function mutatePart(data: Uint8Array, muts: readonly PartMutation[]): Uint8Array {
  let out = data;
  for (const m of muts) {
    const at = pos(m.at, out.length);
    switch (m.kind) {
      case 'flip':
        if (out.length === 0) break;
        out = out.slice();
        out[Math.min(at, out.length - 1)] = m.value;
        break;
      case 'truncate':
        out = out.slice(0, at);
        break;
      case 'delete':
        out = splice(out, at, Math.min(m.length, out.length - at), new Uint8Array());
        break;
      case 'duplicate': {
        const piece = out.slice(at, at + m.length);
        out = splice(out, pos(m.to, out.length), 0, piece);
        break;
      }
      case 'bytes':
        out = splice(out, at, 0, new Uint8Array(m.bytes));
        break;
      case 'text':
        out = splice(out, at, 0, encoder.encode(m.text));
        break;
      case 'nest': {
        const open = `<${m.tag}>`.repeat(m.depth);
        const close = m.closed ? `</${m.tag}>`.repeat(m.depth) : '';
        out = splice(out, at, 0, encoder.encode(open + close));
        break;
      }
    }
  }
  return out;
}

/** The seed with one part replaced; every other entry is copied raw, so only that part changed. */
function repackage(seed: Seed, part: string, data: Uint8Array): Uint8Array {
  const entries: ZipWriteEntry[] = seed.zip.entries.map((e) =>
    e.name === part ? { name: e.name, data, like: e } : { name: e.name, copyOf: e, from: seed.zip },
  );
  return writeZip(entries, seed.zip.comment);
}

type ContainerMutation =
  | { kind: 'flip'; region: 'cd' | 'local' | 'file'; at: number; value: number }
  | { kind: 'field'; region: 'cd' | 'local' | 'eocd'; at: number; value: number; wide: boolean };

const region = fc.constantFrom('cd' as const, 'local' as const, 'file' as const);
const containerMutation: fc.Arbitrary<ContainerMutation> = fc.oneof(
  fc.record({ kind: fc.constant('flip' as const), region, at: fraction, value: fc.nat(255) }),
  fc.record({
    kind: fc.constant('field' as const),
    region: fc.constantFrom('cd' as const, 'local' as const, 'eocd' as const),
    at: fraction,
    value: fc.oneof(fc.constantFrom(0, 1, 0x7f, 0xff, 0xffff, 0x7fffffff, 0xffffffff), fc.nat()),
    wide: fc.boolean(),
  }),
);

/** The byte ranges of a seed's structures: central directory with its end record, and local headers. */
function regions(seed: Seed): {
  cd: [number, number];
  eocd: [number, number];
  local: [number, number][];
} {
  const b = seed.bytes;
  let eocd = b.length - 22;
  while (
    eocd > 0 &&
    !(b[eocd] === 0x50 && b[eocd + 1] === 0x4b && b[eocd + 2] === 0x05 && b[eocd + 3] === 0x06)
  )
    eocd--;
  const cdOffset =
    (b[eocd + 16]! | (b[eocd + 17]! << 8) | (b[eocd + 18]! << 16) | (b[eocd + 19]! << 24)) >>> 0;
  const local = seed.zip.entries.map((e): [number, number] => [
    e.dataOffset - 30 - e.nameBytes.length - e.localExtra.length,
    e.dataOffset,
  ]);
  return { cd: [cdOffset, eocd], eocd: [eocd, b.length], local };
}

function mutateContainer(
  seed: Seed,
  muts: readonly ContainerMutation[],
  pickLocal: number,
): Uint8Array {
  const r = regions(seed);
  const out = seed.bytes.slice();
  const localRange = r.local[pickLocal % r.local.length]!;
  for (const m of muts) {
    const [lo, hi] =
      m.region === 'cd'
        ? r.cd
        : m.region === 'eocd'
          ? r.eocd
          : m.region === 'local'
            ? localRange
            : [0, out.length];
    const at = lo + Math.min(hi - lo - 1, Math.floor(m.at * (hi - lo)));
    if (m.kind === 'flip') out[at] = m.value;
    else {
      const width = m.wide ? 4 : 2;
      for (let k = 0; k < width && at + k < out.length; k++)
        out[at + k] = (m.value >>> (8 * k)) & 0xff;
    }
  }
  return out;
}

/** A random package: seed names and random names, with random bytes or XML-like text. */
const randomPackage: fc.Arbitrary<Uint8Array> = fc
  .array(
    fc.record({
      name: fc.oneof(
        fc.constantFrom(
          '[Content_Types].xml',
          '_rels/.rels',
          'word/document.xml',
          'word/_rels/document.xml.rels',
          'word/styles.xml',
          'word/numbering.xml',
          'word/footnotes.xml',
          'word/comments.xml',
          'docProps/core.xml',
        ),
        fc.string({ minLength: 1, maxLength: 30 }),
      ),
      content: fc.oneof(
        fc.uint8Array({ maxLength: 300 }).map((b) => new Uint8Array(b)),
        fc
          .array(fc.constantFrom(...FRAGMENTS), { maxLength: 30 })
          .map((parts) => encoder.encode(parts.join(''))),
      ),
      store: fc.boolean(),
    }),
    { maxLength: 10 },
  )
  .map((entries) => {
    const seen = new Set<string>();
    const unique = entries.filter((e) => !seen.has(e.name) && (seen.add(e.name), true));
    return writeZip(unique.map((e) => ({ name: e.name, data: e.content, store: e.store })));
  });

/**
 * A longer campaign: `DOCEDIT_FUZZ_SEED` shifts the seeds and `DOCEDIT_FUZZ_RUNS` multiplies the
 * run counts. The defaults are what `pnpm test` runs.
 */
const FUZZ_SEED = Number(process.env['DOCEDIT_FUZZ_SEED'] ?? 0);
const FUZZ_SCALE = Math.max(1, Number(process.env['DOCEDIT_FUZZ_RUNS'] ?? 1));
const runs = (n: number, seed: number): { numRuns: number; seed: number; verbose: false } => ({
  numRuns: n * FUZZ_SCALE,
  seed: seed + FUZZ_SEED,
  verbose: false,
});

type Outcome = 'imported' | 'zip' | 'xml' | 'importer';
const outcomes = new Map<string, Record<Outcome, number>>();
const networkCalls: unknown[] = [];

function record(family: string, outcome: Outcome): void {
  const counts = outcomes.get(family) ?? { imported: 0, zip: 0, xml: 0, importer: 0 };
  counts[outcome]++;
  outcomes.set(family, counts);
}

/** Imports the bytes and fails on a crash or on a slow import. */
async function importChecked(family: string, bytes: Uint8Array, limitMs: number): Promise<void> {
  const start = performance.now();
  let outcome: Outcome = 'imported';
  try {
    await importDocx(bytes);
  } catch (e) {
    if (!(e instanceof ImportError)) throw e;
    outcome =
      e.cause instanceof ZipError ? 'zip' : e.cause instanceof XmlError ? 'xml' : 'importer';
  }
  const elapsed = performance.now() - start;
  if (elapsed > limitMs)
    throw new Error(
      `an import took ${elapsed.toFixed(0)} ms, over its bound of ${limitMs.toFixed(0)} ms`,
    );
  record(family, outcome);
}

const limitFor = (seed: Seed): number => 1_000 + 10 * seed.baseline;
const LARGEST_LIMIT = (): number => Math.max(...SEEDS.map(limitFor));

beforeAll(async () => {
  const refuse = (what: string) =>
    function (...args: unknown[]): never {
      networkCalls.push([what, ...args]);
      throw new Error(`a network request was made through ${what}`);
    };
  vi.stubGlobal('fetch', refuse('fetch'));
  vi.stubGlobal('XMLHttpRequest', refuse('XMLHttpRequest'));
  vi.stubGlobal('WebSocket', refuse('WebSocket'));
  for (const seed of SEEDS) {
    await importDocx(seed.bytes);
    const start = performance.now();
    await importDocx(seed.bytes);
    seed.baseline = performance.now() - start;
  }
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('EXP-110: fuzzing the importer (criterion 3)', () => {
  it('survives mutated XML parts packaged with a valid CRC, which reach the parser and the importer', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.nat(SEEDS.length - 1),
        fc.nat(),
        fc.array(partMutation, { minLength: 1, maxLength: 4 }),
        async (s, p, muts) => {
          const seed = SEEDS[s]!;
          const part = seed.xmlParts[p % seed.xmlParts.length]!;
          const data = mutatePart(entryData(seed.zip, seed.zip.byName.get(part)!), muts);
          await importChecked('part', repackage(seed, part, data), limitFor(seed));
        },
      ),
      runs(300, 110),
    );
    const counts = outcomes.get('part')!;
    // Nothing is stopped by the ZIP layer: the package is rewritten with a valid CRC and sizes.
    expect(counts.zip).toBe(0);
    // Both the parser's refusals and the importer's handling of well-formed but altered XML occur.
    expect(counts.xml).toBeGreaterThan(30);
    expect(counts.imported).toBeGreaterThan(30);
  }, 300_000);

  it('survives mutations of the central directory, the local headers and any byte of the file', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.nat(SEEDS.length - 1),
        fc.nat(),
        fc.array(containerMutation, { minLength: 1, maxLength: 4 }),
        async (s, l, muts) => {
          const seed = SEEDS[s]!;
          await importChecked('container', mutateContainer(seed, muts, l), limitFor(seed));
        },
      ),
      runs(200, 1100),
    );
    const counts = outcomes.get('container')!;
    expect(counts.zip).toBeGreaterThan(0);
  }, 300_000);

  it('survives random packages', async () => {
    await fc.assert(
      fc.asyncProperty(randomPackage, async (bytes) => {
        await importChecked('random', bytes, LARGEST_LIMIT());
      }),
      runs(200, 11000),
    );
  }, 300_000);

  it('made no network request in any of the runs above', () => {
    expect(networkCalls).toEqual([]);
  });
});
