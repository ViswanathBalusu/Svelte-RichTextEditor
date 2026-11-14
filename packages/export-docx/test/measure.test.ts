/**
 * SPK-028 measurements for the S11 report, written to test-results/s11-measurements.json:
 * - the share of imported nodes that carry preserved data (EXP-116);
 * - the size overhead of an imported document against an import without preservation;
 * - the size of the step payloads of 1,000 simulated commits, with and without preservation;
 * - import and export times on this machine;
 * - the depth and size of every element tree, against candidate grammar limits;
 * - which elements the residues hold (input to the allow-list of SR-C2);
 * - preserved atoms with and without a fallback picture (SR-M17), and active content (SR-M18).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { canonicalText, utf8, type JsonEnvelope, type JsonNode } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import {
  entryData,
  exportDocx,
  importDocx,
  readFragment,
  readZip,
  sharedTrees,
  type ImportResult,
  type TreeStat,
} from '../src/index.ts';
import { OUT_DIR, corpusFiles, readFile } from './corpus.ts';

interface FileMeasure {
  name: string;
  bytes: number;
  documentXmlBytes: number;
  importMs: number;
  exportMs: number;
  canonicalBytes: number;
  canonicalBytesWithout: number;
  preservedBytes: number;
  sourceMapBytes: number;
  fragments: number;
  fragmentBytes: number;
  imageAssetBytes: number;
  nodes: number;
  nodesWithPreserved: number;
  textNodes: number;
  textWithPreservedMark: number;
  preservedInline: Record<string, number>;
  preservedBlock: Record<string, number>;
  atomsWithFallbackPicture: number;
  atoms: number;
  images: number;
  smallAtoms: number;
  shared: ImportResult['stats']['shared'];
  suggestions: ImportResult['stats']['suggestions'];
  canonicalBytesUnshared: number;
  fallbacks: ImportResult['stats']['fallbacks'];
  markedAtoms: Record<string, number>;
  dropped: Record<string, number>;
  fullContainers: Record<string, number>;
  commits: { steps: number; bytesWith: number; bytesWithout: number } | null;
  activeContent: Record<string, number>;
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const percentile = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Step payloads of 1,000 commits as the editor would send them: 980 single-character insertions at
 * random text positions, carrying the marks of the text there, and 20 paragraph splits, whose
 * slices carry the paragraph's attributes. Sizes are of the steps' JSON only (04 §3): the commit
 * envelope is the same with and without preservation. The steps are not applied.
 */
function commitBytes(env: JsonEnvelope, seed: number): { steps: number; bytes: number } | null {
  const doc = cdmSchema().nodeFromJSON(env.doc);
  const texts: Array<{
    pos: number;
    marks: unknown[];
    para: { type: { create(a: unknown): { toJSON(): unknown } }; attrs: unknown };
  }> = [];
  doc.descendants((node, pos, parent) => {
    if (node.isText && parent && parent.type.name === 'paragraph')
      texts.push({ pos, marks: node.marks.map((m) => m.toJSON()), para: parent as never });
    return true;
  });
  if (!texts.length) return null;
  const rnd = mulberry32(seed);
  let bytes = 0;
  for (let i = 0; i < 1000; i++) {
    const t = texts[Math.floor(rnd() * texts.length)]!;
    const step =
      i % 50 === 49
        ? {
            stepType: 'replace',
            from: t.pos,
            to: t.pos,
            slice: {
              content: [
                t.para.type.create(t.para.attrs).toJSON(),
                t.para.type.create(t.para.attrs).toJSON(),
              ],
              openStart: 1,
              openEnd: 1,
            },
          }
        : {
            stepType: 'replace',
            from: t.pos,
            to: t.pos,
            slice: {
              content: [{ type: 'text', text: 'x', marks: t.marks.length ? t.marks : undefined }],
            },
          };
    bytes += utf8(JSON.stringify(step)).length;
  }
  return { steps: 1000, bytes };
}

/**
 * Bytes of preserved data in a document: `preserved` attributes, `preserved` marks, the trees of
 * small atoms, `origin` values and the shared trees of `preserved_def`, with the element names the
 * residues hold (shared trees resolved).
 */
