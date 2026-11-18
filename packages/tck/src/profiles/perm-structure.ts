/**
 * The `perm-region` scenarios for splitting and merging regions (PRM-065, PRM-034; ADR 0033 item 3,
 * accepted by owner decision 220 of 2026-11-15). A split and a merge are whole-node operations: the
 * part that keeps the identifier keeps its grants, state and lease; the other part is a new region
 * with a fresh identifier, no grants and the policy the commit gives it; a merge retires one region
 * and moves its blocks into the other. Both need `structure` and `edit` in every region affected,
 * and a new part with a policy other than `inherit` also needs `manage`.
 *
 * The steps are written as JSON from the CDM alone, as the rest of the kit does (04 §4).
 */
import { equal, check, includes, excludes } from '../assert.ts';
import {
  IDS,
  LOCKED_SCOPE,
  contractDocument,
  insertText,
  nodeById,
  nodeSize,
  paragraph,
  posBefore,
  posIn,
  setAttr,
  type JsonNode,
} from '../documents.ts';
import { scenario, type ScenarioDef } from '../scenario.ts';
import { acked, join, readContent, rejected } from './support.ts';

type Def = Omit<ScenarioDef, 'id'> & { id: string };
const reg = (def: Def) => scenario('perm-region', def);

const OPEN_SECOND = 'pOpenSecond00001';
const LOCKED_SECOND = 'pLockedSecond001';
const FRESH = 'rSplit0000000001';
const FRESH_LOCKED = 'rSplit0000000002';

/** The contract document with a second paragraph in each of its two regions. */
function twoParagraphs() {
  const env = contractDocument();
  const body = (env.doc as unknown as JsonNode).content!.find((n) => n.type === 'body')!;
  for (const region of body.content!.filter((n) => n.type === 'region')) {
    const open = region.attrs?.['id'] === IDS.open;
    region.content!.push(paragraph(open ? OPEN_SECOND : LOCKED_SECOND, 'Second'));
  }
  return env;
}

const attrsOf = (content: unknown, id: string) =>
  (nodeById(content, id) as JsonNode).attrs as Record<string, unknown>;

/**
 * Splits the region `region` before its block `before`: the closing and opening of a region at that
 * position (what `Transform.split` writes), then the identifier of the second part (and, when given,
 * its policy), which only the commit can choose.
 */
function splitSteps(
  content: unknown,
  region: string,
  before: string,
  fresh: string,
  policy?: string,
) {
  const at = posBefore(content, before);
  const attrs = attrsOf(content, region);
  const steps: unknown[] = [
    {
      stepType: 'replace',
      from: at,
      to: at,
      structure: true,
      slice: {
        content: [
          { type: 'region', attrs: { ...attrs } },
          { type: 'region', attrs: { ...attrs } },
        ],
        openStart: 1,
        openEnd: 1,
      },
    },
    setAttr(at + 1, 'id', fresh),
  ];
  if (policy !== undefined) steps.push(setAttr(at + 1, 'policy', policy));
  return steps as never[];
}

/** Merges `second` into `first` (which comes before it) as whole-node operations. */
function mergeSteps(content: unknown, first: string, second: string) {
  const a = posBefore(content, first);
  const aEnd = a + nodeSize(nodeById(content, first) as JsonNode);
  const b = posBefore(content, second);
  const node = nodeById(content, second) as JsonNode;
  return [
    { stepType: 'replace', from: b, to: b + nodeSize(node) },
    {
      stepType: 'replace',
      from: aEnd - 1,
      to: aEnd - 1,
      slice: { content: node.content ?? [] },
    },
  ] as never[];
}

const idsIn = (content: unknown, region: string): string[] =>
  ((nodeById(content, region) as JsonNode | null)?.content ?? []).map(
    (n) => n.attrs?.['id'] as string,
  );

