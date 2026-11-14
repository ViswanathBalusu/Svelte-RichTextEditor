// The room's permission indexes (07 §5.4; PRM-016): regions with their ranges and policies, the
// definitions each region uses, and the form fields, carried through every commit by mapping and
// rescanning only what changed, equal to a full rebuild after every commit, built when the room
// opens a document, and used by the outcome check and the fill rules.
import fc from 'fast-check';
import { Fragment, type Node, Slice } from 'prosemirror-model';
import {
  AttrStep,
  ReplaceAroundStep,
  ReplaceStep,
  type Step,
  Transform,
} from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { PermissionIndex } from '../src/permissions/indexes.ts';
import { definitionUse } from '../src/permissions/outcome.ts';
import { diffScopes } from '../src/permissions/scopes.ts';
import { applySteps, mapsOf } from '../src/rebase.ts';
import { ruleGate } from '../src/room/rules.ts';
import { Room } from '../src/room/room.ts';
import { stepsToJson } from '../src/steps.ts';
import { BASE_JSON, REQUIRES, USERS, basePermissions, posOf, schema } from './fixtures.ts';
import { fieldsDoc } from './permission-fixtures.ts';

type J = Record<string, unknown>;
let ids = 0;
const nid = (prefix: string) => `${prefix}${String(++ids).padStart(15, '0')}`.slice(0, 16);

const same = (index: PermissionIndex, doc: Node) => {
  expect(index.snapshot()).toEqual(PermissionIndex.build(doc).snapshot());
  const use = (m: Map<string, Set<string>>) => [...m].map(([k, v]) => [k, [...v].sort()]);
  expect(use(index.definitionUse(doc))).toEqual(use(definitionUse(doc)));
};

/** One random structural or content change of the kinds the indexes follow. */
function change(doc: Node, kind: number, pick: number): Step[] {
  const tr = new Transform(doc);
  const body = doc.child(doc.childCount - 1);
  const start = doc.content.size - body.nodeSize + 1;
  const blocks: Array<{ node: Node; pos: number }> = [];
  body.forEach((n, o) => blocks.push({ node: n, pos: start + o }));
  const b = blocks[pick % blocks.length]!;
  const paragraphs: Array<{ node: Node; pos: number }> = [];
  doc.descendants((n, pos) => {
    if (n.type.name === 'paragraph') paragraphs.push({ node: n, pos });
    return true;
  });
  const p = paragraphs[pick % paragraphs.length]!;
  try {
    switch (kind % 10) {
      case 0: {
        // Add a region with a styled paragraph.
        const region = schema.nodeFromJSON({
          type: 'region',
          attrs: { id: nid('r'), policy: pick % 2 ? 'restricted' : 'inherit' },
          content: [
            {
              type: 'paragraph',
              attrs: { id: nid('p'), style: 'LegalBody' },
              content: [{ type: 'text', text: 'New' }],
            },
          ],
        });
        tr.insert(b.pos, region);
        break;
      }
      case 1:
        // Remove a region.
        if (b.node.type.name !== 'region') return [];
        tr.delete(b.pos, b.pos + b.node.nodeSize);
        break;
      case 2:
        // Unwrap a region (its blocks move into the body), or wrap a paragraph of the body.
        if (b.node.type.name === 'region')
          tr.step(
            new ReplaceAroundStep(
              b.pos,
              b.pos + b.node.nodeSize,
              b.pos + 1,
              b.pos + b.node.nodeSize - 1,
              Slice.empty,
              0,
              true,
            ),
          );
        else if (b.node.type.name === 'paragraph')
          tr.wrap(doc.resolve(b.pos + 1).blockRange()!, [
            { type: schema.nodes['region']!, attrs: { id: nid('r') } },
          ]);
        else return [];
        break;
      case 3:
        // Apply a style.
        tr.step(new AttrStep(p.pos, 'style', ['Heading1', 'LegalBody', null][pick % 3] ?? null));
        break;
      case 4: {
        // Insert a form field.
        const f = schema.nodes['form_field']!.create({
          id: nid('f'),
          key: `k.${ids}`,
          kind: 'text',
          label: 'k',
        });
        tr.insert(p.pos + 1, f);
        break;
      }
      case 5: {
        // Delete a form field.
        let at = -1;
        doc.descendants((n, pos) => {
          if (at < 0 && n.type.name === 'form_field') at = pos;
          return at < 0;
        });
        if (at < 0) return [];
        tr.delete(at, at + 1);
        break;
      }
      case 6: {
        // Insert a section break (page setups follow).
        const sb = schema.nodes['section_break']!.create({ id: nid('s'), pageSetup: 'ps1' });
        tr.insert(b.pos, sb);
        break;
      }
      case 8: {
        // Split a region in two between its first and second block; the second gets a new id.
        const regions = blocks.filter(
          (x) => x.node.type.name === 'region' && x.node.childCount > 1,
        );
        const r = regions[pick % Math.max(regions.length, 1)];
        if (!r) return [];
        const at = r.pos + 1 + r.node.child(0).nodeSize;
        tr.split(at, 1);
        tr.step(new AttrStep(at + 1, 'id', nid('r')));
        break;
      }
      case 9: {
        // Merge a region with the region after it.
        const regions = blocks.filter(
          (x) =>
            x.node.type.name === 'region' &&
            doc.nodeAt(x.pos + x.node.nodeSize)?.type.name === 'region',
        );
        const r = regions[pick % Math.max(regions.length, 1)];
        if (!r) return [];
        tr.join(r.pos + r.node.nodeSize);
        break;
      }
      default:
        // Type text somewhere (kind 7).
        tr.insert(p.pos + 1, schema.text('z'));
    }
  } catch {
    return [];
  }
  return tr.steps;
}

