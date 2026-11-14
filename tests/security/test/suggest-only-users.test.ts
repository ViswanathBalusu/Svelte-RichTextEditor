/**
 * SEC-023 — a user with `suggest` but not `edit` (rule P4, 07 §5.2, §17; PRM-013, PRM-014, PRM-015)
 * cannot change the baseline of a scope, cannot change another user's suggestions, names themselves
 * on every suggestion mark they add and uses only identifiers that are theirs. They cannot accept
 * their own suggestion, set a field value, or put a suggested deletion on a restricted region they
 * may not suggest in.
 *
 * The random commits run the outcome check of the authority (the gate every accepted commit passes
 * through) with the standard rules, on a document with `trackChanges: everyone`, where other users
 * have suggestions of their own. The oracles here are independent of the authority's code: the
 * baseline is the document with every insertion removed and every suggestion mark taken away, and
 * other users' suggestions are compared character by character.
 *
 * Not covered here, stated in the story's Notes: criterion 5 (suggestions beyond paragraphs and
 * whole table rows are rejected until their rules exist) needs a block-level suggestion fixture that
 * the authority's own suggestion tests cover; it is not repeated here.
 */
import { type Connection, outcomeCheck, STANDARD_RULES } from '@docedit/authority';
import fc from 'fast-check';
import type { Mark, Node } from 'prosemirror-model';
import { AttrStep, Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { BASE_JSON, accessOf, permissions, schema } from './support/authority-fixtures.ts';

/** The suggester under test: a doc role with `suggest`, no `edit`, no participant role. */
const SAM: Connection = {
  sub: 'sam',
  session: 's-sam',
  role: 'suggester',
  groups: [],
  participantRoles: [],
  participantActive: false,
};

const ANA_INS = 'sIns0000000001';
const BO_DEL = 'sDel0000000001';
const SAM_OWN = 'sOwn00000000001';
const NUMBER_FIELD = 'fNumber000000001';

const SUGGESTION = new Set(['ins', 'del', 'fmt']);

type J = {
  type: string;
  attrs?: Record<string, unknown>;
  text?: string;
  marks?: Array<{ type: string; attrs: Record<string, unknown> }>;
  content?: J[];
};

/**
 * The fixture document with `trackChanges: everyone` and three suggestions by other people or by
 * the suggester: Ana's insertion, Bo's deletion, and one of Sam's own insertions in the title.
 */
function suggestedBase(): Node {
  const json = structuredClone(BASE_JSON) as unknown as J;
  const defs = json.content!.find((n) => n.type === 'defs')!;
  const settings = defs.content!.find((n) => n.type === 'settings')!;
  settings.attrs!['trackChanges'] = 'everyone';
  const body = json.content!.find((n) => n.type === 'body')!;
  const title = body.content!.find((n) => n.attrs?.['id'] === 'pTitle0000000001')!;
  title.content = [
    { type: 'text', text: 'Lease', marks: [{ type: 'ins', attrs: { id: SAM_OWN, user: 'sam' } }] },
    { type: 'text', text: ' agreement' },
  ];
  const intro = body.content!.find((n) => n.attrs?.['id'] === 'pIntro0000000001')!;
  intro.content = [
    { type: 'text', text: 'This agreement ' },
    {
      type: 'text',
      text: 'is made',
      marks: [{ type: 'ins', attrs: { id: ANA_INS, user: 'ana' } }],
    },
    { type: 'text', text: ' between ' },
    { type: 'text', text: 'the', marks: [{ type: 'del', attrs: { id: BO_DEL, user: 'bo' } }] },
    { type: 'text', text: ' parties.' },
  ];
  const doc = schema.nodeFromJSON(json);
  doc.check();
  return doc;
}

let counter = 0;
/** A suggestion identifier nobody has used yet in this run. */
const fresh = () => `sNew${String(++counter).padStart(11, '0')}`;

const ins = (id: string, user: string): Mark => schema.marks['ins']!.create({ id, user });
const del = (id: string, user: string): Mark => schema.marks['del']!.create({ id, user });

/** Who owns each suggestion identifier in a document (the first user to use it). */
function ownersOf(doc: Node): Map<string, string> {
  const out = new Map<string, string>();
  doc.descendants((n) => {
    if (n.isText)
      for (const m of n.marks)
        if (SUGGESTION.has(m.type.name)) out.set(String(m.attrs['id']), String(m.attrs['user']));
    return true;
  });
  return out;
}

/** The characters each suggestion mark covers, keyed by mark kind, identifier and user. */
function suggestionCounts(doc: Node): Map<string, number> {
  const out = new Map<string, number>();
  doc.descendants((n) => {
    if (!n.isText) return true;
    for (const m of n.marks) {
      if (m.type.name !== 'ins' && m.type.name !== 'del') continue;
      const key = `${m.type.name}|${String(m.attrs['id'])}|${String(m.attrs['user'])}`;
      out.set(key, (out.get(key) ?? 0) + (n.text?.length ?? 0));
    }
    return true;
  });
  return out;
}

/**
 * The baseline as text: every insertion removed, every deletion kept, every suggestion mark taken
 * away (07 §5.2). Field values are not part of it (07 §5.1).
 */
function baselineOf(node: Node): string {
  const attrs = (x: Node): string => {
    const a: Record<string, unknown> = { ...x.attrs };
    if (x.type.name === 'form_field') delete a['value'];
    return JSON.stringify(a);
  };
  if (node.inlineContent) {
    const tokens: string[] = [];
    let run: { key: string; text: string } | null = null;
    const flush = () => {
      if (run) tokens.push(`${run.key}${JSON.stringify(run.text)}`);
      run = null;
    };
    node.forEach((c) => {
      if (c.isText) {
        if (c.marks.some((m) => m.type.name === 'ins')) return;
        const kept = c.marks.filter((m) => !SUGGESTION.has(m.type.name)).map((m) => m.toJSON());
        const key = JSON.stringify(kept);
        if (run && run.key === key) run.text += c.text ?? '';
        else {
          flush();
          run = { key, text: c.text ?? '' };
        }
      } else {
        flush();
        tokens.push(`<${c.type.name} ${attrs(c)}/>`);
      }
    });
    flush();
    return tokens.join('');
  }
  const parts: string[] = [];
  node.forEach((c) => {
    parts.push(`<${c.type.name} ${attrs(c)}>${baselineOf(c)}</${c.type.name}>`);
  });
  return parts.join('');
}

/** The verdict of the outcome check for Sam's commit from `before` to `after`. */
function verdictFor(before: Node, after: Node) {
  return outcomeCheck({
    before,
    after,
    user: SAM.sub,
    access: accessOf(SAM, before),
    perms: permissions(),
    suggestionOwners: ownersOf(before),
    fieldsChangedSinceBase: new Set(),
    serverAuthored: false,
    origin: 'input',
    rules: STANDARD_RULES,
  });
}

/** Every position where text can be inserted, in document order. */
function textPositions(doc: Node): number[] {
  const out: number[] = [];
  for (let p = 0; p <= doc.content.size; p++) {
    const $p = doc.resolve(p);
    if ($p.parent.inlineContent) out.push(p);
  }
  return out;
}

/** The position of the first occurrence of `s` in the document's text. */
function at(doc: Node, s: string): number {
  let found = -1;
  doc.descendants((n, pos) => {
    if (found >= 0) return false;
    if (n.isText && n.text?.includes(s)) {
      found = pos + n.text.indexOf(s);
      return false;
    }
    return true;
  });
  if (found < 0) throw new Error(`no text ${s}`);
  return found;
}

/** The position of the node with the given identifier. */
function posOfId(doc: Node, id: string): number {
  let found = -1;
  doc.descendants((n, pos) => {
    if (found >= 0) return false;
    if (n.attrs['id'] === id) {
      found = pos;
      return false;
    }
    return true;
  });
  if (found < 0) throw new Error(`no node ${id}`);
  return found;
}

type OpKind =
  | 'suggest-insert'
  | 'plain-insert'
  | 'forged-insert'
  | 'reused-id-insert'
  | 'suggest-delete'
  | 'plain-delete'
  | 'accept-marks'
  | 'remove-deletion-marks'
  | 'attr-change';

interface Op {
  kind: OpKind;
  i: number;
  j: number;
  word: string;
}

const OP: fc.Arbitrary<Op> = fc.record({
  kind: fc.constantFrom<OpKind>(
    'suggest-insert',
    'plain-insert',
    'forged-insert',
    'reused-id-insert',
    'suggest-delete',
    'plain-delete',
    'accept-marks',
    'remove-deletion-marks',
    'attr-change',
  ),
  i: fc.nat(10_000),
  j: fc.nat(10_000),
  word: fc.constantFrom('x', 'yz', 'Q '),
});

/** Applies one random operation to the transform, at positions of the document as it is now. */
function applyOp(tr: Transform, op: Op): void {
  const positions = textPositions(tr.doc);
  const a = positions[op.i % positions.length]!;
  const b = positions[op.j % positions.length]!;
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  switch (op.kind) {
    case 'suggest-insert':
      tr.insert(a, schema.text(op.word, [ins(fresh(), 'sam')]));
      return;
    case 'plain-insert':
      tr.insert(a, schema.text(op.word));
      return;
    case 'forged-insert':
      tr.insert(a, schema.text(op.word, [ins(fresh(), 'ana')]));
      return;
    case 'reused-id-insert':
      tr.insert(a, schema.text(op.word, [ins(ANA_INS, 'sam')]));
      return;
    case 'suggest-delete':
      if (from < to) tr.addMark(from, to, del(fresh(), 'sam'));
      return;
    case 'plain-delete':
      if (from < to) tr.delete(from, to);
      return;
    case 'accept-marks':
      if (from < to) tr.removeMark(from, to, schema.marks['ins']!);
      return;
    case 'remove-deletion-marks':
      if (from < to) tr.removeMark(from, to, schema.marks['del']!);
      return;
    case 'attr-change': {
      // A paragraph's style: an attribute of the baseline, which only an editor may change.
      const resolved = tr.doc.resolve(a);
      if (resolved.parent.type.name === 'paragraph')
        tr.step(new AttrStep(resolved.before(), 'style', op.word));
      return;
    }
  }
}

describe('SEC-023: a suggestion-only user changes the document only through its own suggestions', () => {
  const before = suggestedBase();

  it('random commits that the check accepts leave the baseline and everyone else’s suggestions unchanged', () => {
    let accepted = 0;
    fc.assert(
      fc.property(fc.array(OP, { minLength: 1, maxLength: 5 }), (ops) => {
        const tr = new Transform(before);
        for (const op of ops) {
          try {
            applyOp(tr, op);
          } catch {
            // The operation does not apply at this point of the document: nothing to check.
          }
        }
        const after = tr.doc;
        try {
          after.check();
        } catch {
          return true; // not a document, so not a question for P4
        }
        const verdict = verdictFor(before, after);
        if (!verdict.ok) return true;
        accepted++;

        // Criterion 1: the baseline of the scope cannot move.
        expect(baselineOf(after)).toBe(baselineOf(before));

        // Criterion 2: every other user's suggestion, its mark and the text it covers stay as they were.
        const countsBefore = suggestionCounts(before);
        const countsAfter = suggestionCounts(after);
        const keys = new Set([...countsBefore.keys(), ...countsAfter.keys()]);
        for (const key of keys) {
          const user = key.split('|')[2];
          if (user === 'sam') continue;
          expect(countsAfter.get(key) ?? 0).toBe(countsBefore.get(key) ?? 0);
        }

        // Criterion 3: every mark the suggester adds names them and uses an identifier that is theirs.
        const owners = ownersOf(before);
        for (const key of keys) {
          const [, id, user] = key.split('|');
          if (user !== 'sam') continue;
          const owner = owners.get(id!);
          expect(owner === undefined || owner === 'sam').toBe(true);
        }
        return true;
      }),
      { numRuns: 300 },
    );
    // The property must not hold only by refusing everything: some commits are accepted.
    expect(accepted).toBeGreaterThan(0);
  });

  it('accepts the suggester’s own suggested insertion in the body', () => {
    const doc = before;
    const tr = new Transform(doc).insert(
      at(doc, ' agreement'),
      schema.text('draft ', [ins(fresh(), 'sam')]),
    );
    expect(verdictFor(doc, tr.doc).ok).toBe(true);
  });

  it('refuses an unmarked change of the baseline', () => {
    const tr = new Transform(before).insert(at(before, ' agreement'), schema.text('plain '));
    expect(verdictFor(before, tr.doc).ok).toBe(false);
  });

  it('refuses a suggestion that names another user (criterion 3)', () => {
    const tr = new Transform(before).insert(
      at(before, ' agreement'),
      schema.text('forged ', [ins(fresh(), 'ana')]),
    );
    expect(verdictFor(before, tr.doc).ok).toBe(false);
  });

  it('refuses a suggestion that reuses another user’s identifier (criterion 3)', () => {
    const tr = new Transform(before).insert(
      at(before, ' agreement'),
      schema.text('reused ', [ins(ANA_INS, 'sam')]),
    );
    expect(verdictFor(before, tr.doc).ok).toBe(false);
  });

  it('refuses accepting the suggester’s own suggestion (criterion 4)', () => {
    const p = at(before, 'Lease');
    const tr = new Transform(before).removeMark(p, p + 'Lease'.length, schema.marks['ins']!);
    expect(verdictFor(before, tr.doc).ok).toBe(false);
  });

  it('refuses accepting another user’s suggestion (criterion 2)', () => {
    const p = at(before, 'is made');
    const tr = new Transform(before).removeMark(p, p + 'is made'.length, schema.marks['ins']!);
    expect(verdictFor(before, tr.doc).ok).toBe(false);
  });

  it('refuses setting a field value (criterion 4)', () => {
    const tr = new Transform(before);
    tr.step(new AttrStep(posOfId(before, NUMBER_FIELD), 'value', '1250.00'));
    expect(verdictFor(before, tr.doc).ok).toBe(false);
  });

  it('refuses a suggested deletion over the whole restricted region (criterion 4)', () => {
    const p = at(before, 'Liability is limited.');
    const tr = new Transform(before).addMark(
      p,
      p + 'Liability is limited.'.length,
      del(fresh(), 'sam'),
    );
    expect(verdictFor(before, tr.doc).ok).toBe(false);
  });

  it('refuses a suggested insertion in the restricted region the suggester may not suggest in', () => {
    const tr = new Transform(before).insert(
      at(before, 'Liability'),
      schema.text('very ', [ins(fresh(), 'sam')]),
    );
    expect(verdictFor(before, tr.doc).ok).toBe(false);
  });
});
