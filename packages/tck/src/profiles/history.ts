/**
 * The `history` profile (PRO-119; 05 §6.2, §11; 08). It checks the named versions, the comparison
 * and the attribution against a series of commits of two users, the history gate at the routes
 * that take a `seq`, a dry run and a region restore, and the read marker of a user, which only
 * moves forward (HIS-027 criterion 2). `GET /documents/{id}/history` is not served by the
 * reference service yet, so it has no scenario (see the Notes of PRO-119).
 */
import { check, equal, includes, isObject, jsonEqual, oneOf } from '../assert.ts';
import type { ScenarioContext } from '../context.ts';
import { IDS, insertText, nodeById, posIn, textOf } from '../documents.ts';
import { expectStatus, problemCode, type HttpResponse } from '../rest.ts';
import { scenario, type ProfileDef, type ScenarioDef } from '../scenario.ts';
import { acked, join, knownSeq, readContent, untilSeq } from './support.ts';

const hs = (def: Omit<ScenarioDef, 'id'> & { id: string }) => scenario('history', def);

/** What the comparison and the attribution say, as the kit reads them. */
interface DiffBody {
  fromSeq: number;
  toSeq: number;
  method: string;
  changes: Array<{
    kind: string;
    blockId?: string;
    spans?: Array<{ op: string; text: string; user?: string; seq?: number }>;
  }>;
}
interface AttributionBody {
  seq: number;
  spans: Array<{
    blockId: string;
    from: number;
    to: number;
    user: string;
    seq: number;
    /** Content written below the reader's gate: an unknown person (owner decision 37). */
    unknown?: boolean;
  }>;
}

/**
 * Three commits by two editors: the author inserts `One ` at the start of the intro, the second
 * editor inserts `Two ` at the start of the open region, the author inserts `Three ` at the start
 * of the intro. The head is then at `s3`, and the three seqs are returned.
 */
async function series(ctx: ScenarioContext) {
  const doc = await ctx.document();
  const author = await join(ctx, 'author', doc, 'editor');
  const second = await join(ctx, 'second', doc, 'editor');
  const intro = posIn(author.content.doc, IDS.intro, 0);
  const open = posIn(author.content.doc, IDS.openPara, 0);
  const s1 = (
    await acked(author.wire, author.ch, {
      base: knownSeq(author),
      steps: [insertText(intro, 'One ')],
    })
  ).seq;
  await untilSeq(second.wire, second.ch, s1);
  const s2 = (
    await acked(second.wire, second.ch, {
      base: knownSeq(second),
      steps: [insertText(open + 'One '.length, 'Two ')],
    })
  ).seq;
  await untilSeq(author.wire, author.ch, s2);
  const s3 = (
    await acked(author.wire, author.ch, {
      base: knownSeq(author),
      steps: [insertText(intro, 'Three ')],
    })
  ).seq;
  await untilSeq(second.wire, second.ch, s3);
  return { doc, author, second, s1, s2, s3 };
}

type Series = Awaited<ReturnType<typeof series>>;

const get = (ctx: ScenarioContext, token: string, path: string, query?: Record<string, number>) =>
  ctx.service.as(token, 'GET', path, query ? { query } : {});

/** The text of the inserted spans of a block in a comparison, in the order of the spans. */
function inserted(diff: DiffBody, block: string) {
  const change = diff.changes.find((c) => c.blockId === block);
  return (change?.spans ?? []).filter((s) => s.op === 'insert');
}

async function closeAll(s: Series): Promise<void> {
  await s.author.wire.close();
  await s.second.wire.close();
}

