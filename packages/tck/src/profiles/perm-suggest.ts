/**
 * The `perm-suggest` profile (PRO-118; 05 §11; 07 §5.2; 04 §3.1). A user with only `suggest` may add
 * suggestion marks and nothing else (rule P4); an editor accepts or rejects a suggestion with the
 * commit origins `suggestion.accept` and `suggestion.reject`, and a suggester may not accept its own
 * suggestion; a property test of random commits from a suggestion-only user is judged by the
 * reference outcome check (PRM-009). The profile runs only for a server that announces
 * `suggest-enforced`.
 */
import type { Step } from '@docedit/protocol';
import fc from 'fast-check';
import { check, equal, includes } from '../assert.ts';
import type { ScenarioContext } from '../context.ts';
import {
  IDS,
  contractDocument,
  deleteRange,
  insertText,
  nodeById,
  posIn,
  textOf,
} from '../documents.ts';
import { judge, permissionState } from '../oracle.ts';
import { scenario, type ProfileDef, type ScenarioDef } from '../scenario.ts';
import { propertyFailure } from './perm.ts';
import { acked, join, readContent, rejected, submit, type Member } from './support.ts';

const doc = (def: Omit<ScenarioDef, 'id'> & { id: string }) => scenario('perm-suggest', def);

/** A suggestion identifier of 16 characters, unique within one run (03 §5). */
function suggestionId(n: number): string {
  return `sSugg${String(n).padStart(11, '0')}`;
}

/** An insertion the user suggests: its text carries an `ins` mark that names the user (03 §5). */
function suggestedInsert(pos: number, text: string, id: string, user: string): Step {
  return {
    stepType: 'replace',
    from: pos,
    to: pos,
    slice: { content: [{ type: 'text', text, marks: [{ type: 'ins', attrs: { id, user } }] }] },
  } as Step;
}

/** A deletion the user suggests: a `del` mark over the text, which stays until it is accepted. */
function suggestedDelete(from: number, to: number, id: string, user: string): Step {
  return {
    stepType: 'addMark',
    mark: { type: 'del', attrs: { id, user } },
    from,
    to,
  } as Step;
}

/** Accepting a suggested insertion: its `ins` mark is taken off the text it covers. */
function acceptInsertion(from: number, to: number, id: string, user: string): Step {
  return {
    stepType: 'removeMark',
    mark: { type: 'ins', attrs: { id, user } },
    from,
    to,
  } as Step;
}

/** The current content of a document as the user reads it at the head (05 §6.2). */
async function head(ctx: ScenarioContext, token: string, d: string) {
  return readContent(ctx, token, d);
}

/** A suggestion of the member's own, at the head, at the start of the intro paragraph. */
async function suggestAtStart(
  ctx: ScenarioContext,
  m: Member,
  id: string,
  text: string,
): Promise<number> {
  const c = await head(ctx, m.token, m.doc);
  const ack = await acked(m.wire, m.ch, {
    base: c.seq,
    steps: [suggestedInsert(posIn(c.doc, IDS.intro, 0), text, id, m.sub)],
  });
  return ack.seq;
}

