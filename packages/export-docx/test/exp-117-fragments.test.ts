/**
 * EXP-117, criteria 2, 4 and 5 (lane export-docx-2, round 6), on every corpus file:
 * - criterion 2: a preserved atom's `fragment` names a fragment asset that is attached to the
 *   document (the source map lists it, and the asset is in the store with the fragment content
 *   type), that holds the atom's XML, and that holds every internal part the atom relates to.
 * - criterion 4, the part that can be tested here: a relationship to an external target is kept
 *   in the fragment as data (same id, type, target and TargetMode as in the source part), and no
 *   part is taken for it.
 * - criterion 5, in part: every preserved kind of the document is in the import report with the
 *   action `preserved`, a message, and a count equal to the number of atoms of that kind. The
 *   wording "preserved, not editable" is not checked: some kinds have their own message, which
 *   keeps criterion 5 open (see the Notes of EXP-117).
 */
import { describe, expect, it } from 'vitest';
import type { JsonNode } from '@docedit/model';
import {
  FRAGMENT_CONTENT_TYPE,
  entryData,
  importDocx,
  readFragment,
  readZip,
} from '../src/index.ts';
import { parseRelationships, relsPartName } from '../src/opc.ts';
import { corpusFiles, readFile } from './corpus.ts';

/** Every preserved atom of a document, with its attributes. */
function atomsOf(doc: JsonNode): JsonNode[] {
  const out: JsonNode[] = [];
  const stack: JsonNode[] = [doc];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'preserved_inline' || n.type === 'preserved_block') out.push(n);
    for (const c of n.content ?? []) stack.push(c);
  }
  return out;
}

/** A target relative to the part that names it, resolved to a part name of the package (OPC rules). */
function resolveTarget(part: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const segs = part.split('/').slice(0, -1);
  for (const s of target.split('/')) {
    if (s === '..') segs.pop();
    else if (s !== '.' && s !== '') segs.push(s);
  }
  return segs.join('/');
}

describe('EXP-117 criterion 2: a fragment asset holds the atom and the parts it relates to', () => {
  it('every fragment is attached, holds its XML, and holds each internal part it relates to', async () => {
    let fragments = 0;
    let internalRels = 0;
    for (const file of corpusFiles()) {
      const bytes = readFile(file);
      const source = readZip(bytes);
      const result = await importDocx(bytes);
      for (const atom of atomsOf(result.envelope.doc as JsonNode)) {
        const id = atom.attrs?.['fragment'];
        if (typeof id !== 'string') continue;
        fragments++;
        expect(result.sourceMap.fragments, `${file.name} lists ${id}`).toContain(id);
        const asset = result.assets.get(id);
        expect(asset, `${file.name} stores ${id}`).toBeDefined();
        expect(asset!.contentType).toBe(FRAGMENT_CONTENT_TYPE);
        expect(asset!.role).toBe('fragment');
        const f = readFragment(asset!.bytes);
        expect(f.xml.length, `${file.name} ${id} has XML`).toBeGreaterThan(0);
        // The fragment's XML is the element's own bytes, so it appears verbatim in its source part.
        const sourcePart = new TextDecoder().decode(
          entryData(source, source.byName.get(f.meta.part)!),
        );
        expect(sourcePart.includes(f.xml), `${file.name} ${id} is its source XML`).toBe(true);
        const inside = readZip(asset!.bytes);
        for (const part of f.meta.parts)
          expect(inside.byName.has(`parts/${part.name}`), `${file.name} ${part.name} copied`).toBe(
            true,
          );
        for (const rel of f.meta.rels) {
          if (rel.external) continue;
          const target = resolveTarget(f.meta.part, rel.target);
          if (!source.byName.has(target)) continue;
          internalRels++;
          expect(
            f.meta.parts.some((p) => p.name === target),
            `${file.name} ${id} relates to ${target}`,
          ).toBe(true);
        }
      }
    }
    expect(fragments).toBeGreaterThan(0);
    expect(internalRels).toBeGreaterThan(0);
  });
});

describe('EXP-117 criterion 4 (in part): external relationships are kept as data, never followed', () => {
  it("an external relationship of a fragment has the source part's id, type, target and mode, and no part", async () => {
    let external = 0;
    for (const file of corpusFiles()) {
      const bytes = readFile(file);
      const source = readZip(bytes);
      const result = await importDocx(bytes);
      for (const atom of atomsOf(result.envelope.doc as JsonNode)) {
        const id = atom.attrs?.['fragment'];
        if (typeof id !== 'string') continue;
        const f = readFragment(result.assets.get(id)!.bytes);
        const relsName = relsPartName(f.meta.part);
        const sourceRels = parseRelationships(
          f.meta.part,
          source.byName.has(relsName) ? entryData(source, source.byName.get(relsName)!) : undefined,
        );
        for (const rel of f.meta.rels) {
          if (!rel.external) continue;
          external++;
          const original = sourceRels.byId.get(rel.id);
          expect(original?.external, `${file.name} ${rel.id}`).toBe(true);
          expect(rel.target, `${file.name} ${rel.id}`).toBe(original?.target);
          expect(rel.type, `${file.name} ${rel.id}`).toBe(original?.type);
          expect(
            f.meta.parts.some((p) => p.name === rel.target),
            `${file.name} takes no part for ${rel.target}`,
          ).toBe(false);
        }
      }
    }
    // A corpus with no external relationship in any fragment would make the test vacuous.
    expect(external).toBeGreaterThan(0);
  });
});

describe('EXP-117 criterion 5: each preserved kind is reported as preserved, not editable, with a count', () => {
  it('every preserved kind of every corpus file has its own report line with the count of its atoms', async () => {
    let kinds = 0;
    for (const file of corpusFiles()) {
      const result = await importDocx(readFile(file));
      const byLabel = new Map<string, number>();
      for (const atom of atomsOf(result.envelope.doc as JsonNode)) {
        const label = atom.attrs?.['label'];
        if (typeof label !== 'string') continue;
        byLabel.set(label, (byLabel.get(label) ?? 0) + 1);
      }
      const preserved = result.report.filter((i) => i.action === 'preserved');
      for (const item of preserved) {
        // The wording is not yet the one criterion 5 names: some kinds have their own message
        // (see the Notes of EXP-117). The test checks the action, a message and the count.
        expect(item.message.length, `${file.name} ${item.kind}`).toBeGreaterThan(0);
        expect(item.count, `${file.name} ${item.kind}`).toBeGreaterThan(0);
      }
      for (const [label, n] of byLabel) {
        kinds++;
        const item = preserved.find((i) => i.kind === label);
        expect(item, `${file.name} reports ${label}`).toBeDefined();
        expect(item!.count, `${file.name} count of ${label}`).toBe(n);
      }
    }
    expect(kinds).toBeGreaterThan(0);
  });
});
