/**
 * SEC-022 — a participant with `fill` but not `edit` can change only the values of the form fields
 * assigned to one of its roles (12 §4.2, rule P7; P8 for server-set kinds; P9 for concurrent fills).
 *
 * These proofs run the outcome check of the authority (the gate every accepted commit passes through
 * in the room) with the standard rules, on a document whose fields cover every kind. The check decides
 * from the document before and after the commit, never from step shapes, so the random commits below
 * are drawn as ProseMirror steps (attribute steps on any node, and text insertions).
 *
 * P9 (two fills of one field) runs through the room itself, so the room's own base tracking decides
 * which fields changed after a commit's base; no set is handed to the check by hand.
 *
 * Not covered here, stated in the story's Notes: criterion 3 (the `field_invalid` answer for a wrong
 * value type) belongs to the invariants of 04 §5 step 6, which these tests do not run.
 */
import {
  applySteps,
  type Connection,
  FILL_RULE,
  outcomeCheck,
  type OutcomeInput,
  Room,
  STANDARD_RULES,
  stepsToJson,
} from '@docedit/authority';
import { type Node, Fragment, Slice } from 'prosemirror-model';
import { AttrStep, ReplaceStep, type Step } from 'prosemirror-transform';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ERIN,
  FIELDS,
  FRANK,
  CAROL,
  LENA,
  accessOf,
  fieldsDoc,
  permissions,
  regionsOf,
  schema,
} from './support/authority-fixtures.ts';

interface RunOptions {
  rules?: OutcomeInput['rules'];
  fieldEnabled?: OutcomeInput['fieldEnabled'];
  user?: Connection;
}

/** Applies `steps` to `before` and runs the outcome check for the connection. */
function check(before: Node, steps: Step[], user: Connection, opts: RunOptions = {}) {
  const applied = applySteps(before, steps);
  if (!applied.ok) return { applied: false as const };
  const after = applied.value.doc;
  const input: OutcomeInput = {
    before,
    after,
    user: user.sub,
    access: accessOf(user, before),
    perms: permissions(),
    suggestionOwners: new Map(),
    fieldsChangedSinceBase: new Set(),
    serverAuthored: false,
    origin: 'input',
    rules: opts.rules ?? STANDARD_RULES,
    ...(opts.fieldEnabled ? { fieldEnabled: opts.fieldEnabled } : {}),
  };
  return { applied: true as const, after, verdict: outcomeCheck(input) };
}

/** Position of the node with the given identifier. */
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

const setAttr = (doc: Node, id: string, attr: string, value: unknown): Step[] => [
  new AttrStep(posOfId(doc, id), attr, value),
];

/** The verdict of a single fill of `id` by `user`, asserting the commit applies. */
function fillOf(doc: Node, id: string, value: unknown, user: Connection, opts: RunOptions = {}) {
  const r = check(doc, setAttr(doc, id, 'value', value), user, opts);
  if (!r.applied) throw new Error('the fill does not apply');
  return r.verdict;
}