export const HISTORY: ProfileDef = {
  id: 'history',
  title: 'History, versions, comparison, attribution, restore and read markers',
  spec: '08; 05 §6.2',
  stories: ['PRO-119'],
  requires: { kind: 'features', features: ['history'] },
  scenarios: [
    hs({
      id: 'reads.versions-diff-attribution',
      title: 'named versions, the comparison and the attribution agree with the commits',
      spec: '08 §4, §6, §7; 05 §6.2',
      covers: {
        operations: [
          'GET /documents/{id}/versions',
          'POST /documents/{id}/versions',
          'GET /documents/{id}/diff',
          'GET /documents/{id}/attribution',
        ],
        events: ['version.created'],
      },
      async run(ctx) {
        const s = await series(ctx);
        const { doc, author, second } = s;
        const heard = author.wire.mark();
        // Named versions: created at a seq, listed once, and a repeat is the same version.
        const made = await ctx.service.as(author.token, 'POST', `/documents/${doc}/versions`, {
          body: { seq: s.s2, name: 'Draft', note: 'kit' },
        });
        expectStatus(made, 201, 'a named version at the second commit');
        const created = await author.wire.next(
          (m) => m.t === 'event' && m.d.type === 'version.created',
          'event version.created',
          { from: heard },
        );
        if (created.t === 'event')
          equal(
            created.d.resource,
            `/documents/${doc}/versions`,
            'the resource of version.created',
          );
        jsonEqual(
          made.json,
          { seq: s.s2, kind: 'named', name: 'Draft', note: 'kit' },
          'the version created',
        );
        const again = await ctx.service.as(author.token, 'POST', `/documents/${doc}/versions`, {
          body: { seq: s.s2, name: 'Draft', note: 'kit' },
        });
        expectStatus(again, 200, 'the same version again');
        const list = await get(ctx, author.token, `/documents/${doc}/versions`);
        expectStatus(list, 200, 'the named versions');
        const items = (list.json as { items: Array<{ seq: number; name?: string }> }).items;
        jsonEqual(
          items.map((v) => [v.seq, v.name]),
          [[s.s2, 'Draft']],
          'the list holds the one named version',
        );
        const missing = await ctx.service.as(author.token, 'POST', `/documents/${doc}/versions`, {
          body: { seq: s.s3 + 1, name: 'Ahead' },
        });
        // 08 does not say which problem a seq above the head is; both are a refusal of a bad seq.
        oneOf(
          problemCode(missing),
          ['not_found', 'validation_failed'],
          'a version above the head is refused',
        );

        // The comparison from the start to the head names both blocks, their text and their authors.
        const diff = get(ctx, author.token, `/documents/${doc}/diff`, { fromSeq: 0, toSeq: s.s3 });
        const whole = expectStatus(await diff, 200, 'the comparison from 0 to the head')
          .json as DiffBody;
        equal(whole.fromSeq, 0, 'fromSeq is echoed');
        equal(whole.toSeq, s.s3, 'toSeq is echoed');
        jsonEqual(
          whole.changes.map((c) => c.blockId).sort(),
          [IDS.intro, IDS.openPara].sort(),
          'the blocks that changed',
        );
        const intro = inserted(whole, IDS.intro);
        equal(intro.map((x) => x.text).join(''), 'Three One ', 'the text inserted in the intro');
        for (const x of intro) {
          equal(x.user, author.sub, 'the author of the text in the intro');
          includes([s.s1, s.s3], x.seq as number, 'the commit of the text in the intro');
        }
        const open = inserted(whole, IDS.openPara);
        equal(open.map((x) => x.text).join(''), 'Two ', 'the text inserted in the open region');
        for (const x of open) {
          equal(x.user, second.sub, 'the author of the text in the open region');
          equal(x.seq, s.s2, 'the commit of the text in the open region');
        }
        // From the first to the second commit only the open region changed; from a version to itself nothing.
        const mid = expectStatus(
          await get(ctx, author.token, `/documents/${doc}/diff`, { fromSeq: s.s1, toSeq: s.s2 }),
          200,
          'the comparison between the first and second commit',
        ).json as DiffBody;
        jsonEqual(
          mid.changes.map((c) => c.blockId),
          [IDS.openPara],
          'only the second commit changed a block',
        );
        const same = expectStatus(
          await get(ctx, author.token, `/documents/${doc}/diff`, { fromSeq: s.s3, toSeq: s.s3 }),
          200,
          'the comparison of a version with itself',
        ).json as DiffBody;
        equal(same.changes.length, 0, 'nothing differs between a version and itself');
        const backwards = await get(ctx, author.token, `/documents/${doc}/diff`, {
          fromSeq: s.s3,
          toSeq: s.s1,
        });
        equal(problemCode(backwards), 'validation_failed', 'fromSeq above toSeq is refused');

        // The attribution at the head and at the first commit.
        const at = async (atSeq?: number) =>
          expectStatus(
            await get(
              ctx,
              author.token,
              `/documents/${doc}/attribution`,
              atSeq === undefined ? undefined : { atSeq },
            ),
            200,
            'the attribution',
          ).json as AttributionBody;
        const head = await at();
        equal(head.seq, s.s3, 'the attribution is read at the head by default');
        const spanAt = (b: AttributionBody, block: string, offset: number) =>
          b.spans.find((x) => x.blockId === block && x.from <= offset && offset < x.to);
        equal(spanAt(head, IDS.intro, 0)?.user, author.sub, 'who wrote Three');
        equal(spanAt(head, IDS.intro, 0)?.seq, s.s3, 'the commit of Three');
        equal(spanAt(head, IDS.intro, 7)?.seq, s.s1, 'the commit of One');
        equal(spanAt(head, IDS.intro, 12)?.seq, 0, 'the original text is from before the commits');
        equal(spanAt(head, IDS.openPara, 0)?.user, second.sub, 'who wrote Two');
        equal(spanAt(head, IDS.openPara, 0)?.seq, s.s2, 'the commit of Two');
        const early = await at(s.s1);
        equal(early.seq, s.s1, 'the attribution at the first commit');
        equal(spanAt(early, IDS.intro, 0)?.seq, s.s1, 'One is the first text at that commit');
        equal(spanAt(early, IDS.openPara, 0)?.seq, 0, 'Two does not exist at that commit');
        await closeAll(s);
      },
    }),
    hs({
      id: 'gate.every-route-with-a-seq',
      title: 'a seq below the gate is refused at the routes that take one',
      spec: '07 §8, §12; 08 §9; PRM-041',
      covers: {
        operations: [
          'GET /documents/{id}/content',
          'GET /documents/{id}/commits',
          'GET /documents/{id}/diff',
          'GET /documents/{id}/attribution',
          'POST /documents/{id}/fork',
        ],
        errors: ['forbidden'],
      },
      async run(ctx) {
        const s = await series(ctx);
        const { doc } = s;
        // Under the default setting an editor reads all of the history and a viewer only the head.
        const { token: viewer } = await ctx.token('viewer', { [doc]: 'viewer' });
        const refused = (res: HttpResponse, what: string) => {
          equal(problemCode(res), 'forbidden', `${what} is refused below the gate`);
          equal(res.status, 403, `${what}: the status`);
        };
        const base = `/documents/${doc}`;
        refused(await get(ctx, viewer, `${base}/content`, { seq: s.s1 }), 'content at a seq');
        refused(await get(ctx, viewer, `${base}/commits`, { after: 0 }), 'commits after a seq');
        refused(
          await get(ctx, viewer, `${base}/diff`, { fromSeq: s.s1, toSeq: s.s3 }),
          'a comparison from below the gate',
        );
        refused(
          await get(ctx, viewer, `${base}/diff`, { fromSeq: 0, toSeq: s.s2 }),
          'a comparison to below the gate',
        );
        refused(
          await get(ctx, viewer, `${base}/attribution`, { atSeq: s.s1 }),
          'the attribution at a seq',
        );
        refused(
          await ctx.service.as(viewer, 'POST', `${base}/fork`, { body: { atSeq: s.s1 } }),
          'a fork at a seq',
        );
        if (ctx.has('exports'))
          refused(
            await ctx.service.as(viewer, 'POST', `${base}/exports`, {
              body: { target: 'pdf', seq: s.s1 },
            }),
            'an export at a seq',
          );
        // The same user at the head is served, and an editor is served below it.
        expectStatus(
          await get(ctx, viewer, `${base}/content`, { seq: s.s3 }),
          200,
          'content at the head',
        );
        expectStatus(
          await get(ctx, viewer, `${base}/diff`, { fromSeq: s.s3, toSeq: s.s3 }),
          200,
          'a comparison at the head',
        );
        expectStatus(
          await get(ctx, viewer, `${base}/attribution`, { atSeq: s.s3 }),
          200,
          'the attribution at the head',
        );
        expectStatus(
          await get(ctx, s.author.token, `${base}/content`, { seq: s.s1 }),
          200,
          'an editor reads content below the head',
        );
        expectStatus(
          await get(ctx, s.author.token, `${base}/diff`, { fromSeq: s.s1, toSeq: s.s3 }),
          200,
          'an editor reads a comparison below the head',
        );
        await closeAll(s);
      },
    }),
    hs({
      id: 'gate.history-list-and-versions',
      title: 'the history list and named-version creation refuse a seq below the gate',
      spec: '07 §8, §12; 08 §4, §9; HIS-026',
      covers: {
        operations: ['GET /documents/{id}/history', 'POST /documents/{id}/versions'],
        errors: ['forbidden'],
      },
      async run(ctx) {
        const s = await series(ctx);
        const { doc } = s;
        const { token: viewer } = await ctx.token('viewer', { [doc]: 'viewer' });
        const base = `/documents/${doc}`;
        const refused = (res: HttpResponse, what: string) => {
          equal(problemCode(res), 'forbidden', `${what} is refused below the gate`);
          equal(res.status, 403, `${what}: the status`);
        };
        // A viewer reads the head only: a list that starts below it, or ends below it, is refused.
        refused(await get(ctx, viewer, `${base}/history`, { fromSeq: s.s1 }), 'a list from a seq');
        refused(await get(ctx, viewer, `${base}/history`, { toSeq: s.s2 }), 'a list to a seq');
        // Control: a list that starts at the head, and one without bounds, are served.
        expectStatus(
          await get(ctx, viewer, `${base}/history`, { fromSeq: s.s3 + 1 }),
          200,
          'a list from the head',
        );
        expectStatus(await get(ctx, viewer, `${base}/history`), 200, 'the list without bounds');
        // An editor holds `edit` and reads all of it.
        expectStatus(
          await get(ctx, s.author.token, `${base}/history`, { fromSeq: s.s1 }),
          200,
          'an editor reads the list from the first commit',
        );
        // A version is created at a visible state only: a user below the gate may not name one.
        // (A viewer has no `edit` either; the refusal is `forbidden` for both reasons, so the
        // control is an editor at the first commit.)
        expectStatus(
          await ctx.service.as(s.author.token, 'POST', `${base}/versions`, {
            body: { seq: s.s1, name: 'first' },
          }),
          201,
          'an editor names the first commit',
        );
        await closeAll(s);
      },
    }),
    hs({
      id: 'gate.settings-matrix',
      title:
        'under each setting (editors, all, since_access) the gate decides the reads, and content below it is an unknown person',
      spec: '07 §8, §12; 08 §7, §9; ADR 0034; HIS-025; HIS-026; owner decision 37',
      covers: {
        operations: [
          'GET /documents/{id}/content',
          'GET /documents/{id}/commits',
          'GET /documents/{id}/diff',
          'GET /documents/{id}/attribution',
          'GET /documents/{id}/history-visibility',
          'PUT /documents/{id}/history-visibility',
        ],
        errors: ['forbidden'],
      },
      async run(ctx) {
        const s = await series(ctx);
        const { doc } = s;
        const base = `/documents/${doc}`;
        const setSetting = async (setting: string) => {
          const current = expectStatus(
            await ctx.service.call('GET', `${base}/history-visibility`),
            200,
            'reading the history setting',
          );
          expectStatus(
            await ctx.service.call('PUT', `${base}/history-visibility`, {
              body: { setting },
              headers: { 'if-match': current.headers.get('etag') ?? '*' },
            }),
            200,
            `setting the history visibility to ${setting}`,
          );
        };
        // The time of each commit, from the commits an editor reads (the editor sees all of them
        // under the default setting, which holds before the first change).
        const list = expectStatus(
          await get(ctx, s.author.token, `${base}/commits`, { after: 0 }),
          200,
          'the commits, read by an editor',
        ).json as { items: Array<{ seq: number; serverTime: string }> };
        const timeOf = new Map(list.items.map((c) => [c.seq, Date.parse(c.serverTime)]));
        for (const q of [s.s1, s.s2, s.s3])
          check(timeOf.has(q), `the time of commit ${q} is known`, 'a time', timeOf.get(q));
        const claim = new Date(timeOf.get(s.s2)!).toISOString();
        // The gate is the last commit stored at or before the claim (ADR 0034, accepted).
        const sinceGate = [s.s1, s.s2, s.s3]
          .filter((q) => timeOf.get(q)! <= Date.parse(claim))
          .reduce((a, b) => Math.max(a, b), 0);

        const refused = (res: HttpResponse, what: string) => {
          equal(problemCode(res), 'forbidden', `${what} is refused below the gate`);
          equal(res.status, 403, `${what}: the status`);
        };
        /** Reads at every seq: refused below the gate, served at or above it, and at the head. */
        const readsAgainst = async (who: string, token: string, gate: number) => {
          for (const q of [0, s.s1, s.s2, s.s3]) {
            const visible = q >= gate || q === s.s3;
            const res = await get(ctx, token, `${base}/content`, { seq: q });
            if (visible) expectStatus(res, 200, `${who}: content at ${q}`);
            else refused(res, `${who}: content at ${q}`);
            const att = await get(ctx, token, `${base}/attribution`, { atSeq: q });
            if (visible) expectStatus(att, 200, `${who}: the attribution at ${q}`);
            else refused(att, `${who}: the attribution at ${q}`);
            const run = await get(ctx, token, `${base}/commits`, { after: q });
            if (q >= gate) expectStatus(run, 200, `${who}: the commits after ${q}`);
            else refused(run, `${who}: the commits after ${q}`);
          }
          // A comparison that starts below the gate is refused whole; from the gate it is served.
          if (gate > 0)
            refused(
              await get(ctx, token, `${base}/diff`, { fromSeq: gate - 1, toSeq: s.s3 }),
              `${who}: a comparison that straddles the gate`,
            );
          expectStatus(
            await get(ctx, token, `${base}/diff`, { fromSeq: Math.min(gate, s.s3), toSeq: s.s3 }),
            200,
            `${who}: a comparison from the gate`,
          );
          // Attribution at the head: nothing from below the gate is named (decision 37).
          const head = expectStatus(
            await get(ctx, token, `${base}/attribution`, { atSeq: s.s3 }),
            200,
            `${who}: the attribution at the head`,
          ).json as AttributionBody;
          const named = head.spans.filter((x) => !x.unknown);
          for (const x of named)
            check(x.seq >= gate, `${who}: a named span is at or above the gate`, `>= ${gate}`, x);
          if (gate > 0) {
            check(
              head.spans.some((x) => x.seq < gate || x.unknown),
              `${who}: content below the gate is still covered, as an unknown person`,
              'a span',
              head.spans,
            );
            const below = head.spans.filter((x) => x.seq < gate && !x.unknown);
            equal(below.length, 0, `${who}: no span names a commit below the gate`);
          }
        };

        // `editors` (the default): a viewer reads the head only, an editor everything.
        const { token: viewer } = await ctx.token('viewer-matrix', { [doc]: 'viewer' });
        await setSetting('editors');
        await readsAgainst('a viewer under editors', viewer, s.s3);
        await readsAgainst('an editor under editors', s.author.token, 0);
        // `all`: everyone with view reads everything.
        await setSetting('all');
        await readsAgainst('a viewer under all', viewer, 0);
        // `since_access`: the claim decides, and without it the gate is the head.
        await setSetting('since_access');
        const { token: claimed } = await ctx.token(
          'viewer-claim',
          { [doc]: 'viewer' },
          { access_since: claim },
        );
        await readsAgainst('a viewer with access_since', claimed, sinceGate);
        await readsAgainst('a viewer without access_since', viewer, s.s3);
        await closeAll(s);
      },
    }),
    hs({
      id: 'matrix.refusals',
      title:
        'rows 2, 8, 9 and 10: a caller without view, without edit or without manage is refused at the history routes',
      spec: '07 §12 rows 2, 8, 9, 10; PRM-058',
      covers: {
        operations: [
          'GET /documents/{id}/content',
          'GET /documents/{id}/history',
          'GET /documents/{id}/diff',
          'GET /documents/{id}/attribution',
          'POST /documents/{id}/versions',
          'POST /documents/{id}/restore',
        ],
        errors: ['forbidden'],
      },
      async run(ctx) {
        const s = await series(ctx);
        const { doc } = s;
        const other = await ctx.document();
        const base = `/documents/${doc}`;
        const refused = (res: HttpResponse, what: string) => {
          equal(problemCode(res), 'forbidden', `${what} is refused`);
          equal(res.status, 403, `${what}: the status`);
        };

        // Row 2: `view` is required before the gate is looked at. A user with a role on another
        // document only is refused at every route that reads at a seq, even at the head.
        const { token: outsider } = await ctx.token('outsider', { [other]: 'owner' });
        refused(
          await get(ctx, outsider, `${base}/content`, { seq: s.s3 }),
          'content by an outsider',
        );
        refused(await get(ctx, outsider, `${base}/history`), 'the history by an outsider');
        refused(
          await get(ctx, outsider, `${base}/diff`, { fromSeq: s.s3, toSeq: s.s3 }),
          'a comparison by an outsider',
        );
        refused(
          await get(ctx, outsider, `${base}/attribution`, { atSeq: s.s3 }),
          'the attribution by an outsider',
        );
        // The same routes serve a user with `view` and a gate that lets the seq through.
        expectStatus(
          await get(ctx, s.author.token, `${base}/content`, { seq: s.s1 }),
          200,
          'an editor reads content at a seq',
        );

        // Row 8: naming a version needs `edit` somewhere. The seq is the head, so the gate is not
        // the reason for the refusal.
        const { token: viewer } = await ctx.token('viewer', { [doc]: 'viewer' });
        const { token: commenter } = await ctx.token('commenter', { [doc]: 'commenter' });
        for (const [who, token] of [
          ['a viewer', viewer],
          ['a commenter', commenter],
        ] as const)
          refused(
            await ctx.service.as(token, 'POST', `${base}/versions`, {
              body: { seq: s.s3, name: 'not mine' },
            }),
            `a version named by ${who}`,
          );
        expectStatus(
          await ctx.service.as(s.author.token, 'POST', `${base}/versions`, {
            body: { seq: s.s3, name: 'mine' },
          }),
          201,
          'an editor names a version at the head',
        );

        // Row 10: restoring the whole document needs `manage`. The editor is refused and the
        // head does not move; the owner's dry run is the control.
        const { token: manager } = await ctx.token('manager', { [doc]: 'owner' });
        refused(
          await ctx.service.as(s.author.token, 'POST', `${base}/restore`, {
            body: { toSeq: s.s1 },
          }),
          'a restore by an editor',
        );
        expectStatus(
          await ctx.service.as(manager, 'POST', `${base}/restore`, {
            body: { toSeq: s.s1, dryRun: true },
          }),
          200,
          'a dry run of a restore by an owner',
        );
        equal(
          (await readContent(ctx, manager, doc)).seq,
          s.s3,
          'the head did not move after the refusals',
        );

        // Row 9: restoring a region needs `edit` in it. (A region that is approved or leased to
        // someone else is refused too; that needs a state change first and is tested at the
        // authority, `leases-states.test.ts`.)
        if (ctx.has('regions')) {
          for (const [who, token] of [
            ['a viewer', viewer],
            ['a commenter', commenter],
          ] as const)
            refused(
              await ctx.service.as(token, 'POST', `${base}/restore`, {
                body: { toSeq: s.s1, region: IDS.open },
              }),
              `a region restore by ${who}`,
            );
          expectStatus(
            await ctx.service.as(manager, 'POST', `${base}/restore`, {
              body: { toSeq: s.s1, region: IDS.open, dryRun: true },
            }),
            200,
            'a dry run of a region restore by an owner',
          );
        }
        await closeAll(s);
      },
    }),
    hs({
      id: 'restore.dry-run',
      title: 'a restore with dryRun stores nothing',
      spec: '08 §8; 05 §6.2; HIS-021',
      covers: { operations: ['POST /documents/{id}/restore'] },
      async run(ctx) {
        const s = await series(ctx);
        const { doc } = s;
        const { token: manager } = await ctx.token('manager', { [doc]: 'owner' });
        const before = await readContent(ctx, manager, doc);
        const from = s.author.wire.mark();
        const res = await ctx.service.as(manager, 'POST', `/documents/${doc}/restore`, {
          body: { toSeq: s.s1, dryRun: true },
        });
        expectStatus(res, 200, 'a dry run of a restore');
        const plan = res.json as Record<string, unknown>;
        equal(plan['dryRun'], true, 'the answer says it is a dry run');
        equal(plan['toSeq'], s.s1, 'the seq asked for');
        check(isObject(plan['comparison']), 'the answer holds the comparison', 'an object', plan);
        const changes = (plan['comparison'] as { changes: unknown[] }).changes;
        check(changes.length > 0, 'the restore would change something', '> 0', changes.length);
        const after = await readContent(ctx, manager, doc);
        equal(after.seq, before.seq, 'the head did not move');
        jsonEqual(after.doc, before.doc, 'the content did not change');
        const commits = await get(ctx, manager, `/documents/${doc}/commits`, { after: s.s3 });
        expectStatus(commits, 200, 'the commits after the head');
        equal(
          (commits.json as { items: unknown[] }).items.length,
          0,
          'no commit was stored by the dry run',
        );
        const versions = await get(ctx, manager, `/documents/${doc}/versions`);
        equal(
          (versions.json as { items: unknown[] }).items.length,
          0,
          'no version was recorded by the dry run',
        );
        await ctx.sleep(300);
        const heard = s.author.wire.messages
          .slice(from)
          .filter(
            (m) => m.t === 'sync.reset' || (m.t === 'event' && m.d.type.startsWith('version.')),
          );
        equal(heard.length, 0, 'the channels heard nothing of the dry run');
        await closeAll(s);
      },
    }),
    hs({
      id: 'restore.region',
      title:
        'a restore of a region keeps the other blocks and their comments, and does not restore grants',
      spec: '08 §8; 07 §13; 05 §6.2; HIS-018',
      needs: { features: ['regions'] },
      covers: {
        operations: ['POST /documents/{id}/restore', 'GET /documents/{id}/grants'],
        events: ['version.restored'],
      },
      async run(ctx) {
        const s = await series(ctx);
        const { doc } = s;
        const { token: manager } = await ctx.token('manager', { [doc]: 'owner' });
        const { token: commenter } = await ctx.token('commenter', { [doc]: 'commenter' });
        // A comment on the intro, which the restore of the open region does not touch.
        const thread = await ctx.service.as(commenter, 'POST', `/documents/${doc}/threads`, {
          body: { target: { block: IDS.intro }, comment: { body: 'kit' } },
        });
        expectStatus(thread, 201, 'a thread on the intro');
        const tid = (thread.json as { id: string }).id;
        // Grants that were not in force at the seq restored to.
        const grant = {
          region: IDS.open,
          principal: `user:${ctx.sub('later')}`,
          role: 'editor',
        } as const;
        await ctx.service.setGrants(doc, [grant]);
        const grantsBefore = await ctx.service.call('GET', `/documents/${doc}/grants`);
        expectStatus(grantsBefore, 200, 'the grants before the restore');

        const from = s.author.wire.mark();
        const res = await ctx.service.as(manager, 'POST', `/documents/${doc}/restore`, {
          body: { toSeq: s.s1, region: IDS.open },
        });
        expectStatus(res, 200, 'a restore of the open region to the first commit');
        await s.author.wire.next(
          (m) => m.t === 'event' && m.d.type === 'version.restored',
          'event version.restored',
          { from },
        );
        const done = res.json as { seq: number; toSeq: number; region?: string };
        check(done.seq > s.s3, 'the restore is a new commit', `> ${s.s3}`, done.seq);
        equal(done.region, IDS.open, 'the region is named in the answer');

        const now = await readContent(ctx, manager, doc);
        equal(now.seq, done.seq, 'the head is the restore');
        equal(textOf(now.doc, IDS.openPara), 'Open region', 'the region is as it was');
        equal(textOf(now.doc, IDS.intro), 'Three One Hello world', 'the intro keeps both commits');
        check(
          nodeById(now.doc, IDS.openPara) !== null,
          'the region still holds its block',
          'a node',
          null,
        );

        const grantsAfter = await ctx.service.call('GET', `/documents/${doc}/grants`);
        jsonEqual(
          (grantsAfter.json as { grants: unknown }).grants,
          (grantsBefore.json as { grants: unknown }).grants,
          'the grants are as they were: a restore does not restore grants',
        );
        const kept = await ctx.service.as(commenter, 'GET', `/threads/${tid}`);
        expectStatus(kept, 200, 'the comment on the intro after the restore');
        await closeAll(s);
      },
    }),
    hs({
      id: 'restore.region-attribution',
      title: 'a restore of a region keeps the attribution of the blocks it does not touch',
      spec: '08 §7, §8; HIS-018',
      needs: { features: ['regions'] },
      covers: { operations: ['POST /documents/{id}/restore', 'GET /documents/{id}/attribution'] },
      async run(ctx) {
        const s = await series(ctx);
        const { doc } = s;
        const { token: manager } = await ctx.token('manager', { [doc]: 'owner' });
        const introOf = async () =>
          (
            expectStatus(
              await get(ctx, manager, `/documents/${doc}/attribution`),
              200,
              'the attribution',
            ).json as AttributionBody
          ).spans.filter((x) => x.blockId === IDS.intro);
        const before = await introOf();
        expectStatus(
          await ctx.service.as(manager, 'POST', `/documents/${doc}/restore`, {
            body: { toSeq: s.s1, region: IDS.open },
          }),
          200,
          'a restore of the open region',
        );
        jsonEqual(await introOf(), before, 'the authors of the intro are as they were');
        await closeAll(s);
      },
    }),
    hs({
      id: 'read-marker.forward-only',
      title: 'a read marker moved backwards stays where it was',
      spec: '08 §10; 05 §6.2; HIS-027 criterion 2',
      covers: { operations: ['PUT /documents/{id}/read-marker'] },
      async run(ctx) {
        const d = await ctx.document();
        const m = await join(ctx, 'reader', d, 'editor');
        const at = await acked(m.wire, m.ch, {
          base: m.content.seq,
          steps: [insertText(posIn(m.content.doc, IDS.intro, 0), 'Read ')],
        });
        const seq = at.seq;
        check(seq > 0, 'the commit is stored at a seq above 0', '> 0', seq);

        const put = (value: number) =>
          ctx.service.as(m.token, 'PUT', `/documents/${d}/read-marker`, {
            body: { seq: value },
          });

        const up = await put(seq);
        expectStatus(up, 200, `moving the read marker to ${seq}`);
        equal((up.json as { seq: number }).seq, seq, 'the marker in force after a forward move');

        const back = await put(0);
        expectStatus(back, 200, 'moving the read marker backwards to 0');
        equal(
          (back.json as { seq: number }).seq,
          seq,
          'a backward move leaves the marker where it was (08 §10)',
        );

        const again = await put(seq);
        expectStatus(again, 200, 'repeating the same marker');
        equal(
          (again.json as { seq: number }).seq,
          seq,
          'an equal move leaves the marker as it was',
        );
        await m.wire.close();
      },
    }),
  ],
};
