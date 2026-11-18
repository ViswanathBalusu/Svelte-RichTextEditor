/**
 * The `perm-fill` profile (FRW-066; 12 §4 P7 and P9, §10, §13; 07 §5.1; 11 §2, S3). A participant who
 * may only fill is minted a token with the fill roles claim (`wfr`, 05 §3.1) for one role, and sends
 * random commits through DEP: fills of the fields of its role, of another role's fields and of the
 * fields only the server writes, edits of the text, deleted and pasted fields, changed attributes of a
 * field, a mark, a crafted `replaceAround`, and a fill made on a stale base after another participant
 * changed the same field. The server is a black box. Every commit it accepts is judged twice: by the
 * outcome check of the authority (the reference semantics, as `perm-suggest` does) and by an oracle
 * written apart from it (`setAsideFilled`): only the values of the fields of the participant's role
 * may differ. Every commit it refuses must leave the document as it was. A failure names the seed and
 * fast-check's counterexample, which is the failing sequence of operations, and the steps of the
 * commit that broke the property.
 */
import { canonicalize } from '@docedit/model';
import type { Step } from '@docedit/protocol';
import fc from 'fast-check';
import { KitFailure, check } from '../assert.ts';
import type { ScenarioContext } from '../context.ts';
import { nodeById, posBefore, type JsonNode } from '../documents.ts';
import { judge, permissionState } from '../oracle.ts';
import { scenario, type ProfileDef } from '../scenario.ts';
import { FIELD_IDS, fieldsDocument } from './fields.ts';
import { propertyFailure } from './perm.ts';
import { join, readContent, submit } from './support.ts';

/** The role the fill-only participant has (the `wfr` claim, 05 §3.1; 12 §13). */
export const FILL_ROLE = 'role_tenant';

/** One random operation of a fill-only participant. */
export type FillOp =
  | { kind: 'fill-own'; value: string }
  | { kind: 'fill-landlord'; value: string }
  | { kind: 'fill-server'; field: 'sign' | 'signed'; value: string }
  | { kind: 'edit-text'; offset: number; text: string }
  | { kind: 'delete-field'; field: 'name' | 'rent' | 'sign' | 'signed' }
  | { kind: 'retarget'; attr: 'assignee' | 'key' | 'kind' | 'label' | 'readOnly'; value: string }
  | { kind: 'paste-field'; assignee: string; value: string | null }
  | { kind: 'bold'; offset: number; len: number }
  | { kind: 'wrap' }
  | { kind: 'concurrent'; theirs: string; mine: string };

const FIELD_OF = {
  name: FIELD_IDS.name,
  rent: FIELD_IDS.rent,
  sign: FIELD_IDS.sign,
  signed: FIELD_IDS.signed,
} as const;

/** The size of a node in the ProseMirror position scheme, from its JSON. */
function nodeSize(n: JsonNode): number {
  if (n.type === 'text') return (n.text ?? '').length;
  // A leaf (a field) has size 1; any other node is its content and its two boundaries.
  return n.content === undefined ? 1 : n.content.reduce((a, c) => a + nodeSize(c), 0) + 2;
}

/** The steps of one operation over the document `cur`, as the participant read it at the head. */
export function fillSteps(cur: unknown, op: FillOp): Step[] {
  const set = (id: string, attr: string, value: unknown): Step =>
    ({ stepType: 'attr', pos: posBefore(cur, id), attr, value }) as Step;
  const intro = posBefore(cur, FIELD_IDS.para) + 1;
  switch (op.kind) {
    case 'fill-own':
      return [set(FIELD_IDS.name, 'value', op.value)];
    case 'fill-landlord':
      return [set(FIELD_IDS.rent, 'value', op.value)];
    case 'fill-server':
      return [set(FIELD_OF[op.field], 'value', op.value)];
    case 'edit-text': {
      const at = intro + Math.min(op.offset, 5);
      return [
        {
          stepType: 'replace',
          from: at,
          to: at,
          slice: { content: [{ type: 'text', text: op.text }] },
        } as Step,
      ];
    }
    case 'delete-field': {
      const at = posBefore(cur, FIELD_OF[op.field]);
      return [{ stepType: 'replace', from: at, to: at + 1 } as Step];
    }
    case 'retarget':
      return [
        set(FIELD_IDS.name, op.attr, op.attr === 'readOnly' ? op.value === 'true' : op.value),
      ];
    case 'paste-field': {
      const at = posBefore(cur, 'pAfter0000000001') + 1;
      return [
        {
          stepType: 'replace',
          from: at,
          to: at,
          slice: {
            content: [
              {
                type: 'form_field',
                attrs: {
                  id: 'fPaste000000001',
                  key: 'pasted',
                  kind: 'text',
                  label: 'pasted',
                  assignee: op.assignee,
                  value: op.value,
                },
              },
            ],
          },
        } as Step,
      ];
    }
    case 'bold': {
      const from = intro + Math.min(op.offset, 4);
      return [
        { stepType: 'addMark', mark: { type: 'bold' }, from, to: from + 1 + (op.len % 3) } as Step,
      ];
    }
    case 'wrap': {
      // A crafted replaceAround: the paragraph of the fields wrapped in a new paragraph.
      const from = posBefore(cur, FIELD_IDS.para);
      const to = from + nodeSize(nodeById(cur, FIELD_IDS.para)!);
      return [
        {
          stepType: 'replaceAround',
          from,
          to,
          gapFrom: from + 1,
          gapTo: to - 1,
          insert: 1,
          slice: { content: [{ type: 'paragraph', attrs: { id: 'pWrap0000000001' } }] },
          structure: false,
        } as unknown as Step,
      ];
    }
    case 'concurrent':
      return [set(FIELD_IDS.name, 'value', op.mine)];
  }
}