describe('SEC-022: a fill-only participant changes only the values of its own fields', () => {
  const doc = fieldsDoc();

  it('accepts the value of a field assigned to one of the participant roles (P7)', () => {
    const v = fillOf(doc, FIELDS.number, '1250.00', ERIN);
    expect(v.ok).toBe(true);
    expect(v.ok && v.scopes).toEqual([`field:${FIELDS.number}`]);
  });

  it('refuses the server-set kinds: signature, initials, dateSigned and formula (P8)', () => {
    for (const id of [FIELDS.signature, FIELDS.initials, FIELDS.dateSigned, FIELDS.formula]) {
      const v = fillOf(doc, id, 'x', ERIN);
      expect(v).toMatchObject({ ok: false, code: 'permission_denied' });
    }
  });

  it('refuses a fill of a field assigned to another role, or to nobody', () => {
    expect(fillOf(doc, FIELDS.landlord, 'x', ERIN)).toMatchObject({ ok: false });
    expect(fillOf(doc, FIELDS.formula, 'x', ERIN)).toMatchObject({ ok: false });
  });

  it('refuses a fill of a read-only field', () => {
    expect(fillOf(doc, FIELDS.readOnly, 'x', ERIN)).toMatchObject({ ok: false });
  });

  it('refuses a fill of a field the rules hide or disable, and one from an inactive participant', () => {
    expect(fillOf(doc, FIELDS.number, '1', ERIN, { fieldEnabled: () => false })).toMatchObject({
      ok: false,
    });
    const inactive = { ...ERIN, participantActive: false };
    expect(fillOf(doc, FIELDS.number, '1', inactive)).toMatchObject({ ok: false });
  });

  it('refuses a fill-only change of the attributes key, kind, assignee, required, readOnly, validation, options and width', () => {
    const changes: Record<string, unknown> = {
      key: 'tenant.other',
      kind: 'text',
      assignee: 'role_landlord',
      required: true,
      readOnly: true,
      validation: { min: 0 },
      options: [{ id: 'yes', label: 'Yes' }],
      width: 40,
    };
    for (const [attr, value] of Object.entries(changes)) {
      const r = check(doc, setAttr(doc, FIELDS.number, attr, value), ERIN);
      expect(r.applied, `${attr} applies`).toBe(true);
      if (r.applied) expect(r.verdict.ok, attr).toBe(false);
    }
  });

  describe('two fills of the same field through the room (P9)', () => {
    // A second tenant participant, so the two fills come from different people as well as
    // different channels.
    const TINA: Connection = { ...ERIN, sub: 'tina', session: 's-tina' };

    it('refuses the second fill, based before the first was stored, and keeps the first value', () => {
      const r = fillRoom();
      r.open('erin', ERIN);
      r.open('tina', TINA);
      const first = flush(r, r.submit('erin', fillCommit(doc, FIELDS.number, '1250.00', 0)));
      expect(answerOf(first, 'erin')).toMatchObject({ t: 'sync.ack', seq: 1 });
      expect(r.head).toBe(1);

      // Tina's fill is based on sequence 0, before Erin's fill was accepted at 1.
      const second = flush(r, r.submit('tina', fillCommit(doc, FIELDS.number, '999.00', 0)));
      expect(answerOf(second, 'tina')).toMatchObject({
        t: 'sync.reject',
        code: 'conflict',
        scopes: [`field:${FIELDS.number}`],
      });
      expect(second.write).toBeNull();
      // Nothing is merged: the stored value is still Erin's, and nothing new was stored.
      expect(r.head).toBe(1);
      expect(valueOf(r.document, FIELDS.number)).toBe('1250.00');
    });

    it('refuses the second fill while the first is accepted but not yet durable', () => {
      const r = fillRoom();
      r.open('erin', ERIN);
      r.open('tina', TINA);
      // Erin's fill is accepted and waits for storage; Tina's arrives on the same base.
      const first = r.submit('erin', fillCommit(doc, FIELDS.number, '1', 0));
      expect(first.write).not.toBeNull();
      const second = r.submit('tina', fillCommit(doc, FIELDS.number, '2', 0));
      expect(answerOf(second, 'tina')).toMatchObject({ t: 'sync.reject', code: 'conflict' });
      const done = flush(r, first);
      expect(answerOf(done, 'erin')).toMatchObject({ t: 'sync.ack', seq: 1 });
      expect(r.head).toBe(1);
      expect(valueOf(r.document, FIELDS.number)).toBe('1');
    });

    it('accepts the second fill when it is based on the first (no conflict without a stale base)', () => {
      const r = fillRoom();
      r.open('erin', ERIN);
      r.open('tina', TINA);
      flush(r, r.submit('erin', fillCommit(doc, FIELDS.number, '1', 0)));
      const second = flush(r, r.submit('tina', fillCommit(r.document, FIELDS.number, '2', 1)));
      expect(answerOf(second, 'tina')).toMatchObject({ t: 'sync.ack', seq: 2 });
      expect(valueOf(r.document, FIELDS.number)).toBe('2');
    });

    it('lets a stale fill of another field through: the conflict is per field', () => {
      const r = fillRoom();
      r.open('erin', ERIN);
      r.open('tina', TINA);
      flush(r, r.submit('erin', fillCommit(doc, FIELDS.number, '1', 0)));
      const other = flush(r, r.submit('tina', fillCommit(doc, FIELDS.legal, 'Tina Example', 0)));
      expect(answerOf(other, 'tina')).toMatchObject({ t: 'sync.ack', seq: 2 });
      expect(valueOf(r.document, FIELDS.number)).toBe('1');
      expect(valueOf(r.document, FIELDS.legal)).toBe('Tina Example');
    });
  });

  it('refuses every fill from a user without the fill role (P6 for a viewer, the core for an editor)', () => {
    expect(fillOf(doc, FIELDS.number, '1', FRANK)).toMatchObject({ ok: false });
    // An editor may change the body, so the fill is not refused for lack of a role here.
    expect(fillOf(doc, FIELDS.number, '1', CAROL).ok).toBe(true);
  });

  it('a participant of the other role gets its own field only', () => {
    expect(fillOf(doc, FIELDS.landlord, 'x', LENA).ok).toBe(true);
    expect(fillOf(doc, FIELDS.number, 'x', LENA)).toMatchObject({ ok: false });
  });

  it('the standard registry holds the fill rule P7 that the check uses', () => {
    expect(STANDARD_RULES.fill).toBe(FILL_RULE);
  });

  it('random commits of attribute steps on any node and text insertions change only an assigned field value', () => {
    const nodes = collectNodes(doc);
    const textblocks = collectTextblocks(doc);
    const attrNames = [
      'value',
      'key',
      'kind',
      'assignee',
      'required',
      'readOnly',
      'validation',
      'options',
      'width',
      'label',
      'id',
      'style',
      'bogus',
    ];
    const valueArb = fc.oneof(
      fc.string({ maxLength: 12 }),
      fc.integer({ min: -1000, max: 1000 }),
      fc.boolean(),
      fc.constant(null),
    );
    const attrStepArb = fc.record({
      kind: fc.constant('attr' as const),
      node: fc.integer({ min: 0, max: nodes.length - 1 }),
      attr: fc.constantFrom(...attrNames),
      value: valueArb,
    });
    const textStepArb = fc.record({
      kind: fc.constant('text' as const),
      block: fc.integer({ min: 0, max: textblocks.length - 1 }),
      text: fc.string({ minLength: 1, maxLength: 8 }),
    });
    const fillArb = fc.record({
      kind: fc.constant('attr' as const),
      node: fc.constantFrom(
        ...nodes.flatMap((pos, i) => (doc.nodeAt(pos)?.type.name === 'form_field' ? [i] : [])),
      ),
      attr: fc.constant('value'),
      value: fc.string({ maxLength: 12 }),
    });
    // Generic attribute steps and text insertions, plus fills of the fields, so that accepted
    // commits occur often enough for the property to bite.
    const commitArb = fc.oneof(attrStepArb, textStepArb, fillArb);
    let accepted = 0;

    fc.assert(
      fc.property(
        fc.array(commitArb, { minLength: 1, maxLength: 3 }),
        fc.constantFrom(ERIN, LENA),
        (commits, user) => {
          let current: Node = doc;
          for (const c of commits) {
            const steps: Step[] = [];
            if (c.kind === 'attr') {
              const pos = nodes[c.node]!;
              const target = current.nodeAt(pos);
              if (!target || target.isText) continue;
              steps.push(new AttrStep(pos, c.attr, c.value));
            } else {
              const pos = textblocks[c.block]!;
              const at = current.nodeAt(pos);
              if (!at) continue;
              const insertAt = pos + 1;
              steps.push(
                new ReplaceStep(
                  insertAt,
                  insertAt,
                  new Slice(Fragment.from(schema.text(c.text)), 0, 0),
                ),
              );
            }
            const r = check(current, steps, user);
            if (!r.applied) continue;
            if (!r.verdict.ok) continue;
            // An accepted commit may change only the value of a form field assigned to the participant.
            if (c.kind === 'text') {
              // A text insertion changes a container's content, which P7 never allows.
              throw new Error(`text insertion accepted for ${user.sub}`);
            }
            if (r.after.eq(current)) continue;
            const pos = nodes[c.node]!;
            const target = current.nodeAt(pos)!;
            expect(target.type.name).toBe('form_field');
            expect(c.attr).toBe('value');
            expect(user.participantRoles).toContain(target.attrs['assignee']);
            expect(target.attrs['readOnly']).not.toBe(true);
            accepted += 1;
            current = r.after;
          }
        },
      ),
      { numRuns: 300 },
    );
    expect(accepted).toBeGreaterThan(0);
  });

  it('the region list of the fixture reads the restricted region', () => {
    expect(regionsOf(doc).map((r) => r.id)).toEqual(['rLegal000000000B']);
  });
});