function preservedBytes(env: JsonEnvelope): { bytes: number; names: Map<string, number> } {
  let bytes = 0;
  const names = new Map<string, number>();
  const shared = sharedTrees(env);
  const resolve = (v: unknown): unknown => {
    const r = v as { ref?: unknown } | null;
    return r && typeof r.ref === 'string' ? shared.get(r.ref) : v;
  };
  const count = (
    where: string,
    body: { children?: Array<{ name?: string; children?: unknown[] }> } | null,
  ): void => {
    for (const c of body?.children ?? []) {
      if (!c.name) continue;
      const holder = /^w:(pPr|rPr|tblPr|trPr|tcPr)$/.test(c.name) && where !== 'mark';
      if (holder) count(`${where}/${c.name}`, c as never);
      else names.set(`${where}: ${c.name}`, (names.get(`${where}: ${c.name}`) ?? 0) + 1);
    }
  };
  const walk = (n: JsonNode): void => {
    const p = n.attrs?.['preserved'];
    if (p) {
      bytes += utf8(JSON.stringify(p)).length;
      count(n.type, resolve(p) as never);
    }
    if (n.type === 'preserved_def') bytes += utf8(JSON.stringify(n.attrs)).length;
    else
      for (const k of ['origin', 'tree'] as const)
        if (n.attrs?.[k]) bytes += utf8(JSON.stringify(n.attrs[k])).length;
    for (const m of n.marks ?? [])
      if (m.type === 'preserved') {
        bytes += utf8(JSON.stringify(m.attrs?.['props'])).length;
        count('mark', resolve(m.attrs?.['props']) as never);
      }
    for (const c of n.content ?? []) walk(c);
  };
  walk(env.doc);
  return { bytes, names };
}

function countAtoms(env: JsonEnvelope): { atoms: number; withPicture: number } {
  let atoms = 0;
  let withPicture = 0;
  const walk = (n: JsonNode): void => {
    if (n.type === 'preserved_inline' || n.type === 'preserved_block') {
      atoms++;
      if (n.attrs?.['fallbackAsset']) withPicture++;
    }
    for (const c of n.content ?? []) walk(c);
  };
  walk(env.doc);
  return { atoms, withPicture };
}