describe('permission indexes (PRM-016)', () => {
  it('equal a full rebuild after every commit of random sequences (property)', () => {
    let commits = 0;
    let splitsAndMerges = 0;
    let scannedLess = 0;
    fc.assert(
      fc.property(
        fc.array(fc.record({ kind: fc.nat(9), pick: fc.nat(1000) }), {
          minLength: 1,
          maxLength: 12,
        }),
        (ops) => {
          let doc = fieldsDoc();
          let index = PermissionIndex.build(doc);
          for (const op of ops) {
            const steps = change(doc, op.kind, op.pick);
            if (!steps.length) continue;
            const r = applySteps(doc, steps);
            if (!r.ok) continue;
            index = index.next(doc, r.value.doc, mapsOf(steps), diffScopes(doc, r.value.doc));
            doc = r.value.doc;
            same(index, doc);
            commits++;
            if (op.kind % 10 >= 8) splitsAndMerges++;
            if (index.scanned < doc.nodeSize) scannedLess++;
          }
        },
      ),
      { numRuns: 300, seed: 16 },
    );
    expect(commits).toBeGreaterThan(500);
    // Splits and merges of regions are among the commits checked (PRM-016 criterion 1).
    expect(splitsAndMerges).toBeGreaterThan(20);
    // Most updates look at much less than the whole document.
    expect(scannedLess).toBeGreaterThan(commits / 2);
  });

  it('are built when the room opens a document, from the content and the log', () => {
    const doc = fieldsDoc();
    const first = new Room({
      schema,
      initial: doc,
      requires: REQUIRES,
      log: [],
      perms: basePermissions(),
      initialRevision: 1,
      epoch: 1,
      incarnation: 'inc-1',
      now: () => 1,
    });
    first.open('c1', USERS.alice);
    const fx = first.submit('c1', {
      id: '0192f0c4-7b1e-7000-8000-00000000a001',
      base: 0,
      steps: stepsToJson(change(doc, 0, 3)),
    });
    const stored = fx.write!.commits[0]!;
    first.writeCompleted({ status: 'ok' });
    same(first.indexes, first.document);
    const reopened = new Room({
      schema,
      initial: doc,
      requires: REQUIRES,
      log: [stored],
      perms: basePermissions(),
      initialRevision: 1,
      epoch: 2,
      incarnation: 'inc-1',
      now: () => 1,
    });
    same(reopened.indexes, reopened.document);
    expect(reopened.indexes.regionList()).toEqual(first.indexes.regionList());
  });

  it('find a field in constant time for the fill rules: no scan of the document', () => {
    const json = structuredClone(BASE_JSON) as unknown as { content: Array<{ content: J[] }> };
    json.content[0]!.content.push({
      type: 'rule_def',
      attrs: { id: 'rAlways', when: true, then: [] },
    });
    for (let i = 0; i < 300; i++)
      json.content[1]!.content.push({
        type: 'paragraph',
        attrs: { id: `pMore${String(i).padStart(11, '0')}` },
        content: [{ type: 'text', text: `More ${i}` }],
      });
    const doc = schema.nodeFromJSON(json);
    const index = PermissionIndex.build(doc);
    const gate = ruleGate(doc, ['role_tenant'], 100_000, (id) => index.field(id)?.key)!;
    expect(index.field('fTenantName00001')).toMatchObject({
      key: 'tenant.name',
      container: 'region:rLegal000000000B',
    });
    gate.enabled('fTenantName00001', doc);
    expect(gate.scans).toBe(0);
    // Without the index (or the key from the commit), the gate has to scan.
    const bare = ruleGate(doc, ['role_tenant'], 100_000)!;
    bare.enabled('fTenantName00001', doc);
    expect(bare.scans).toBe(1);
  });

  it('give the outcome check the definitions a region uses without a scan of every region', () => {
    const doc = fieldsDoc();
    const index = PermissionIndex.build(doc);
    expect([...index.definitionUse(doc).get('rLegal000000000B')!].sort()).toEqual([
      'defs:page_setup/ps1',
      'defs:style_def/LegalBody',
      'defs:style_def/Normal',
    ]);
    // An edit inside one region rescans that region only.
    const steps: Step[] = [
      new ReplaceStep(
        posOf(doc, 'pTerms000000001A') + 1,
        posOf(doc, 'pTerms000000001A') + 1,
        new Slice(Fragment.from(schema.text('x')), 0, 0),
      ),
    ];
    const r = applySteps(doc, steps);
    if (!r.ok) throw new Error(r.reason);
    const next = index.next(doc, r.value.doc, mapsOf(steps), diffScopes(doc, r.value.doc));
    const terms = r.value.doc.nodeAt(posOf(r.value.doc, 'rTerms000000000A'))!;
    expect(next.scanned).toBeLessThan(terms.nodeSize + 10);
  });
});
