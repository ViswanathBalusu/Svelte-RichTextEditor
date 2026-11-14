/**
 * EXP-097: the parser the importer builds on. `@rgrove/parse-xml` (ISC; the borrow list's first
 * candidate, §5.2) against the package's own XML reader (src/xml.ts), on every XML part of the
 * corpus and on hostile input. Writes test-results/parser-eval.json, which ADR 0047 cites.
 *
 * What is compared, element by element in document order: qualified names, attributes (namespace
 * declarations included), text, and the element's byte range in the part. What the preserving
 * importer needs besides (resolved namespaces, the byte offset where a start tag ends, refusal of
 * document type declarations) is checked as a capability.
 *
 * The comparison stays as a differential test of src/xml.ts (EXP-110): two independent parsers
 * must agree on every corpus part.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import {
  type XmlDocument as PxDocument,
  type XmlElement as PxElement,
  XmlElement as PxElementClass,
  XmlText as PxTextClass,
  parseXml as px,
} from '@rgrove/parse-xml';
import { describe, expect, it } from 'vitest';
import { utf8 } from '@docedit/model';
import { decodeUtf8, entryData, parseXml, readZip, type XmlElement } from '../src/index.ts';
import { OUT_DIR, corpusFiles, readFile } from './corpus.ts';

interface Part {
  file: string;
  name: string;
  bytes: Uint8Array;
}

const parts: Part[] = [];
for (const f of corpusFiles()) {
  const zip = readZip(readFile(f));
  for (const e of zip.entries)
    if (/\.(xml|rels)$/i.test(e.name))
      parts.push({ file: f.name, name: e.name, bytes: entryData(zip, e) });
}

/** UTF-16 index to UTF-8 byte offset, for every index of the string. */
function byteOffsets(s: string): Uint32Array {
  const out = new Uint32Array(s.length + 1);
  let b = 0;
  for (let i = 0; i < s.length; i++) {
    out[i] = b;
    const c = s.charCodeAt(i);
    if (c < 0x80) b += 1;
    else if (c < 0x800) b += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      b += 4;
      out[++i] = b;
    } else b += 3;
  }
  out[s.length] = b;
  return out;
}

function ours(el: XmlElement, out: XmlElement[] = []): XmlElement[] {
  const stack = [el];
  while (stack.length) {
    const e = stack.pop()!;
    out.push(e);
    for (let i = e.children.length - 1; i >= 0; i--) {
      const c = e.children[i]!;
      if (c.kind === 'element') stack.push(c);
    }
  }
  return out;
}

function theirs(el: PxElement, out: PxElement[] = []): PxElement[] {
  const stack = [el];
  while (stack.length) {
    const e = stack.pop()!;
    out.push(e);
    for (let i = e.children.length - 1; i >= 0; i--) {
      const c = e.children[i]!;
      if (c instanceof PxElementClass) stack.push(c);
    }
  }
  return out;
}

const textOfOurs = (e: XmlElement): string =>
  e.children.map((c) => (c.kind === 'text' ? c.value : '')).join('');
const textOfTheirs = (e: PxElement): string =>
  e.children.map((c) => (c instanceof PxTextClass ? c.text : '')).join('');