export const PERM_SUGGEST: ProfileDef = {
  id: 'perm-suggest',
  title: 'Suggestion-only rule P4',
  spec: '07 §5.2; 05 §5.3, §11; 04 §3.1',
  stories: ['PRO-118'],
  requires: { kind: 'features', features: ['suggest-enforced'] },
  scenarios: [
    doc({
      id: 'direct-rejected',
      title:
        'a suggestion-only user who changes content directly is refused with permission_denied',
      spec: '07 §5.2; 05 §5.3',
      covers: {
        messages: ['sync.submit', 'sync.reject'],
        errors: ['permission_denied'],
      },
      async run(ctx) {
        const d = await ctx.document();
        const m = await join(ctx, 'suggester', d, 'suggester');
        const r = await rejected(m.wire, m.ch, {
          base: m.content.seq,
          steps: [insertText(posIn(m.content.doc, IDS.intro, 0), 'Direct ')],
        });
        equal(r.code, 'permission_denied', 'a direct change by a suggester (07 §5.2)');
        includes(r.scopes, 'body', 'the rejection names the scope that was changed');
        await m.wire.close();
      },
    }),
    doc({
      id: 'suggestion-accepted',
      title: 'a suggestion-only user who adds only suggestion marks is accepted',
      spec: '07 §5.2; 03 §5',
      covers: { messages: ['sync.submit', 'sync.ack'] },
      async run(ctx) {
        const d = await ctx.document();
        const m = await join(ctx, 'suggester', d, 'suggester');
        const seq = await suggestAtStart(ctx, m, suggestionId(1), 'Proposed ');
        check(seq > m.content.seq, 'the suggestion is stored', `> ${m.content.seq}`, seq);
        const after = await head(ctx, m.token, d);
        check(
          textOf(after.doc, IDS.intro).includes('Proposed '),
          'the suggested text is in the content',
          'Proposed ',
          textOf(after.doc, IDS.intro),
        );
        await m.wire.close();
      },
    }),
    doc({
      id: 'suggestion-accept-reject',
      title:
        'an editor accepts or rejects a suggestion with its origin; a suggester may not accept its own',
      spec: '07 §5.2; 05 §5.3; 07 §5',
      covers: {
        messages: ['sync.submit', 'sync.ack', 'sync.reject'],
        errors: ['permission_denied'],
      },
      async run(ctx) {
        const d = await ctx.document();
        const s = await join(ctx, 'suggester', d, 'suggester');
        const kept = suggestionId(2);
        const dropped = suggestionId(3);
        await suggestAtStart(ctx, s, kept, 'Accept ');
        await suggestAtStart(ctx, s, dropped, 'Reject ');

        // The suggester may not accept its own suggestion: that changes the scope without the editor's
        // edit right (P4 refuses it, 07 §5.2).
        const own = await head(ctx, s.token, d);
        const at = posIn(own.doc, IDS.intro, 0);
        const selfAccept = await rejected(s.wire, s.ch, {
          base: own.seq,
          origin: 'suggestion.accept',
          steps: [acceptInsertion(at, at + 'Reject '.length, dropped, s.sub)],
        });
        equal(selfAccept.code, 'permission_denied', 'a suggester accepting its own suggestion');

        const e = await join(ctx, 'editor', d, 'editor');
        // The editor accepts the first suggestion, which follows the second one: its mark goes and its
        // text stays (origin suggestion.accept).
        const c1 = await head(ctx, e.token, d);
        const from = posIn(c1.doc, IDS.intro, 'Reject '.length);
        const accepted = await acked(e.wire, e.ch, {
          base: c1.seq,
          origin: 'suggestion.accept',
          steps: [acceptInsertion(from, from + 'Accept '.length, kept, s.sub)],
        });
        check(
          accepted.seq > c1.seq,
          'the accepted suggestion is stored',
          `> ${c1.seq}`,
          accepted.seq,
        );

        // The editor rejects the second: its text is deleted (origin suggestion.reject).
        const c2 = await head(ctx, e.token, d);
        const start = posIn(c2.doc, IDS.intro, 0);
        const rejectedAck = await acked(e.wire, e.ch, {
          base: c2.seq,
          origin: 'suggestion.reject',
          steps: [deleteRange(start, start + 'Reject '.length)],
        });
        check(
          rejectedAck.seq > c2.seq,
          'the rejected suggestion is removed',
          `> ${c2.seq}`,
          rejectedAck.seq,
        );
        const final = await head(ctx, e.token, d);
        check(
          !textOf(final.doc, IDS.intro).includes('Reject '),
          'the rejected text is gone from the content',
          'no Reject ',
          textOf(final.doc, IDS.intro),
        );
        await s.wire.close();
        await e.wire.close();
      },
    }),
    doc({
      id: 'property',
      title:
        'random commits from a suggestion-only user: no accepted commit changes content outside suggestion marks',
      spec: '07 §5.2; 11 §2 (S3); PRM-009',
      timeoutMs: 240_000,
      covers: { messages: ['sync.submit'] },
      async run(ctx) {
        const targets = [IDS.intro, IDS.openPara, IDS.mid, IDS.lockedPara, IDS.end];
        const target = fc.constantFrom(...targets);
        const text = fc.string({ minLength: 1, maxLength: 3 });
        const op = fc.oneof(
          fc.record({
            kind: fc.constant('suggest-insert' as const),
            at: target,
            offset: fc.nat(14),
            text,
          }),
          fc.record({
            kind: fc.constant('plain-insert' as const),
            at: target,
            offset: fc.nat(14),
            text,
          }),
          fc.record({
            kind: fc.constant('suggest-delete' as const),
            at: target,
            offset: fc.nat(10),
            len: fc.integer({ min: 1, max: 5 }),
          }),
          fc.record({
            kind: fc.constant('plain-delete' as const),
            at: target,
            offset: fc.nat(10),
            len: fc.integer({ min: 1, max: 5 }),
          }),
          fc.record({
            kind: fc.constant('plain-bold' as const),
            at: target,
            offset: fc.nat(10),
            len: fc.integer({ min: 1, max: 5 }),
          }),
        );
        let n = 100;
        const nextId = () => suggestionId(++n);
        let accepted = 0;
        let submitted = 0;
        await fc
          .assert(
            fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 5 }), async (ops) => {
              const sub = ctx.sub('suggest-only');
              const d = await ctx.document(contractDocument(), []);
              const token = await ctx.service.token(sub, { [d]: 'suggester' });
              const w = await ctx.connect({ label: 'property-suggester' });
              try {
                await ctx.hello(w, token);
                const perms = permissionState([]);
                for (const x of ops) {
                  const before = await head(ctx, token, d);
                  const cur = before.doc;
                  const seq = before.seq;
                  const steps = suggestSteps(cur, x, sub, nextId);
                  if (!steps) continue;
                  submitted++;
                  const r = await submit(w, 1, { base: seq, steps });
                  if (r.t !== 'sync.ack') continue;
                  accepted++;
                  const after = await ctx.service.call('GET', `/documents/${d}/content`, {
                    query: { seq: r.d.seq },
                  });
                  const verdict = judge(
                    cur,
                    (after.json as { doc: unknown }).doc,
                    { sub, role: 'suggester' },
                    perms,
                  );
                  if (!verdict.ok)
                    throw new Error(
                      `an accepted commit of a suggestion-only user changes content outside suggestion marks (07 §5.2): ${verdict.reason}; steps ${JSON.stringify(steps)}`,
                    );
                }
              } finally {
                await w.close();
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
          `seed ${ctx.config.property.seed}, ${ctx.config.property.runs} runs: ${submitted} commits submitted, ${accepted} accepted and judged`,
        );
        check(submitted > 0, 'the property submitted commits', '> 0', submitted);
      },
    }),
  ],
};