/** Active content the original carries (SR-M18): embedded objects, ActiveX, external relationships, fields that fetch or link. */
function activeContent(bytes: Uint8Array): Record<string, number> {
  const zip = readZip(bytes);
  const out: Record<string, number> = {};
  const add = (k: string, n = 1): void => {
    if (n) out[k] = (out[k] ?? 0) + n;
  };
  for (const e of zip.entries) {
    if (e.name.startsWith('word/embeddings/')) add('embedded object parts');
    if (e.name.startsWith('word/activeX/') && e.name.endsWith('.bin')) add('ActiveX controls');
    if (!/\.(xml|rels)$/.test(e.name)) continue;
    const s = new TextDecoder().decode(entryData(zip, e));
    if (e.name.endsWith('.rels'))
      for (const m of s.matchAll(/<Relationship [^>]*TargetMode="External"[^>]*>/g))
        add(/\/hyperlink"/.test(m[0]) ? 'external hyperlinks' : 'other external relationships');
    for (const m of s.matchAll(/<w:instrText[^>]*>([^<]*)</g)) {
      const code = m[1]!.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
      if (['INCLUDETEXT', 'INCLUDEPICTURE', 'DDE', 'DDEAUTO', 'LINK', 'IMPORT'].includes(code))
        add(`${code} fields`);
    }
  }
  return out;
}

function treeSummary(trees: TreeStat[]): Record<string, unknown> {
  const byWhere = new Map<string, TreeStat[]>();
  for (const t of trees) byWhere.set(t.where, [...(byWhere.get(t.where) ?? []), t]);
  const out: Record<string, unknown> = {};
  for (const [where, ts] of byWhere) {
    const depths = ts.map((t) => t.depth);
    const bytes = ts.map((t) => t.bytes);
    const fit = (d: number, b: number): number =>
      ts.filter((t) => t.depth <= d && t.bytes <= b).length;
    out[where] = {
      count: ts.length,
      depth: { p50: percentile(depths, 50), p99: percentile(depths, 99), max: Math.max(...depths) },
      bytes: {
        p50: percentile(bytes, 50),
        p90: percentile(bytes, 90),
        p99: percentile(bytes, 99),
        max: Math.max(...bytes),
      },
      fitsDepth8Bytes16K: fit(8, 16384),
      fitsDepth12Bytes16K: fit(12, 16384),
      fitsDepth16Bytes32K: fit(16, 32768),
      fitsDepth32Bytes64K: fit(32, 65536),
    };
  }
  return out;
}

describe('S11 measurements', () => {
  it('measures the corpus and writes test-results/s11-measurements.json', async () => {
    const files: FileMeasure[] = [];
    const allTrees: TreeStat[] = [];
    const atomTrees: TreeStat[] = [];
    const residueNames = new Map<string, number>();
    let seed = 1;
    for (const f of corpusFiles()) {
      const bytes = readFile(f);
      const importTimes: number[] = [];
      const exportTimes: number[] = [];
      let imported: ImportResult | undefined;
      for (let k = 0; k < 3; k++) {
        const t0 = performance.now();
        imported = await importDocx(bytes);
        importTimes.push(performance.now() - t0);
        const t1 = performance.now();
        await exportDocx(imported.envelope, bytes, imported.sourceMap, imported.assets);
        exportTimes.push(performance.now() - t1);
      }
      const r = imported!;
      const base = await importDocx(bytes, { preserve: false });
      const unshared = await importDocx(bytes, { share: false });
      const zip = readZip(bytes);
      const main = zip.byName.get(r.sourceMap.mainPart)!;
      const pb = preservedBytes(r.envelope);
      for (const [k, v] of pb.names) residueNames.set(k, (residueNames.get(k) ?? 0) + v);
      const atoms = countAtoms(r.envelope);
      const fragments = r.assets.ofRole('fragment');
      for (const a of fragments) readFragment(a.bytes);
      allTrees.push(...r.stats.trees, ...r.stats.oversize);
      atomTrees.push(...r.stats.atomTrees);
      const withC = commitBytes(r.envelope, seed);
      const withoutC = commitBytes(base.envelope, seed);
      seed++;
      const nodes = Object.values(r.stats.nodes).reduce((a, b) => a + b, 0);
      const withPreserved = Object.values(r.stats.nodesWithPreserved).reduce((a, b) => a + b, 0);
      files.push({
        name: f.name,
        bytes: bytes.length,
        documentXmlBytes: main.size,
        importMs: Math.round(median(importTimes)),
        exportMs: Math.round(median(exportTimes)),
        canonicalBytes: utf8(canonicalText(r.envelope)).length,
        canonicalBytesWithout: utf8(canonicalText(base.envelope)).length,
        preservedBytes: pb.bytes,
        sourceMapBytes: utf8(JSON.stringify(r.sourceMap)).length,
        fragments: fragments.length,
        fragmentBytes: fragments.reduce((n, a) => n + a.bytes.length, 0),
        imageAssetBytes: r.assets.totalBytes('image'),
        nodes,
        nodesWithPreserved:
          withPreserved +
          Object.values(r.stats.preservedInline).reduce((a, b) => a + b, 0) +
          (r.stats.nodes['preserved_block'] ?? 0),
        textNodes: r.stats.textNodes,
        textWithPreservedMark: r.stats.textWithPreservedMark,
        preservedInline: r.stats.preservedInline,
        preservedBlock: r.stats.preservedBlock,
        atomsWithFallbackPicture: atoms.withPicture,
        atoms: atoms.atoms,
        images: r.stats.images,
        smallAtoms: r.stats.smallAtoms,
        shared: r.stats.shared,
        suggestions: r.stats.suggestions,
        canonicalBytesUnshared: utf8(canonicalText(unshared.envelope)).length,
        fallbacks: r.stats.fallbacks,
        markedAtoms: r.stats.markedAtoms,
        dropped: r.stats.dropped,
        fullContainers: r.stats.fullContainers,
        commits:
          withC && withoutC
            ? { steps: 1000, bytesWith: withC.bytes, bytesWithout: withoutC.bytes }
            : null,
        activeContent: activeContent(bytes),
      });
    }
    const sum = (k: keyof FileMeasure): number => files.reduce((n, f) => n + (f[k] as number), 0);
    const totals = {
      files: files.length,
      bytes: sum('bytes'),
      canonicalBytes: sum('canonicalBytes'),
      canonicalBytesWithout: sum('canonicalBytesWithout'),
      canonicalBytesUnshared: sum('canonicalBytesUnshared'),
      sharedDefs: files.reduce((n, f) => n + f.shared.defs, 0),
      smallAtoms: sum('smallAtoms'),
      images: sum('images'),
      fragmentAssets: sum('fragments'),
      preservedBytes: sum('preservedBytes'),
      sourceMapBytes: sum('sourceMapBytes'),
      fragmentBytes: sum('fragmentBytes'),
      fragments: sum('fragments'),
      nodes: sum('nodes'),
      nodesWithPreserved: sum('nodesWithPreserved'),
      textNodes: sum('textNodes'),
      textWithPreservedMark: sum('textWithPreservedMark'),
      atoms: sum('atoms'),
      atomsWithFallbackPicture: sum('atomsWithFallbackPicture'),
      importMs: sum('importMs'),
      exportMs: sum('exportMs'),
      commitBytesWith: files.reduce((n, f) => n + (f.commits?.bytesWith ?? 0), 0),
      commitBytesWithout: files.reduce((n, f) => n + (f.commits?.bytesWithout ?? 0), 0),
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
      totals,
      trees: treeSummary(allTrees),
      atomTrees: treeSummary(atomTrees),
      residueElements: Object.fromEntries([...residueNames.entries()].sort((a, b) => b[1] - a[1])),
      files,
    };
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(`${OUT_DIR}s11-measurements.json`, JSON.stringify(result, null, 2));
    expect(files.length).toBeGreaterThanOrEqual(78);
    // Every tree stored in a document is within the grammar of today's CDM (the rest fell back).
    for (const t of allTrees.filter((t) => !t.where.startsWith('image')))
      expect(t.depth).toBeGreaterThan(0);
  }, 600_000);
});