export const PERM_REGION_STRUCTURE: ScenarioDef[] = [
  reg({
    id: 'split-merge',
    title:
      'a split makes a new region beside the one that keeps its identifier; a merge retires one region; a retired identifier is not reused',
    spec: '07 §2, §5.2; ADR 0033 item 3; PRM-065; PRM-034; 03 §8 (I3)',
    covers: {
      messages: ['sync.submit', 'sync.ack', 'sync.reject'],
      errors: ['invalid_op'],
    },
    async run(ctx) {
      const d = await ctx.document(twoParagraphs());
      const m = await join(ctx, 'structure', d, 'editor');
      // Split: the first part keeps its identifier, the second is new and takes the policy given.
      const split = await acked(m.wire, m.ch, {
        base: m.content.seq,
        steps: splitSteps(m.content.doc, IDS.open, OPEN_SECOND, FRESH),
      });
      const after = await readContent(ctx, m.token, d);
      check(
        after.seq >= split.seq,
        'the content is read at the split or later',
        split.seq,
        after.seq,
      );
      equal(idsIn(after.doc, IDS.open).join(), IDS.openPara, 'the first part keeps its blocks');
      equal(idsIn(after.doc, FRESH).join(), OPEN_SECOND, 'the new region holds the second block');
      equal(attrsOf(after.doc, FRESH)['policy'], 'inherit', 'the new part takes the policy given');
      // Merge: the new region is deleted as a whole node and its blocks move into the first.
      await acked(m.wire, m.ch, {
        base: after.seq,
        steps: mergeSteps(after.doc, IDS.open, FRESH),
      });
      const merged = await readContent(ctx, m.token, d);
      equal(
        idsIn(merged.doc, IDS.open).join(),
        [IDS.openPara, OPEN_SECOND].join(),
        'the survivor holds both parts',
      );
      check(nodeById(merged.doc, FRESH) === null, 'the merged region is gone', 'no node', FRESH);
      // I3: a retired identifier is never reused, so the same split again is refused.
      const again = await rejected(m.wire, m.ch, {
        base: merged.seq,
        steps: splitSteps(merged.doc, IDS.open, OPEN_SECOND, FRESH),
      });
      equal(again.code, 'invalid_op', 'a retired region identifier cannot come back');
    },
  }),
  reg({
    id: 'split-restricted',
    title:
      'splitting a restricted region needs edit in it, and manage for a new part that stays restricted; the new part has no grants',
    spec: '07 §2, §5.2; ADR 0033 item 3; PRM-065; PRM-034',
    covers: {
      messages: ['sync.submit', 'sync.ack', 'sync.reject', 'perm.changed'],
      errors: ['permission_denied'],
      fields: ['sync.reject.scopes'],
    },
    async run(ctx) {
      const d = await ctx.document(twoParagraphs());
      // An editor with no grant on the restricted region may not split it: edit there is missing.
      const outsider = await join(ctx, 'outsider', d, 'editor');
      const refused = await rejected(outsider.wire, outsider.ch, {
        base: outsider.content.seq,
        steps: splitSteps(outsider.content.doc, IDS.locked, LOCKED_SECOND, FRESH_LOCKED, 'inherit'),
      });
      equal(refused.code, 'permission_denied', 'a split without edit in the region');
      includes(refused.scopes, LOCKED_SCOPE, 'the rejection names the region');
      // A grantee who is an editor may split it when the new part is `inherit`, but not when the
      // new part stays restricted: that needs manage.
      const grantee = await join(ctx, 'grantee', d, 'editor');
      const from = grantee.wire.mark();
      await ctx.service.setGrants(d, [
        { region: IDS.locked, principal: `user:${grantee.sub}`, role: 'editor' },
      ]);
      await grantee.wire.nextOf('perm.changed', { from });
      const now = await readContent(ctx, grantee.token, d);
      const kept = await rejected(grantee.wire, grantee.ch, {
        base: now.seq,
        steps: splitSteps(now.doc, IDS.locked, LOCKED_SECOND, FRESH_LOCKED),
      });
      equal(kept.code, 'permission_denied', 'a restricted new part without manage');
      // An owner may; the new part has a fresh identifier and no grants.
      const owner = await join(ctx, 'owner', d, 'owner');
      const head = await readContent(ctx, owner.token, d);
      await acked(owner.wire, owner.ch, {
        base: head.seq,
        steps: splitSteps(head.doc, IDS.locked, LOCKED_SECOND, FRESH_LOCKED),
      });
      const split = await readContent(ctx, grantee.token, d);
      equal(attrsOf(split.doc, FRESH_LOCKED)['policy'], 'restricted', 'the new part is restricted');
      // The grant follows the identifier that was kept, not the new part.
      const outside = await rejected(grantee.wire, grantee.ch, {
        base: split.seq,
        steps: [insertText(posIn(split.doc, LOCKED_SECOND), 'n')],
      });
      await acked(grantee.wire, grantee.ch, {
        base: split.seq,
        steps: [insertText(posIn(split.doc, IDS.lockedPara), 'k')],
      });
      equal(outside.code, 'permission_denied', 'the new part holds no grant');
      includes(outside.scopes, `region:${FRESH_LOCKED}`, 'the rejection names the new region');
      excludes(outside.scopes, LOCKED_SCOPE, 'and not the region that kept its grants');
    },
  }),
];
