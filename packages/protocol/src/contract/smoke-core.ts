/**
 * A smoke suite for the `core` profile (SPK-019; 05 §11): end-to-end scenarios through the ports,
 * so that it runs against any backend — `backend-mock` today, `backend-dep` against the reference
 * service (BE-001) and any other server later. It complements the per-member contract cases.
 */
import { canonicalNodeText, type JsonNode } from '@docedit/model';
import { isSyncReject } from '../ports/errors.ts';
import type { Ack } from '../ports/types.ts';
import { check, codeOf, equal, excludes, includes, jsonEqual, oneOf, rejects } from './assert.ts';
import { type ContractCase, waitUntil } from './core.ts';
import {
  IDS,
  LOCKED_SCOPE,
  USERS,
  importedDocument,
  insertText,
  posIn,
  textOf,
} from './fixtures.ts';
import type { CaseContext, ContractHarness, ContractOptions, HarnessFactory } from './harness.ts';
import { Recorder } from './recorder.ts';
import {
  connect,
  createDoc,
  join,
  newId,
  openWith,
  resumeAfter,
  resumeFrom,
  submit,
  withHarness,
} from './support.ts';

export function coreSmoke(factory: HarnessFactory, opts: ContractOptions): ContractCase[] {
  const c = (
    id: string,
    title: string,
    body: (h: ContractHarness, ctx: CaseContext) => Promise<void>,
  ): ContractCase => ({
    id,
    title,
    port: 'core profile',
    members: [],
    run: (ctx) => withHarness(factory, (h) => body(h, ctx)),
  });

  return [
    c(
      'core.conversation',
      'the conversation of 05 §5.9: stream catch-up, submit, grant change, rejection',
      async (h) => {
        const docId = await createDoc(h);
        const owner = await join(h, opts, docId, 'owner');
        const end = posIn(owner.content.doc, IDS.end);
        const acks: Ack[] = [];
        for (const t of ['a', 'b', 'c'])
          acks.push(await submit(owner, [insertText(end + acks.length, t)]));
        const [s1, , s3] = acks.map((a) => a.seq) as [number, number, number];

        // The client fetched content at s1 and opens the channel with resume at s1.
        const g = await connect(h, USERS.grantee, { [docId]: 'editor' });
        const pinned = await g.sync.loadContent(docId, s1);
        // With the content's view token (G101; D70), so that a server with projections streams.
        const ch = await g.sync.open(docId, { resume: resumeFrom(pinned) });
        equal(ch.opened.catchUp, 'stream', 'ch.opened catchUp');
        equal(ch.opened.head, s3, 'ch.opened head');
        includes(
          ch.opened.access.scopes[LOCKED_SCOPE],
          'edit',
          'the grant opens the restricted region',
        );
        const rec = new Recorder(ch, opts);
        await rec.untilState('live');
        jsonEqual(
          rec.commits.map((x) => x.seq),
          [s1 + 1, s3],
          'the stream',
        );

        const mine = await ch.submit({
          id: newId(),
          base: s3,
          steps: [insertText(posIn(pinned.doc, IDS.lockedPara), 'G')],
          origin: 'input',
        });
        rec.ack(mine);
        equal(mine.seq, s3 + 1, 'sync.ack seq');
        equal(mine.rebased, false, 'sync.ack rebased');

        await h.setGrants(docId, []);
        await rec.until(() => rec.accesses.length >= 2, 'perm.changed');
        const control = rec.commits.find((x) => x.kind === 'control')!;
        equal(control.seq, mine.seq + 1, 'the control commit');
        const access = rec.accesses.at(-1)!;
        equal(access.asOfSeq, control.seq, 'perm.changed asOfSeq');
        excludes(access.scopes[LOCKED_SCOPE], 'edit', 'the grant is gone');

        const e = await rejects(
          ch.submit({
            id: newId(),
            base: mine.seq,
            steps: [insertText(posIn(pinned.doc, IDS.lockedPara), 'H')],
          }),
          'a commit under the old rights',
        );
        check(isSyncReject(e), 'sync.reject');
        equal(e.code, 'permission_denied', 'code');
        equal(e.action, 'drop', 'action');
        equal(e.head, control.seq, 'head');
        jsonEqual(e.scopes, [LOCKED_SCOPE], 'scopes');
        await Promise.all([owner.backend.close(), g.close()]);
      },
    ),

    c(
      'core.convergence',
      'concurrent writers see one gap-free order and the same content',
      async (h) => {
        const docId = await createDoc(h);
        const members = await Promise.all(
          (['owner', 'editor', 'grantee'] as const).map((w) => join(h, opts, docId, w)),
        );
        const at = posIn(members[0]!.content.doc, IDS.end);
        const start = members[0]!.content.seq;
        const rounds = 5;
        await Promise.all(
          members.map(async (m, k) => {
            for (let i = 0; i < rounds; i++) await submit(m, [insertText(at, `${'oeg'[k]}${i}`)]);
          }),
        );
        const head = start + rounds * members.length;
        for (const m of members) await m.rec.until(() => m.seq() >= head, `seq ${head}`);
        const ids = new Map<number, string>();
        for (const m of members) {
          const seen = new Map<number, string>();
          for (const d of m.rec.log) {
            if (d.kind === 'commits') for (const x of d.value) seen.set(x.seq, x.id);
            if (d.kind === 'ack') seen.set(d.value.seq, d.value.id);
          }
          const seqs = [...seen.keys()].sort((a, b) => a - b);
          jsonEqual(
            seqs,
            Array.from({ length: head - start }, (_, i) => start + 1 + i),
            'every seq once, without gaps (04 G5)',
          );
          for (const [s, id] of seen) {
            const known = ids.get(s);
            if (known === undefined) ids.set(s, id);
            else equal(id, known, `one commit at seq ${s} (04 G1)`);
          }
        }
        const contents = await Promise.all(members.map((m) => m.backend.sync.loadContent(docId)));
        for (const x of contents)
          equal(
            canonicalNodeText(x.doc as unknown as JsonNode),
            canonicalNodeText(contents[0]!.doc as unknown as JsonNode),
            'the same content (04 G3)',
          );
        const text = textOf(contents[0]!.doc, IDS.end);
        for (const k of 'oeg')
          for (let i = 0; i < rounds; i++)
            check(text.includes(`${k}${i}`), `${k}${i} is in the document`);
        await Promise.all(members.map((m) => m.backend.close()));
      },
    ),

    c(
      'core.reconnect',
      'an in-flight commit survives a reconnect: accepted, or unknown and resubmitted once',
      async (h, ctx) => {
        const docId = await createDoc(h);
        const m = await join(h, opts, docId, 'editor');
        const before = m.seq();
        const x = await submit(m, [insertText(posIn(m.content.doc, IDS.intro), 'X')]);
        m.channel.close();
        const r1 = await openWith(m.backend, docId, opts, resumeAfter(m.channel, before, x.id));
        jsonEqual(
          r1.channel.opened.inflight,
          { state: 'accepted', seq: x.seq },
          'accepted (04 §9 step 2)',
        );
        await r1.rec.untilSeq(x.seq);
        await r1.rec.untilState('live');
        if (!h.holdWrites) return ctx.skip('the unknown path needs the write-hold test hook');

        const hold = h.holdWrites(docId);
        const y = {
          id: newId(),
          base: x.seq,
          steps: [insertText(posIn(r1.content.doc, IDS.end), 'Y')],
        };
        const lost = r1.channel.submit(y);
        r1.channel.close();
        equal(
          codeOf(await rejects(lost, 'the submit cut off by the close')),
          'unavailable',
          'code (D23)',
        );
        const r2 = await openWith(m.backend, docId, opts, resumeAfter(r1.channel, x.seq, y.id));
        jsonEqual(r2.channel.opened.inflight, { state: 'unknown' }, 'not stored yet');
        await r2.rec.untilState('live');
        const again = r2.channel.submit(y);
        await hold.release();
        const ack = await again;
        equal(ack.id, y.id, 'resubmitted with the same id (04 §9 step 5)');
        const content = await m.backend.sync.loadContent(docId);
        equal(textOf(content.doc, IDS.end).split('Y').length - 1, 1, 'stored exactly once (04 G4)');
        await m.backend.close();
      },
    ),

    c(
      'core.reset',
      'a snapshot commit: reset, pinned reload, old bases rejected for a rebase, late joiners reload',
      async (h) => {
        const docId = await createDoc(h);
        const m = await join(h, opts, docId, 'editor');
        const old = await submit(m, [insertText(posIn(m.content.doc, IDS.intro), 'x')]);
        await h.replaceContent(docId, importedDocument());
        await m.rec.until(() => m.rec.resets.length > 0, 'sync.reset');
        const reset = m.rec.resets[0]!;
        const content = await m.backend.sync.loadContent(docId, reset.seq);
        equal(textOf(content.doc, IDS.intro), 'Imported text', 'the snapshot content');
        const late = await connect(h, USERS.viewer, { [docId]: 'viewer' });
        const ch = await late.sync.open(docId, {
          resume: { seq: old.seq, incarnation: content.incarnation },
        });
        equal(ch.opened.catchUp, 'reload', 'a resume before the snapshot cannot stream (04 §3.2)');
        const e = await rejects(
          m.channel.submit({
            id: newId(),
            base: old.seq,
            steps: [insertText(posIn(content.doc, IDS.intro), 'y')],
          }),
          'a base before the snapshot',
        );
        check(isSyncReject(e), 'sync.reject');
        equal(e.code, 'stale_base', 'code (04 §3.2)');
        equal(e.action, 'rebase', 'action (04 §3.2)');
        // The client re-applies its steps to the snapshot content and resubmits them.
        const ack = await submit(m, [insertText(posIn(content.doc, IDS.intro), 'z')], reset.seq);
        equal(ack.seq, reset.seq + 1, 'commits continue');
        await Promise.all([m.backend.close(), late.close()]);
      },
    ),

    c(
      'core.revocation',
      'a revocation closes every session of the user; tokens issued afterwards work and grants survive',
      async (h) => {
        const docId = await createDoc(h);
        const m = await join(h, opts, docId, 'grantee');
        const second = await join(h, opts, docId, 'grantee');
        const other = await join(h, opts, docId, 'editor');
        await h.revokeSessions(USERS.grantee.sub);
        for (const s of [m, second])
          await s.rec.until(
            () => s.rec.states.some((x) => x.status === 'closed'),
            'a session of the user closed',
          );
        const closed = m.rec.states.find((s) => s.status === 'closed');
        check(closed?.status === 'closed', 'closed');
        oneOf(closed.code, ['forbidden', 'revoked'], 'close code');
        check(
          !other.rec.states.some((s) => s.status === 'closed'),
          "another user's session stays open",
        );
        const fresh = await connect(h, USERS.grantee, { [docId]: 'editor' });
        const n = await join(h, opts, docId, 'grantee', fresh);
        await waitUntil(
          opts,
          () => n.rec.states.some((s) => s.status === 'live'),
          'a new token works after the watermark',
        );
        includes(
          n.channel.opened.access.scopes[LOCKED_SCOPE],
          'edit',
          'region grants survive a revocation: they are not in the token (05 §3.1)',
        );
        await Promise.all([fresh.close(), other.backend.close()]);
      },
    ),
  ];
}