type Effects = ReturnType<Room['submit']>;

let clock = 1_770_000_000_000;
let counter = 0;
/** A fresh commit identifier in the UUID version 7 layout. */
const commitId = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

/** A room over the fields document, at sequence 0, with the fixture's permissions. */
function fillRoom(): Room {
  return new Room({
    schema,
    initial: fieldsDoc(),
    requires: ['fields'],
    log: [],
    perms: permissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-sec-022',
    now: () => ++clock,
  });
}

/** A fill commit: one `attr` step setting `value` on the field `id`, made on `doc`, based on `base`. */
function fillCommit(doc: Node, id: string, value: unknown, base: number) {
  return { id: commitId(), base, steps: stepsToJson(setAttr(doc, id, 'value', value)) };
}

/** Completes every storage write the room asks for, and returns everything it sent. */
function flush(r: Room, fx: Effects): Effects {
  const all: Effects = { send: [...fx.send], write: null };
  let write = fx.write;
  while (write) {
    const done = r.writeCompleted({ status: 'ok' });
    all.send.push(...done.send);
    write = done.write;
  }
  return { ...all, write: fx.write };
}

/** The acknowledgement or rejection sent to `channel`. */
function answerOf(fx: Effects, channel: string) {
  return fx.send
    .filter((o) => o.channel === channel)
    .map((o) => o.msg)
    .find((m) => m.t === 'sync.ack' || m.t === 'sync.reject');
}

/** The stored `value` of the field `id`. */
function valueOf(doc: Node, id: string): unknown {
  const n = doc.nodeAt(posOfId(doc, id));
  return n?.attrs['value'];
}

/** Positions of every non-root node in document order, as stable indexes for the generator. */
function collectNodes(doc: Node): number[] {
  const out: number[] = [];
  doc.descendants((n, pos) => {
    if (!n.isText) out.push(pos);
    return true;
  });
  return out;
}

/** Positions of every textblock in document order. */
function collectTextblocks(doc: Node): number[] {
  const out: number[] = [];
  doc.descendants((n, pos) => {
    if (n.isTextblock) out.push(pos);
    return true;
  });
  return out;
}
