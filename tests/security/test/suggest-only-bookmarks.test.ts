/**
 * SEC-023 criterion 1, for bookmarks (10 §5; 07 §5.2, §17; PRM-013 to PRM-015). The baseline of a
 * scope is the content with every suggestion rejected, "including attributes and bookmarks". The
 * property in suggest-only-users.test.ts draws no bookmark operation, so this file adds them: a
 * bookmark is the `anchor` node of the CDM (03 §4.4), an inline atom with an identifier and a name.
 *
 * A user with `suggest` but not `edit` submits random commits that insert, delete, rename and
 * suggest around anchors, mixed with text suggestions. Whenever the outcome check (the gate every
 * accepted commit passes) accepts a commit, the baseline, anchors included, must be unchanged. The
 * oracle is independent of the authority: it reads the anchors of the document as text tokens.
 *
 * This proves criterion 1 for bookmarks only; the text and attribute part is in
 * suggest-only-users.test.ts. Criterion 5 (block-level suggestions) is not proved here.
 */
import { type Connection, outcomeCheck, STANDARD_RULES } from '@docedit/authority';
import fc from 'fast-check';
import type { Node } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { BASE_JSON, accessOf, permissions, schema } from './support/authority-fixtures.ts';

const SAM: Connection = {
  sub: 'sam',
  session: 's-sam',
  role: 'suggester',
  groups: [],
  participantRoles: [],
  participantActive: false,
};

const ANCHOR_ID = 'anc0000000000001';
const ANCHOR_NAME = 'ClauseOne';

type J = {
  type: string;
  attrs?: Record<string, unknown>;
  text?: string;
  marks?: Array<{ type: string; attrs: Record<string, unknown> }>;
  content?: J[];
};

/** The fixture with `trackChanges: everyone`, one bookmark in the intro paragraph, and one suggestion of Ana's. */
function baseWithBookmark(): Node {
  const json = structuredClone(BASE_JSON) as unknown as J;
  const defs = json.content!.find((n) => n.type === 'defs')!;
  const settings = defs.content!.find((n) => n.type === 'settings')!;
  settings.attrs!['trackChanges'] = 'everyone';
  const body = json.content!.find((n) => n.type === 'body')!;
  const intro = body.content!.find((n) => n.attrs?.['id'] === 'pIntro0000000001')!;
  intro.content = [
    { type: 'text', text: 'This agreement ' },
    { type: 'anchor', attrs: { id: ANCHOR_ID, name: ANCHOR_NAME } },
    {
      type: 'text',
      text: 'is made',
      marks: [{ type: 'ins', attrs: { id: 'sIns0000000001', user: 'ana' } }],
    },
    { type: 'text', text: ' between the parties.' },
  ];
  const doc = schema.nodeFromJSON(json);
  doc.check();
  return doc;
}

const ins = (id: string, user: string) => schema.marks['ins']!.create({ id, user });

let counter = 0;
const fresh = () => `sNew${String(++counter).padStart(11, '0')}`;
const freshAnchor = () => `a${String(++counter).padStart(15, '0')}`;

/** Every bookmark token of a node, in order: its identifier, name and origin. */
function anchorsOf(doc: Node): string[] {
  const out: string[] = [];
  doc.descendants((n) => {
    if (n.type.name === 'anchor')
      out.push(JSON.stringify({ id: n.attrs['id'], name: n.attrs['name'] }));
    return true;
  });
  return out;
}

/**
 * The baseline as text: every insertion removed, every suggestion mark taken away, bookmarks kept
 * with their attributes (07 §5.2). Each non-text inline node is a token with its attributes.
 */
function baselineOf(node: Node): string {
  if (node.inlineContent) {
    const tokens: string[] = [];
    let run: { key: string; text: string } | null = null;
    const flush = () => {
      if (run) tokens.push(`${run.key}${JSON.stringify(run.text)}`);
      run = null;
    };
    node.forEach((c) => {
      if (c.isText) {
        // Inserted text is not part of the baseline; the other marks of a text run are kept.
        if (c.marks.some((m) => m.type.name === 'ins')) return;
        const kept = c.marks.filter(
          (m) => m.type.name !== 'ins' && m.type.name !== 'del' && m.type.name !== 'fmt',
        );
        const key = JSON.stringify(kept.map((m) => m.toJSON()));
        if (run && run.key === key) run.text += c.text ?? '';
        else {
          flush();
          run = { key, text: c.text ?? '' };
        }
      } else {
        flush();
        tokens.push(`<${c.type.name} ${JSON.stringify(c.attrs)}/>`);
      }
    });
    flush();
    return tokens.join('|');
  }
  const parts: string[] = [];
  node.forEach((c) => {
    parts.push(`<${c.type.name}>${baselineOf(c)}</${c.type.name}>`);
  });
  return parts.join('');
}

function verdictFor(before: Node, after: Node) {
  return outcomeCheck({
    before,
    after,
    user: SAM.sub,
    access: accessOf(SAM, before),
    perms: permissions(),
    suggestionOwners: new Map(),
    fieldsChangedSinceBase: new Set(),
    serverAuthored: false,
    origin: 'input',
    rules: STANDARD_RULES,
  });
}