/**
 * The oracle of FRW-066, written apart from the authority's outcome check (07 §5.1): the document
 * with the values of the fields the participant may fill set aside. Two documents that differ only
 * there are equal for this participant; any other difference is outside what P7 allows.
 */
export function setAsideFilled(n: JsonNode, roles: readonly string[]): JsonNode {
  const out: JsonNode = { ...n };
  if (n.type === 'form_field' && n.attrs) {
    const kind = n.attrs['kind'] as string;
    const serverOnly = ['signature', 'initials', 'dateSigned', 'formula'].includes(kind);
    if (roles.includes(n.attrs['assignee'] as string) && !serverOnly) {
      const { value: _value, ...rest } = n.attrs;
      out.attrs = rest;
    }
  }
  if (n.content) out.content = n.content.map((c) => setAsideFilled(c, roles));
  return out;
}

const rec = <K extends string, T extends Record<string, fc.Arbitrary<unknown>>>(kind: K, t: T) =>
  fc.record({ kind: fc.constant(kind), ...t });

const fillOp = fc.oneof(
  { weight: 4, arbitrary: rec('fill-own', { value: fc.string({ maxLength: 12 }) }) },
  { weight: 2, arbitrary: rec('fill-landlord', { value: fc.constantFrom('1', '12.50', 'x') }) },
  {
    weight: 2,
    arbitrary: rec('fill-server', {
      field: fc.constantFrom('sign', 'signed'),
      value: fc.constantFrom('2026-11-17', 'x'),
    }),
  },
  {
    weight: 2,
    arbitrary: rec('edit-text', {
      offset: fc.nat(5),
      text: fc.string({ minLength: 1, maxLength: 3 }),
    }),
  },
  {
    weight: 2,
    arbitrary: rec('delete-field', { field: fc.constantFrom('name', 'rent', 'sign', 'signed') }),
  },
  {
    weight: 2,
    arbitrary: rec('retarget', {
      attr: fc.constantFrom('assignee', 'key', 'kind', 'label', 'readOnly'),
      value: fc.constantFrom('role_landlord', 'rent', 'signature', 'x', 'true', 'false'),
    }),
  },
  {
    weight: 2,
    arbitrary: rec('paste-field', {
      assignee: fc.constantFrom('role_tenant', 'role_landlord'),
      value: fc.constantFrom(null, 'pasted'),
    }),
  },
  { weight: 1, arbitrary: rec('bold', { offset: fc.nat(4), len: fc.nat(2) }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'wrap' }) },
  {
    weight: 2,
    arbitrary: rec('concurrent', {
      theirs: fc.string({ minLength: 1, maxLength: 6 }),
      mine: fc.string({ minLength: 1, maxLength: 6 }),
    }),
  },
) as fc.Arbitrary<FillOp>;

/** The content of the document at the head, or at `seq`, read with the observer's token. */
async function contentAt(ctx: ScenarioContext, token: string, doc: string, seq?: number) {
  return readContent(ctx, token, doc, seq);
}

/**
 * The profile. `grant` is what the participant asks the server for in its token; it is the contract
 * (`FILL_ROLE` only) unless a test makes it wider to stand for a server that grants more than it
 * should, which the oracle then catches.
 */