/** Differences between the two parsers on one part; empty when they agree. */
function compare(part: Part): string[] {
  const text = decodeUtf8(part.bytes);
  let a: XmlElement;
  let b: PxDocument;
  try {
    a = parseXml(part.bytes).root;
  } catch (e) {
    return [`ours refuses: ${(e as Error).message}`];
  }
  try {
    b = px(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, { includeOffsets: true });
  } catch (e) {
    return [
      e instanceof RangeError
        ? 'parse-xml overflows the stack'
        : `parse-xml refuses: ${(e as Error).message}`,
    ];
  }
  const root = b.children.find((c): c is PxElement => c instanceof PxElementClass);
  if (!root) return ['parse-xml found no root'];
  const x = ours(a);
  const y = theirs(root);
  if (x.length !== y.length) return [`${x.length} elements, parse-xml ${y.length}`];
  const shift = text.charCodeAt(0) === 0xfeff ? 3 : 0;
  const map = byteOffsets(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  const out: string[] = [];
  for (let i = 0; i < x.length && out.length < 5; i++) {
    const p = x[i]!;
    const q = y[i]!;
    if (p.qname !== q.name) out.push(`element ${i}: <${p.qname}> against <${q.name}>`);
    const attrs = Object.fromEntries([...p.nsDecls, ...p.attrs].map((at) => [at.qname, at.value]));
    if (
      JSON.stringify(Object.entries(attrs).sort()) !==
      JSON.stringify(Object.entries(q.attributes).sort())
    )
      out.push(`element ${i} <${p.qname}>: attributes differ`);
    if (textOfOurs(p) !== textOfTheirs(q)) out.push(`element ${i} <${p.qname}>: text differs`);
    const start = map[q.start]! + shift;
    const end = map[q.end]! + shift;
    if (start !== p.start || end !== p.end)
      out.push(`element ${i} <${p.qname}>: bytes ${p.start}-${p.end}, parse-xml ${start}-${end}`);
  }
  return out;
}

const median = (xs: number[]): number => [...xs].sort((m, n) => m - n)[Math.floor(xs.length / 2)]!;

/** The parts both parsers read (parse-xml overflows the stack on the 5,000-level fuzzing file). */
const readable = parts.filter(
  (p) => !(p.file === 'poi/deep-table-cell.docx' && p.name === 'word/document.xml'),
);

function timeAll(f: (p: Part) => void): number {
  const runs: number[] = [];
  for (let k = 0; k < 3; k++) {
    const t0 = performance.now();
    for (const p of readable) f(p);
    runs.push(performance.now() - t0);
  }
  return Math.round(median(runs));
}

const hostile: Record<string, string> = {
  'internal entity': '<!DOCTYPE r [<!ENTITY x "expanded">]><r>&x;</r>',
  'unused DTD': '<!DOCTYPE r [<!ENTITY x "expanded">]><r>plain</r>',
  'billion laughs':
    '<!DOCTYPE r [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]><r>&c;</r>',
  'external entity': '<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/hosts">]><r>&x;</r>',
  'undeclared prefix': '<w:r/>',
  'deep nesting (100,000)': `${'<a>'.repeat(100_000)}${'</a>'.repeat(100_000)}`,
};

function outcome(f: () => unknown): string {
  try {
    const r = f();
    return r === undefined ? 'accepted' : `accepted: ${String(r).slice(0, 60)}`;
  } catch (e) {
    return `refused: ${(e instanceof RangeError ? 'stack overflow' : (e as Error).message).slice(0, 90)}`;
  }
}

describe('EXP-097: @rgrove/parse-xml against src/xml.ts', () => {
  it('agree on every XML part of the corpus that both can read: names, attributes, text and byte ranges', () => {
    const disagreements = parts.flatMap((p) => compare(p).map((d) => `${p.file} ${p.name}: ${d}`));
    expect(parts.length).toBeGreaterThan(900);
    // The one part parse-xml cannot read: it parses recursively, and the fuzzing file nests 5,000
    // tables. Everything else agrees exactly.
    expect(disagreements).toEqual([
      'poi/deep-table-cell.docx word/document.xml: parse-xml overflows the stack',
    ]);
  }, 600_000);

  it('records what each gives the preserving importer, its speed and its behaviour on hostile input', () => {
    const sample = '<w:p xmlns:w="urn:w" a="1"><w:r>x</w:r></w:p>';
    const doc = px(sample, { includeOffsets: true });
    const el = doc.children[0] as PxElement;
    const capabilities = {
      namespaceResolution: {
        ours: parseXml(utf8(sample)).root.ns === 'urn:w',
        parseXml: 'ns' in el || 'namespace' in el,
      },
      startTagEndOffset: {
        ours: parseXml(utf8(sample)).root.startTagEnd === sample.indexOf('>') + 1,
        parseXml: 'startTagEnd' in el,
      },
      offsets: {
        ours: 'UTF-8 byte offsets of the part',
        parseXml: 'UTF-16 indices of the decoded string (includeOffsets); converted here',
      },
      input: { ours: 'bytes (strict UTF-8, refuses UTF-16)', parseXml: 'a JavaScript string' },
    };
    const behaviour = Object.fromEntries(
      Object.entries(hostile).map(([k, s]) => [
        k,
        {
          ours: outcome(() => void parseXml(utf8(s))),
          parseXml: outcome(() => void px(s)),
        },
      ]),
    );
    const timing = {
      parts: readable.length,
      bytes: readable.reduce((n, p) => n + p.bytes.length, 0),
      oursMs: timeAll((p) => void parseXml(p.bytes)),
      parseXmlMs: timeAll(
        (p) => void px(decodeUtf8(p.bytes).replace(/^\uFEFF/, ''), { includeOffsets: true }),
      ),
      parseXmlWithoutOffsetsMs: timeAll((p) => void px(decodeUtf8(p.bytes).replace(/^\uFEFF/, ''))),
      note: 'median of three runs over every XML part of the corpus, in one warm process; parse-xml is given decoded text',
    };
    const result = {
      measured: new Date().toISOString(),
      machine: {
        cpu: os.cpus()[0]?.model ?? 'unknown',
        logicalCores: os.cpus().length,
        memoryGiB: Math.round(os.totalmem() / 2 ** 30),
        node: process.version,
        platform: `${os.platform()} ${os.release()}`,
      },
      candidate: { name: '@rgrove/parse-xml', version: '5.1.0', licence: 'ISC' },
      capabilities,
      hostile: behaviour,
      timing,
    };
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(`${OUT_DIR}parser-eval.json`, JSON.stringify(result, null, 2));
    // What the preserving importer needs and the candidate does not give.
    expect(capabilities.namespaceResolution.ours).toBe(true);
    expect(capabilities.startTagEndOffset.ours).toBe(true);
    // Ours refuses every document type declaration; it never expands an entity.
    for (const k of ['internal entity', 'unused DTD', 'billion laughs', 'external entity'])
      expect(behaviour[k]!.ours).toMatch(/^refused: document type declarations are refused/);
    expect(behaviour['deep nesting (100,000)']!.ours).toBe('accepted');
    expect(behaviour['deep nesting (100,000)']!.parseXml).toBe('refused: stack overflow');
  }, 600_000);
});