function textPositions(doc: Node): number[] {
  const out: number[] = [];
  for (let p = 0; p <= doc.content.size; p++) {
    if (doc.resolve(p).parent.inlineContent) out.push(p);
  }
  return out;
}

/** Positions of the bookmarks inside [from, to], as node start positions. */
function anchorPositions(doc: Node, from: number, to: number): number[] {
  const out: number[] = [];
  doc.nodesBetween(from, to, (n, pos) => {
    if (n.type.name === 'anchor') out.push(pos);
    return true;
  });
  return out;
}

type OpKind =
  | 'anchor-insert'
  | 'anchor-delete'
  | 'anchor-rename'
  | 'suggest-insert'
  | 'plain-insert'
  | 'suggest-delete'
  | 'plain-delete';

interface Op {
  kind: OpKind;
  i: number;
  j: number;
}

const OP: fc.Arbitrary<Op> = fc.record({
  kind: fc.constantFrom<OpKind>(
    'anchor-insert',
    'anchor-delete',
    'anchor-rename',
    'suggest-insert',
    'plain-insert',
    'suggest-delete',
    'plain-delete',
  ),
  i: fc.nat(10_000),
  j: fc.nat(10_000),
});

/** Applies one operation; returns true when it touched a bookmark. Errors mean "does not apply here". */
function applyOp(tr: Transform, op: Op): boolean {
  const positions = textPositions(tr.doc);
  const a = positions[op.i % positions.length]!;
  const b = positions[op.j % positions.length]!;
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  switch (op.kind) {
    case 'anchor-insert':
      tr.insert(a, schema.nodes['anchor']!.create({ id: freshAnchor(), name: `Bm${counter}` }));
      return true;
    case 'anchor-delete': {
      const found = anchorPositions(tr.doc, from, to);
      // Delete from the end so earlier positions stay valid.
      for (const pos of found.reverse()) tr.delete(pos, pos + tr.doc.nodeAt(pos)!.nodeSize);
      return found.length > 0;
    }
    case 'anchor-rename': {
      const found = anchorPositions(tr.doc, from, to);
      for (const pos of found)
        tr.setNodeMarkup(pos, undefined, {
          ...tr.doc.nodeAt(pos)!.attrs,
          name: `Renamed${counter}`,
        });
      return found.length > 0;
    }
    case 'suggest-insert':
      tr.insert(a, schema.text('x', [ins(fresh(), 'sam')]));
      return false;
    case 'plain-insert':
      tr.insert(a, schema.text('yz'));
      return false;
    case 'suggest-delete':
      if (from < to)
        tr.addMark(from, to, schema.marks['del']!.create({ id: fresh(), user: 'sam' }));
      return false;
    case 'plain-delete':
      if (from < to) tr.delete(from, to);
      return false;
  }
}

describe('SEC-023 criterion 1 for bookmarks: a suggester cannot change the baseline, bookmarks included', () => {
  const before = baseWithBookmark();

  it('the fixture has one bookmark and passes the schema check', () => {
    expect(anchorsOf(before)).toEqual([JSON.stringify({ id: ANCHOR_ID, name: ANCHOR_NAME })]);
  });

  it('refuses a bookmark inserted by the suggester outside any suggestion', () => {
    const tr = new Transform(before).insert(
      textPositions(before)[3]!,
      schema.nodes['anchor']!.create({ id: freshAnchor(), name: 'Extra' }),
    );
    expect(() => tr.doc.check()).not.toThrow();
    expect(verdictFor(before, tr.doc).ok).toBe(false);
  });

  it('refuses the suggester deleting the bookmark, and renaming it', () => {
    const pos = anchorPositions(before, 0, before.content.size)[0]!;
    const deleted = new Transform(before).delete(pos, pos + before.nodeAt(pos)!.nodeSize);
    expect(verdictFor(before, deleted.doc).ok).toBe(false);
    const renamed = new Transform(before).setNodeMarkup(pos, undefined, {
      ...before.nodeAt(pos)!.attrs,
      name: 'Other',
    });
    expect(verdictFor(before, renamed.doc).ok).toBe(false);
  });

  it('random commits around bookmarks that the check accepts keep the baseline, bookmarks included (property)', () => {
    let bookmarkOpsApplied = 0;
    let accepted = 0;
    fc.assert(
      fc.property(fc.array(OP, { minLength: 1, maxLength: 6 }), (ops) => {
        const tr = new Transform(before);
        for (const op of ops) {
          try {
            if (applyOp(tr, op)) bookmarkOpsApplied++;
          } catch {
            // The operation does not apply at this point of the document.
          }
        }
        const after = tr.doc;
        try {
          after.check();
        } catch {
          return true;
        }
        if (!verdictFor(before, after).ok) return true;
        accepted++;
        expect(baselineOf(after)).toBe(baselineOf(before));
        expect(anchorsOf(after)).toEqual(anchorsOf(before));
        return true;
      }),
      { numRuns: 300 },
    );
    // The property must not hold by refusing everything: bookmark operations were applied, and
    // some commits were accepted (those that touch only the suggester's own text).
    expect(bookmarkOpsApplied).toBeGreaterThan(0);
    expect(accepted).toBeGreaterThan(0);
  });
});