/** One random operation: `text` for an insertion, `len` for a range. */
export interface SuggestOp {
  kind: 'suggest-insert' | 'plain-insert' | 'suggest-delete' | 'plain-delete' | 'plain-bold';
  at: string;
  offset: number;
  text?: string;
  len?: number;
}

/**
 * Steps for one random operation of a suggestion-only user, or null when it cannot apply. The
 * identifiers are the user's own (the submitting user, 03 §5); plain changes are the ones P4 refuses.
 */
export function suggestSteps(
  cur: unknown,
  x: SuggestOp,
  sub: string,
  nextId: () => string,
): Step[] | null {
  if (nodeById(cur, x.at) === null) return null;
  const len = textOf(cur, x.at).length;
  const text = x.text ?? '';
  const span = x.len ?? 1;
  if (x.kind === 'suggest-insert' || x.kind === 'plain-insert') {
    const pos = posIn(cur, x.at, Math.min(x.offset, len));
    return [
      x.kind === 'suggest-insert'
        ? suggestedInsert(pos, text, nextId(), sub)
        : insertText(pos, text),
    ];
  }
  if (len === 0) return null;
  const from = posIn(cur, x.at, Math.min(x.offset, len - 1));
  const to = posIn(cur, x.at, Math.min(len, Math.min(x.offset, len - 1) + span));
  if (x.kind === 'suggest-delete') return [suggestedDelete(from, to, nextId(), sub)];
  if (x.kind === 'plain-delete') return [deleteRange(from, to)];
  return [{ stepType: 'addMark', mark: { type: 'bold' }, from, to } as Step];
}