export function permFillProfile(grant: readonly string[] = [FILL_ROLE]): ProfileDef {
  return {
    id: 'perm-fill',
    title: 'Fill permission (P7, P9) as a black-box property',
    spec: '12 §4 P7, P9, §10, §13; 07 §5.1',
    stories: ['FRW-066'],
    requires: { kind: 'features', features: ['fields'] },
    scenarios: [
      scenario('perm-fill', {
        id: 'property',
        title:
          'a participant that may only fill changes nothing but the values of the fields of its role, and a refused commit changes nothing',
        spec: '12 §4 P7, P9; 07 §5.1; FRW-066',
        timeoutMs: 240_000,
        covers: { messages: ['sync.submit'] },
        async run(ctx) {
          const roles = [FILL_ROLE];
          const perms = permissionState([]);

          /** A document, its observer (the owner reads the whole document) and two fill-only members. */
          async function setup() {
            const doc = await ctx.document(fieldsDocument());
            const observer = await ctx.token('fill-observer', { [doc]: 'owner' });
            const mine = await join(ctx, 'fill-only', doc, 'filler', { token: { wfr: grant } });
            return { doc, observer: observer.token, mine };
          }

          // The target has to give fill roles from the claim; one that does not is not tested here.
          {
            const { doc, observer, mine } = await setup();
            const cur = (await contentAt(ctx, observer, doc)).doc;
            const probe = await submit(mine.wire, mine.ch, {
              base: (await contentAt(ctx, observer, doc)).seq,
              steps: fillSteps(cur, { kind: 'fill-own', value: 'probe' }),
            });
            if (probe.t === 'sync.reject' && probe.d.code === 'permission_denied')
              ctx.skip(
                'the target gives no fill roles from the `wfr` claim of a minted token (05 §3.1; 12 §13)',
              );
            if (probe.t !== 'sync.ack')
              throw new KitFailure(
                'a fill of a field of the participant’s role is accepted',
                'sync.ack',
                probe,
              );
            await mine.wire.close();
          }

          let submitted = 0;
          let accepted = 0;
          let refused = 0;
          let conflicts = 0;
          await fc
            .assert(
              fc.asyncProperty(fc.array(fillOp, { minLength: 1, maxLength: 6 }), async (ops) => {
                const { doc, observer, mine } = await setup();
                const other = await join(ctx, 'fill-other', doc, 'filler', {
                  ch: 1,
                  token: { wfr: grant },
                });
                try {
                  for (const op of ops) {
                    const before = await contentAt(ctx, observer, doc);
                    const cur = before.doc as unknown as JsonNode;
                    const steps = fillSteps(cur, op);
                    // The participant has read the head; `concurrent` lets another participant change
                    // the same field first, so that this commit is made on a base behind it (P9).
                    let theirs = false;
                    if (op.kind === 'concurrent') {
                      const r = await submit(other.wire, other.ch, {
                        base: before.seq,
                        steps: fillSteps(cur, { kind: 'fill-own', value: op.theirs }),
                      });
                      theirs = r.t === 'sync.ack';
                    }
                    const mark = theirs ? await contentAt(ctx, observer, doc) : before;
                    const r = await submit(mine.wire, mine.ch, { base: before.seq, steps });
                    submitted++;
                    const fail = (what: string): never => {
                      throw new KitFailure(
                        `${what} (${op.kind}; base ${before.seq}); steps ${JSON.stringify(steps)}`,
                        'only the values of the fields of the participant’s role change, and a refused commit changes nothing (12 §4 P7, P9)',
                        r.t === 'sync.ack' ? { ack: r.d } : r,
                      );
                    };
                    if (r.t === 'sync.ack') {
                      accepted++;
                      const after = await contentAt(ctx, observer, doc, r.d.seq);
                      // A commit made on a base behind a change of the same field is a conflict (P9).
                      if (theirs) fail('a fill overwrote a value that changed after its base (P9)');
                      // The independent oracle: only values of the fields of the role differ.
                      const a = canonicalize(
                        setAsideFilled(
                          (await contentAt(ctx, observer, doc, r.d.seq - 1))
                            .doc as unknown as JsonNode,
                          roles,
                        ) as never,
                      );
                      const b = canonicalize(
                        setAsideFilled(after.doc as unknown as JsonNode, roles) as never,
                      );
                      if (a !== b)
                        fail(
                          'an accepted commit changed more than the values of the participant’s fields',
                        );
                      // The authority's outcome check, on the same two documents.
                      const verdict = judge(
                        (await contentAt(ctx, observer, doc, r.d.seq - 1)).doc,
                        after.doc,
                        { sub: mine.sub, role: 'filler', participantRoles: roles },
                        perms,
                      );
                      if (!verdict.ok)
                        fail(
                          `the reference outcome check refuses an accepted commit: ${verdict.reason}`,
                        );
                    } else if (r.t === 'sync.reject') {
                      refused++;
                      if (theirs) conflicts++;
                      // A refused commit leaves the document as it was (the head is the one it read,
                      // or the head after the other participant's accepted fill).
                      const now = await contentAt(ctx, observer, doc);
                      if (
                        now.seq !== mark.seq ||
                        canonicalize(now.doc as never) !== canonicalize(mark.doc as never)
                      )
                        fail('a refused commit changed the document');
                      // A fill of a field of the role, on the head, is not refused.
                      if (op.kind === 'fill-own' && r.d.code === 'permission_denied')
                        fail('a fill of a field of the participant’s role is refused');
                    } else {
                      fail('the server answered neither sync.ack nor sync.reject');
                    }
                  }
                } finally {
                  await mine.wire.close();
                  await other.wire.close();
                }
              }),
              {
                seed: ctx.config.property.seed,
                numRuns: ctx.config.property.runs,
                endOnFailure: true,
              },
            )
            .catch((e: unknown) => {
              throw propertyFailure(e, ctx.config.property.seed);
            });
          ctx.note(
            `seed ${ctx.config.property.seed}, ${ctx.config.property.runs} runs: ${submitted} commits submitted, ${accepted} accepted, ${refused} refused (${conflicts} on a stale base)`,
          );
          check(accepted > 0, 'the property had accepted fills to judge', '> 0', accepted);
          check(refused > 0, 'the property had refused commits to judge', '> 0', refused);
        },
      }),
    ],
  };
}

export const PERM_FILL: ProfileDef = permFillProfile();
