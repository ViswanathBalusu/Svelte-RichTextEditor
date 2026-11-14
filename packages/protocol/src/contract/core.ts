/**
 * Contract cases for the core ports (PRO-098 first version, S6): `Backend`, `AuthPort`, `SyncPort`,
 * `SyncChannel`, `PermissionsPort`. Every case names the port members it exercises, so a test can
 * check that each member has at least one case.
 */
import {
  canonicalNodeText,
  documentHash,
  isTimestamp,
  isUuid7,
  type JsonEnvelope,
  type JsonNode,
} from '@docedit/model';
import { isSyncReject } from '../ports/errors.ts';
import { portFeatureMismatches } from '../ports/features.ts';
import type { Access, Limits } from '../ports/types.ts';
import { check, codeOf, equal, excludes, includes, jsonEqual, oneOf, rejects } from './assert.ts';
import {
  IDS,
  LEGAL_GRANT,
  LOCKED_SCOPE,
  USERS,
  contractDocument,
  deleteRange,
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
  quiet,
  resumeFrom,
  submit,
  withHarness,
} from './support.ts';

export interface ContractCase {
  id: string;
  title: string;
  /** `Backend`, `AuthPort`, `SyncPort`, `SyncChannel`, `PermissionsPort` or an optional port name. */
  port: string;
  /** Port members the case exercises, as `Port.member`. */
  members: readonly string[];
  run(ctx: CaseContext): Promise<void>;
}

export const LIMIT_NAMES: ReadonlyArray<keyof Limits> = [
  'maxMessageBytes',
  'maxCommitBytes',
  'maxStepsPerCommit',
  'maxRebaseSteps',
  'maxChannels',
  'heartbeatMs',
  'ackTimeoutMs',
  'presenceHz',
  'presenceBytes',
  'catchUpCommits',
  'catchUpBytes',
];

const canonical = (doc: unknown): string => canonicalNodeText(doc as JsonNode);

/** Waits for a condition outside a channel (port events), failing after the timeout. */
export async function waitUntil(
  opts: ContractOptions,
  pred: () => boolean,
  what: string,
): Promise<void> {
  const deadline = (opts.timeoutMs ?? 5000) / 5;
  for (let i = 0; i < deadline && !pred(); i++) await opts.sleep(5);
  check(pred(), `timed out waiting for ${what}`);
}

export function coreCases(factory: HarnessFactory, opts: ContractOptions): ContractCase[] {
  const c = (
    id: string,
    title: string,
    port: string,
    members: readonly string[],
    body: (h: ContractHarness, ctx: CaseContext) => Promise<void>,
  ): ContractCase => ({
    id,
    title,
    port,
    members,
    run: (ctx) => withHarness(factory, (h) => body(h, ctx)),
  });

  return [
    // --- Backend -----------------------------------------------------------------------------
    c(
      'backend.connect',
      'connect() opens a session with features, the welcome and every limit',
      'Backend',
      ['Backend.features', 'Backend.connect', 'AuthPort.session'],
      async (h) => {
        const docId = await createDoc(h);
        const b = await h.backend(USERS.editor, { [docId]: 'editor' });
        equal(b.auth.session, null, 'session before connect()');
        equal(b.features.size, 0, 'features before connect() (D23)');
        await b.connect();
        const s = b.auth.session;
        check(s, 'a session after connect()');
        check(isUuid7(s.session), 'the session identifier is a UUID version 7');
        equal(s.user.id, USERS.editor.sub, 'user.id');
        equal(s.version, '1.0', 'the protocol version');
        check(isTimestamp(s.tokenExp), 'tokenExp is an RFC 3339 timestamp');
        for (const k of LIMIT_NAMES)
          check(
            Number.isSafeInteger(s.limits[k]) && s.limits[k] >= 0,
            `limit ${k} is a non-negative integer`,
          );
        for (const f of b.features)
          includes(s.features, f, 'a negotiated feature was announced by the server');
        jsonEqual(portFeatureMismatches(b), [], 'optional ports and features agree');
        await b.close();
      },
    ),
    c(
      'backend.close',
      'close() closes every channel, is idempotent, and later submits fail',
      'Backend',
      ['Backend.close', 'SyncChannel.onState'],
      async (h) => {
        const docId = await createDoc(h);
        const m = await join(h, opts, docId, 'editor');
        await m.rec.untilState('live');
        await m.backend.close();
        await m.backend.close();
        await m.rec.until(() => m.rec.states.at(-1)?.status === 'closed', 'a closed state');
        const e = await rejects(
          m.channel.submit({
            id: newId(),
            base: m.seq(),
            steps: [insertText(posIn(m.content.doc, IDS.intro), 'x')],
          }),
          'submit after close()',
        );
        equal(codeOf(e), 'unavailable', 'the code of a submit on a closed channel (D23)');
      },
    ),

    // --- AuthPort ----------------------------------------------------------------------------
    c(
      'auth.refresh',
      'refresh() presents a new token and resolves the new tokenExp',
      'AuthPort',
      ['AuthPort.refresh'],
      async (h) => {
        const docId = await createDoc(h);
        const b = await connect(h, USERS.editor, { [docId]: 'editor' });
        const before = b.auth.session!.tokenExp;
        const r = await b.auth.refresh();
        check(isTimestamp(r.tokenExp), 'tokenExp is a timestamp');
        check(Date.parse(r.tokenExp) >= Date.parse(before), 'the new expiry is not earlier');
        equal(b.auth.session!.tokenExp, r.tokenExp, 'the session shows the new expiry');
        await b.close();
      },
    ),
    c(
      'auth.revoked',
      'a revocation ends the session and closes its channels; a newer token is accepted',
      'AuthPort',
      ['AuthPort.onRevoked'],
      async (h) => {
        const docId = await createDoc(h);
        const m = await join(h, opts, docId, 'editor');
        const revoked: string[] = [];
        m.backend.auth.onRevoked((e) => revoked.push(e.reason));
        await h.revokeSessions(USERS.editor.sub);
        await waitUntil(opts, () => revoked.length > 0, 'auth.revoked');
        await m.rec.until(
          () => m.rec.states.some((s) => s.status === 'closed'),
          'the channel closed',
        );
        const closed = m.rec.states.find((s) => s.status === 'closed');
        check(closed?.status === 'closed', 'closed state');
        oneOf(closed.code, ['forbidden', 'revoked'], 'the close code after a revocation (05 §5.2)');
        equal(
          codeOf(
            await rejects(
              m.channel.submit({
                id: newId(),
                base: m.seq(),
                steps: [insertText(posIn(m.content.doc, IDS.intro), 'x')],
              }),
              'a submit on the closed channel',
            ),
          ),
          'unavailable',
          'code',
        );
        // The token source mints a token after the watermark, which the server accepts (05 §3.3).
        await m.backend.connect();
        const again = await join(h, opts, docId, 'editor', m.backend);
        await again.rec.untilState('live');
        await m.backend.close();
      },
    ),
    c(
      'auth.required',
      'a refused token source fails connect() and refresh() and raises onAuthRequired',
      'AuthPort',
      ['AuthPort.onAuthRequired'],
      async (h, ctx) => {
        if (!h.denyTokens) return ctx.skip('the harness cannot make the host refuse tokens');
        const docId = await createDoc(h);
        const connected = await connect(h, USERS.editor, { [docId]: 'editor' });
        const fresh = await h.backend(USERS.editor, { [docId]: 'editor' });
        const seen: string[] = [];
        fresh.auth.onAuthRequired((e) => seen.push(e.code));
        connected.auth.onAuthRequired((e) => seen.push(`refresh:${e.code}`));
        h.denyTokens(USERS.editor.sub);
        equal(
          codeOf(await rejects(fresh.connect(), 'connect() without a token')),
          'unauthenticated',
          'code (05 §5.8)',
        );
        equal(
          codeOf(await rejects(connected.auth.refresh(), 'refresh() without a token')),
          'unauthenticated',
          'code',
        );
        await waitUntil(
          opts,
          () => seen.includes('unauthenticated') && seen.includes('refresh:unauthenticated'),
          'onAuthRequired',
        );
        equal(fresh.auth.session, null, 'no session');
        await connected.close();
      },
    ),
    c(
      'auth.expiring',
      'auth.expiring arrives about 60 seconds before tokenExp',
      'AuthPort',
      ['AuthPort.onExpiring'],
      async (h, ctx) => {
        if (!h.advanceClock) return ctx.skip('the harness has no test-mode clock (05 §11)');
        const docId = await createDoc(h);
        const b = await connect(h, USERS.editor, { [docId]: 'editor' });
        const seen: number[] = [];
        b.auth.onExpiring((e) => seen.push(e.inMs));
        // Move the server clock to 30 seconds before expiry (the local clock stands in for the server's).
        const left = Date.parse(b.auth.session!.tokenExp) - Date.now();
        await h.advanceClock(Math.max(0, left - 30_000));
        await waitUntil(opts, () => seen.length > 0, 'auth.expiring');
        check(seen[0]! >= 0 && seen[0]! <= 60_000, `inMs within the last minute (${seen[0]})`);
        await b.close();
      },
    ),

    // --- SyncPort ----------------------------------------------------------------------------
    c(
      'sync.loadContent',
      'loadContent() reads the head with seq, incarnation, cdm, requires and doc',
      'SyncPort',
      ['SyncPort.loadContent'],
      async (h) => {
        const docId = await createDoc(h);
        const b = await connect(h, USERS.viewer, { [docId]: 'viewer' });
        const content = await b.sync.loadContent(docId);
        check(
          Number.isSafeInteger(content.seq) && content.seq >= 0,
          'seq is a sequence number (G97)',
        );
        check(content.incarnation.length > 0, 'an incarnation');
        equal(content.cdm, 1, 'cdm');
        jsonEqual(content.requires, [], 'requires (D19)');
        equal(
          canonical(content.doc),
          canonical(contractDocument().doc),
          'the created content, in canonical form',
        );
        await b.close();
      },
    ),
    c(
      'sync.loadContent.pinned',
      'loadContent(docId, seq) is a pinned read',
      'SyncPort',
      ['SyncPort.loadContent'],
      async (h) => {
        const docId = await createDoc(h);
        const m = await join(h, opts, docId, 'editor');
        const a1 = await submit(m, [insertText(posIn(m.content.doc, IDS.intro), 'A')]);
        const mid = await m.backend.sync.loadContent(docId);
        const a2 = await submit(m, [insertText(posIn(mid.doc, IDS.intro), 'B')]);
        const p0 = await m.backend.sync.loadContent(docId, m.content.seq);
        const p1 = await m.backend.sync.loadContent(docId, a1.seq);
        const head = await m.backend.sync.loadContent(docId);
        const p2 = await m.backend.sync.loadContent(docId, a2.seq);
        equal(p1.seq, a1.seq, 'the pinned seq');
        equal(textOf(p0.doc, IDS.intro), 'Hello world', 'content before the commits');
        equal(textOf(p1.doc, IDS.intro), 'AHello world', 'content after the first commit');
        equal(head.seq, a2.seq, 'the head');
        equal(textOf(head.doc, IDS.intro), 'BAHello world', 'content at the head');
        equal(canonical(p2.doc), canonical(head.doc), 'a read pinned at the head equals the head');
        equal(p2.incarnation, head.incarnation, 'one incarnation');
        await m.backend.close();
      },
    ),
    c(
      'sync.loadContent.errors',
      'loadContent() refuses an unknown document and one the token does not cover',
      'SyncPort',
      ['SyncPort.loadContent'],
      async (h) => {
        const docId = await createDoc(h);
        const other = await createDoc(h);
        const missing = newId();
        const b = await connect(h, USERS.editor, { [docId]: 'editor', [missing]: 'editor' });
        equal(
          codeOf(await rejects(b.sync.loadContent(missing), 'an unknown document')),
          'not_found',
          'unknown document',
        );
        equal(
          codeOf(await rejects(b.sync.loadContent(other), 'a document outside the token')),
          'forbidden',
          'document outside the token (05 §6.1)',
        );
        await b.close();
      },
    ),
    c(
      'sync.open.reload',
      'open() without resume answers catchUp "reload" at the durable head',
      'SyncPort',
      [
        'SyncPort.open',
        'SyncChannel.docId',
        'SyncChannel.opened',
        'SyncChannel.onAccess',
        'SyncChannel.onState',
      ],
      async (h) => {
        const docId = await createDoc(h);
        const w = await join(h, opts, docId, 'owner');
        const ack = await submit(w, [insertText(posIn(w.content.doc, IDS.intro), 'x')]);
        const b = await connect(h, USERS.viewer, { [docId]: 'viewer' });
        const ch = await b.sync.open(docId, {});
        equal(ch.docId, docId, 'docId');
        equal(ch.opened.catchUp, 'reload', 'catchUp without resume (05 §5.2)');
        equal(ch.opened.head, ack.seq, 'head is the durable head');
        equal(ch.opened.incarnation, w.content.incarnation, 'incarnation');
        equal(ch.opened.inflight, undefined, 'no inflight without resume.inflight (D08)');
        const rec = new Recorder(ch, opts);
        await rec.until(
          () => rec.accesses.length >= 1 && rec.states.length >= 1,
          'the initial access and state',
        );
        equal(rec.syncCallbacks, 0, 'no callback during registration (D21)');
        jsonEqual(
          rec.accesses[0],
          ch.opened.access,
          'onAccess delivers the access of ch.opened first',
        );
        jsonEqual(rec.states[0], { status: 'live', seq: ack.seq }, 'the initial state');
        const a = ch.opened.access;
        equal(a.docRole, 'viewer', 'docRole');
        includes(a.caps, 'view', 'caps');
        excludes(a.caps, 'edit', 'caps');
        includes(a.scopes[LOCKED_SCOPE], 'view', 'every region is listed');
        check(a.scopes['body'] !== undefined, 'body is listed');
        jsonEqual(a.restrictions, [], 'restrictions');
        equal(a.fill, null, 'fill');
        await b.close();
        await w.backend.close();
      },
    ),
    c(
      'sync.open.stream',
      'open() with resume streams the missed commits, then sync.caughtUp',
      'SyncPort',
      ['SyncPort.open', 'SyncChannel.onCommits', 'SyncChannel.onState'],
      async (h) => {
        const docId = await createDoc(h);
        const w = await join(h, opts, docId, 'owner');
        const pos = posIn(w.content.doc, IDS.end);
        const s1 = await submit(w, [insertText(pos, 'a')]);
        const s2 = await submit(w, [insertText(pos + 1, 'b')]);
        const s3 = await submit(w, [insertText(pos + 2, 'c')]);
        // An editor resumes: under the history visibility gate (07 §8; default `editors`, ADR 0034,
        // proposed) a viewer's resume below the head is answered with a reload, not a stream.
        const b = await connect(h, USERS.editor, { [docId]: 'editor' });
        // The client read the content at s1 (a pinned read, 05 §5.2) and resumes from it, with its
        // view token (G101; D70).
        const pinned = await b.sync.loadContent(docId, s1.seq);
        const ch = await b.sync.open(docId, { resume: resumeFrom(pinned) });
        equal(ch.opened.catchUp, 'stream', 'catchUp within the limits');
        equal(ch.opened.head, s3.seq, 'head');
        const rec = new Recorder(ch, opts);
        await rec.untilState('live');
        jsonEqual(
          rec.commits.map((x) => x.seq),
          [s2.seq, s3.seq],
          'every commit from resume.seq + 1 to head, in order',
        );
        jsonEqual(rec.states[0], { status: 'catching_up', head: s3.seq }, 'catching up first');
        const live = rec.log.findIndex((d) => d.kind === 'state' && d.value.status === 'live');
        const last = rec.log.findIndex(
          (d) => d.kind === 'commits' && d.value.some((x) => x.seq === s3.seq),
        );
        check(last >= 0 && last < live, 'sync.caughtUp follows the stream');
        jsonEqual(rec.states.at(-1), { status: 'live', seq: s3.seq }, 'caught up at head');
        await b.close();
        await w.backend.close();
      },
    ),
    c(
      'sync.open.resumeMismatch',
      'a resume with another incarnation or a seq beyond head is answered with reload',
      'SyncPort',
      ['SyncPort.open'],
      async (h) => {
        const docId = await createDoc(h);
        const b = await connect(h, USERS.viewer, { [docId]: 'viewer' });
        const content = await b.sync.loadContent(docId);
        const ch1 = await b.sync.open(docId, {
          resume: { seq: content.seq, incarnation: `${content.incarnation}-other` },
        });
        equal(ch1.opened.catchUp, 'reload', 'another incarnation (04 §9 step 3)');
        ch1.close();
        const b2 = await connect(h, USERS.viewer, { [docId]: 'viewer' });
        const ch2 = await b2.sync.open(docId, {
          resume: { seq: content.seq + 10, incarnation: content.incarnation },
        });
        equal(ch2.opened.catchUp, 'reload', 'a seq beyond head (04 §9 step 3)');
        await b.close();
        await b2.close();
      },
    ),
    c(
      'sync.open.inflight',
      'resume.inflight is reported as accepted with its seq, or unknown',
      'SyncPort',
      ['SyncPort.open', 'SyncChannel.opened'],
      async (h) => {
        const docId = await createDoc(h);
        const m = await join(h, opts, docId, 'editor');
        const ack = await submit(m, [insertText(posIn(m.content.doc, IDS.intro), 'x')]);
        const b2 = await connect(h, USERS.editor, { [docId]: 'editor' });
        const ch = await b2.sync.open(docId, { resume: resumeFrom(m.content, ack.id) });
        jsonEqual(
          ch.opened.inflight,
          { state: 'accepted', seq: ack.seq },
          'a stored commit (04 §9)',
        );
        const rec = new Recorder(ch, opts);
        await rec.untilSeq(ack.seq);
        const b3 = await connect(h, USERS.editor, { [docId]: 'editor' });
        const ch3 = await b3.sync.open(docId, {
          resume: { ...resumeFrom(m.content, newId()), seq: ack.seq },
        });
        jsonEqual(ch3.opened.inflight, { state: 'unknown' }, 'a commit that was not stored');
        await Promise.all([m.backend.close(), b2.close(), b3.close()]);
      },
    ),
    c(
      'sync.open.rejected',
      'open() rejects with the ch.rejected code',
      'SyncPort',
      ['SyncPort.open'],
      async (h) => {
        const docId = await createDoc(h);
        const other = await createDoc(h);
        const missing = newId();
        const b = await connect(h, USERS.editor, { [docId]: 'editor', [missing]: 'editor' });
        equal(
          codeOf(await rejects(b.sync.open(missing, {}), 'an unknown document')),
          'not_found',
          'unknown document',
        );
        equal(
          codeOf(await rejects(b.sync.open(other, {}), 'a document outside the token')),
          'forbidden',
          'no view',
        );
        await b.sync.open(docId, {});
        equal(
          codeOf(await rejects(b.sync.open(docId, {}), 'a second channel')),
          'already_open',
          'one channel per document (05 §4)',
        );
        await b.close();
      },
    ),

    // --- SyncChannel -------------------------------------------------------------------------
    c(
      'channel.submit.ack',
      'submit() resolves the acknowledgement',
      'SyncChannel',
      ['SyncChannel.submit'],
      async (h) => {
        const docId = await createDoc(h);
        const m = await join(h, opts, docId, 'editor');
        const id = newId();
        const ack = await submit(
          m,
          [insertText(posIn(m.content.doc, IDS.intro), 'x')],
          m.content.seq,
          id,
        );
        equal(ack.id, id, 'the commit identifier');
        equal(ack.seq, m.content.seq + 1, 'the next seq');
        equal(ack.rebased, false, 'not rebased');
        equal(ack.steps, undefined, 'no steps when not rebased');
        check(isTimestamp(ack.serverTime), 'serverTime');
        await m.backend.close();
      },
    ),
    c(
      'channel.onCommits',
      "onCommits delivers other sessions' commits with server attribution",
      'SyncChannel',
      ['SyncChannel.onCommits'],
      async (h) => {
        const docId = await createDoc(h);
        const a = await join(h, opts, docId, 'editor');
        const v = await join(h, opts, docId, 'viewer');
        const steps = [insertText(posIn(a.content.doc, IDS.intro), 'x')];
        const ack = await submit(a, steps);
        await v.rec.untilSeq(ack.seq);
        const got = v.rec.commits.find((x) => x.seq === ack.seq)!;
        equal(got.kind, 'steps', 'kind');
        equal(got.id, ack.id, 'id');
        jsonEqual(got.steps, steps, 'steps as applied');
        equal(got.control, null, 'control on a step commit (D10)');
        equal(got.author.user, USERS.editor.sub, 'author.user');
        equal(got.author.session, a.backend.auth.session!.session, 'author.session');
        equal(got.author.agent, null, 'author.agent');
        equal(got.origin, 'input', 'origin');
        equal(got.serverTime, ack.serverTime, 'one server time');
        await Promise.all([a.backend.close(), v.backend.close()]);
      },
    ),
    c(
      'channel.submit.rebased',
      'a commit on an older base is rebased and acknowledged with the mapped steps',
      'SyncChannel',
      ['SyncChannel.submit'],
      async (h) => {
        const docId = await createDoc(h);
        const a = await join(h, opts, docId, 'editor');
        const b = await join(h, opts, docId, 'grantee');
        const base = a.seq();
        const first = await submit(a, [insertText(posIn(a.content.doc, IDS.intro), 'A')], base);
        const end = posIn(b.content.doc, IDS.end);
        const ack = await submit(b, [insertText(end, 'B')], base);
        equal(ack.seq, first.seq + 1, 'ordered after the first');
        equal(ack.rebased, true, 'rebased');
        check(ack.steps?.length === 1, 'the mapped steps (04 §7)');
        equal(ack.steps[0]!['from'], end + 1, 'mapped over the earlier insertion');
        await Promise.all([a.backend.close(), b.backend.close()]);
      },
    ),
    c(
      'channel.submit.duplicate',
      'a resubmitted commit is acknowledged again, with its steps',
      'SyncChannel',
      ['SyncChannel.submit'],
      async (h) => {
        const docId = await createDoc(h);
        const m = await join(h, opts, docId, 'editor');
        const id = newId();
        const base = m.seq();
        const steps = [insertText(posIn(m.content.doc, IDS.intro), 'x')];
        const first = await submit(m, steps, base, id);
        const again = await m.channel.submit({ id, base, steps });
        equal(again.seq, first.seq, 'the stored seq (04 G4)');
        equal(again.id, id, 'the same commit');
        check(again.steps?.length === 1, 'a rebuilt acknowledgement carries steps (05 §5.3)');
        await m.backend.close();
      },
    ),
    c(
      'channel.submit.busy',
      'a second submit before the first is answered is rejected with busy, action retry',
      'SyncChannel',
      ['SyncChannel.submit'],
      async (h, ctx) => {
        if (!h.holdWrites)
          return ctx.skip('needs the write-hold test hook to keep the first commit pending');
        const docId = await createDoc(h);
        const m = await join(h, opts, docId, 'editor');
        const pos = posIn(m.content.doc, IDS.intro);
        const hold = h.holdWrites(docId);
        const first = m.channel.submit({
          id: newId(),
          base: m.seq(),
          steps: [insertText(pos, 'a')],
        });
        const e = await rejects(
          m.channel.submit({ id: newId(), base: m.seq(), steps: [insertText(pos, 'b')] }),
          'the second submit',
        );
        check(isSyncReject(e), 'a SyncRejectError (D22)');
        equal(e.code, 'busy', 'code');
        equal(e.action, 'retry', 'action (04 §8)');
        await hold.release();
        await first;
        await m.backend.close();
      },
    ),
    c(
      'channel.reject.drop',
      'an edit outside the writable set is rejected with permission_denied, action drop',
      'SyncChannel',
      ['SyncChannel.submit'],
      async (h) => {
        const docId = await createDoc(h);
        const m = await join(h, opts, docId, 'editor');
        const id = newId();
        const e = await rejects(
          submit(m, [insertText(posIn(m.content.doc, IDS.lockedPara), 'x')], undefined, id),
          'editing the restricted region',
        );
        check(isSyncReject(e), 'a SyncRejectError');
        equal(e.code, 'permission_denied', 'code');
        equal(e.action, 'drop', 'action');
        equal(e.id, id, 'id');
        equal(e.head, m.seq(), 'head');
        includes(e.scopes, LOCKED_SCOPE, 'scopes name the region');
        check(e.message.length > 0, 'a message');
        await m.backend.close();
      },
    ),
    c(
      'channel.reject.rebase',
      'a step that cannot be mapped is rejected with rebase_failed, action rebase',
      'SyncChannel',
      ['SyncChannel.submit'],
      async (h) => {
        const docId = await createDoc(h);
        const a = await join(h, opts, docId, 'editor');
        const b = await join(h, opts, docId, 'grantee');
        const base = a.seq();
        const p = posIn(a.content.doc, IDS.intro);
        const del = await submit(a, [deleteRange(p + 6, p + 11)], base);
        const e = await rejects(
          submit(b, [deleteRange(p + 7, p + 10)], base),
          'a change inside deleted text',
        );
        check(isSyncReject(e), 'a SyncRejectError');
        equal(e.code, 'rebase_failed', 'code (04 §5 step 4)');
        equal(e.action, 'rebase', 'action');
        equal(e.head, del.seq, 'head');
        await Promise.all([a.backend.close(), b.backend.close()]);
      },
    ),
    c(
      'channel.reject.reload',
      'a base ahead of the head is rejected with invalid_op, action reload',
      'SyncChannel',
      ['SyncChannel.submit'],
      async (h) => {
        const docId = await createDoc(h);
        const m = await join(h, opts, docId, 'editor');
        const e = await rejects(
          m.channel.submit({
            id: newId(),
            base: m.seq() + 5,
            steps: [insertText(posIn(m.content.doc, IDS.intro), 'x')],
          }),
          'a base ahead',
        );
        check(isSyncReject(e), 'a SyncRejectError');
        equal(e.code, 'invalid_op', 'code (04 §5 step 3)');
        equal(e.action, 'reload', 'action');
        await m.backend.close();
      },
    ),
    c(
      'channel.reject.retry',
      'a commit whose write failed is rejected with unavailable, action retry, and can be resubmitted',
      'SyncChannel',
      ['SyncChannel.submit'],
      async (h, ctx) => {
        if (!h.holdWrites) return ctx.skip('needs the write-hold test hook to fail a write');
        const docId = await createDoc(h);
        const m = await join(h, opts, docId, 'editor');
        const commit = {
          id: newId(),
          base: m.seq(),
          steps: [insertText(posIn(m.content.doc, IDS.intro), 'x')],
        };
        const hold = h.holdWrites(docId);
        const pending = m.channel.submit(commit);
        await hold.fail();
        const e = await rejects(pending, 'a failed write');
        check(isSyncReject(e), 'a SyncRejectError');
        equal(e.code, 'unavailable', 'code (04 §5, when a write fails)');
        equal(e.action, 'retry', 'action');
        const ack = await m.channel.submit(commit);
        equal(ack.id, commit.id, 'the same commit is accepted on retry');
        await m.backend.close();
      },
    ),
    c(
      'channel.readOnly',
      'a locked document raises document.updated, limits access and rejects commits with read_only',
      'SyncChannel',
      ['SyncChannel.onEvent', 'SyncChannel.submit'],
      async (h) => {
        const docId = await createDoc(h);
        const m = await join(h, opts, docId, 'editor');
        await m.rec.until(() => m.rec.accesses.length >= 1, 'the initial access');
        await h.setDocumentState(docId, 'locked');
        await m.rec.until(
          () => m.rec.events.some((e) => e.type === 'document.updated'),
          'document.updated',
        );
        equal(
          m.rec.events.find((e) => e.type === 'document.updated')!.resource,
          `/documents/${docId}`,
          'the resource',
        );
        await m.rec.until(
          () => m.rec.accesses.length >= 2,
          'perm.changed after the state change (07 §4)',
        );
        excludes(m.rec.accesses.at(-1)!.scopes['body'], 'edit', 'no edit in a locked document');
        const e = await rejects(
          submit(m, [insertText(posIn(m.content.doc, IDS.intro), 'x')]),
          'a commit to a locked document',
        );
        check(isSyncReject(e), 'a SyncRejectError');
        equal(e.code, 'read_only', 'code (04 §5 step 1; G40)');
        equal(e.action, 'drop', 'action');
        await m.backend.close();
      },
    ),
    c(
      'channel.onReset',
      'a snapshot commit sends sync.reset; the pinned content follows and commits continue after it',
      'SyncChannel',
      ['SyncChannel.onReset'],
      async (h) => {
        const docId = await createDoc(h);
        const m = await join(h, opts, docId, 'editor');
        const before = await submit(m, [insertText(posIn(m.content.doc, IDS.intro), 'x')]);
        await h.replaceContent(docId, importedDocument());
        await m.rec.until(() => m.rec.resets.length > 0, 'sync.reset');
        const reset = m.rec.resets[0]!;
        equal(reset.reason, 'import', 'reason');
        check(reset.seq > before.seq, 'the snapshot has the next seq');
        const content = await m.backend.sync.loadContent(docId, reset.seq);
        equal(textOf(content.doc, IDS.intro), 'Imported text', 'the content at the reset seq');
        const ack = await submit(m, [insertText(posIn(content.doc, IDS.intro), 'y')], reset.seq);
        equal(ack.seq, reset.seq + 1, 'commits continue after the snapshot');
        const e = await rejects(
          m.channel.submit({
            id: newId(),
            base: before.seq,
            steps: [insertText(posIn(content.doc, IDS.intro), 'z')],
          }),
          'a base older than the snapshot',
        );
        check(isSyncReject(e), 'a SyncRejectError');
        equal(e.code, 'stale_base', 'code (04 §3.2, §5 step 3)');
        equal(
          e.action,
          'rebase',
          'action (04 §3.2): resubmit what still applies to the new content',
        );
        await m.backend.close();
      },
    ),
    c(
      'channel.onAccess',
      'a grants change sends a control commit, then perm.changed with a higher rev',
      'SyncChannel',
      ['SyncChannel.onAccess', 'SyncChannel.onCommits'],
      async (h) => {
        const docId = await createDoc(h);
        const m = await join(h, opts, docId, 'editor');
        await m.rec.until(() => m.rec.accesses.length >= 1, 'the initial access');
        const before = m.rec.accesses[0]!;
        excludes(before.scopes[LOCKED_SCOPE], 'edit', 'no grant yet');
        await h.setGrants(docId, [
          LEGAL_GRANT,
          { region: IDS.locked, principal: `user:${USERS.editor.sub}`, role: 'editor' },
        ]);
        await m.rec.until(() => m.rec.accesses.length >= 2, 'perm.changed');
        const after = m.rec.accesses[1]!;
        check(after.rev > before.rev, 'rev increases');
        includes(after.scopes[LOCKED_SCOPE], 'edit', 'the new grant');
        const control = m.rec.commits.find((x) => x.kind === 'control');
        check(control, 'a control commit (07 §9)');
        jsonEqual(control.steps, [], 'no steps');
        equal(control.author.session, null, 'server-authored');
        equal(control.control?.type, 'grants', 'records a grants revision');
        equal(after.asOfSeq, control.seq, 'asOfSeq is the control commit (D12)');
        const at = (pred: (d: (typeof m.rec.log)[number]) => boolean) => m.rec.log.findIndex(pred);
        check(
          at((d) => d.kind === 'commits' && d.value.includes(control)) <
            at((d) => d.kind === 'access' && d.value === after),
          'the control commit precedes perm.changed (PRO-033)',
        );
        const ack = await submit(m, [insertText(posIn(m.content.doc, IDS.lockedPara), 'x')]);
        equal(ack.seq, control.seq + 1, 'the new permission is in force');
        await m.backend.close();
      },
    ),
    c(
      'channel.close',
      'close() is idempotent, reports closed and ignores later messages',
      'SyncChannel',
      ['SyncChannel.close', 'SyncChannel.onState'],
      async (h) => {
        const docId = await createDoc(h);
        const m = await join(h, opts, docId, 'editor');
        const g = await join(h, opts, docId, 'grantee');
        await m.rec.untilState('live');
        m.channel.close();
        m.channel.close();
        await m.rec.until(() => m.rec.states.at(-1)?.status === 'closed', 'closed');
        const last = m.rec.states.at(-1);
        check(last?.status === 'closed' && last.code === null, 'closed by the caller: code null');
        equal(
          m.rec.states.filter((s) => s.status === 'closed').length,
          1,
          'one closed state for two close() calls',
        );
        const n = m.rec.log.length;
        await submit(g, [insertText(posIn(g.content.doc, IDS.intro), 'x')]);
        await quiet(opts);
        equal(m.rec.log.length, n, 'nothing is delivered after close()');
        equal(
          codeOf(
            await rejects(
              m.channel.submit({ id: newId(), base: 0, steps: [] }),
              'submit after close()',
            ),
          ),
          'unavailable',
          'code',
        );
        await Promise.all([m.backend.close(), g.backend.close()]);
      },
    ),
    c(
      'channel.close.pending',
      'close() rejects an unanswered submit with unavailable',
      'SyncChannel',
      ['SyncChannel.close', 'SyncChannel.submit'],
      async (h, ctx) => {
        if (!h.holdWrites)
          return ctx.skip('needs the write-hold test hook to keep a commit pending');
        const docId = await createDoc(h);
        const m = await join(h, opts, docId, 'editor');
        const hold = h.holdWrites(docId);
        const pending = m.channel.submit({
          id: newId(),
          base: m.seq(),
          steps: [insertText(posIn(m.content.doc, IDS.intro), 'x')],
        });
        m.channel.close();
        equal(codeOf(await rejects(pending, 'the pending submit')), 'unavailable', 'code (D23)');
        await hold.release();
        await m.backend.close();
      },
    ),
    c(
      'channel.order',
      'an acknowledgement settles before later commits are delivered',
      'SyncChannel',
      ['SyncChannel.submit', 'SyncChannel.onCommits'],
      async (h, ctx) => {
        if (!h.holdWrites)
          return ctx.skip('needs the write-hold test hook to store two commits at once');
        const docId = await createDoc(h);
        const a = await join(h, opts, docId, 'editor');
        const b = await join(h, opts, docId, 'grantee');
        const base = a.seq();
        const hold = h.holdWrites(docId);
        const px = a.channel.submit({
          id: newId(),
          base,
          steps: [insertText(posIn(a.content.doc, IDS.intro), 'X')],
        });
        const py = b.channel.submit({
          id: newId(),
          base,
          steps: [insertText(posIn(b.content.doc, IDS.end), 'Y')],
        });
        let later = -1;
        const observed = px.then((ack) => {
          later = a.rec.commits.filter((x) => x.seq > ack.seq).length;
          return ack;
        });
        await hold.release();
        const ax = await observed;
        const ay = await py;
        equal(later, 0, 'code awaiting submit() runs before later commits are delivered (D21)');
        await a.rec.untilSeq(ay.seq);
        equal(ay.seq, ax.seq + 1, 'consecutive');
        await Promise.all([a.backend.close(), b.backend.close()]);
      },
    ),
    c(
      'channel.buffered',
      'messages that arrive before a callback is registered are kept for it',
      'SyncChannel',
      ['SyncChannel.onAccess', 'SyncChannel.onState'],
      async (h) => {
        const docId = await createDoc(h);
        const b = await connect(h, USERS.viewer, { [docId]: 'viewer' });
        const ch = await b.sync.open(docId, {});
        await quiet(opts);
        const rec = new Recorder(ch, opts);
        await rec.until(
          () => rec.accesses.length >= 1 && rec.states.length >= 1,
          'the kept access and state',
        );
        equal(rec.syncCallbacks, 0, 'delivered asynchronously (D21)');
        await b.close();
      },
    ),
    c(
      'channel.onCheck',
      'sync.check carries the SHA-256 of the canonical form at seq',
      'SyncChannel',
      ['SyncChannel.onCheck'],
      async (h, ctx) => {
        if (!h.checkpoint)
          return ctx.skip('needs the checkpoint test hook (sync.check is optional, 04 §13)');
        const docId = await createDoc(h);
        const m = await join(h, opts, docId, 'editor');
        await submit(m, [insertText(posIn(m.content.doc, IDS.intro), 'x')]);
        await h.checkpoint(docId);
        await m.rec.until(() => m.rec.checks.length > 0, 'sync.check');
        const chk = m.rec.checks[0]!;
        const content = await m.backend.sync.loadContent(docId, chk.seq);
        const env = {
          cdm: content.cdm,
          requires: content.requires,
          doc: content.doc,
        } as unknown as JsonEnvelope;
        equal(chk.hash, await documentHash(env), 'hash (03 §2; G36)');
        await m.backend.close();
      },
    ),

    // --- PermissionsPort ---------------------------------------------------------------------
    c(
      'permissions.access',
      'current() and onAccess() follow the open channel',
      'PermissionsPort',
      ['PermissionsPort.current', 'PermissionsPort.onAccess'],
      async (h) => {
        const docId = await createDoc(h);
        const b = await connect(h, USERS.editor, { [docId]: 'editor' });
        equal(b.permissions.current(docId), null, 'no channel yet');
        const seen: Access[] = [];
        b.permissions.onAccess(docId, (a) => seen.push(a));
        const ch = await b.sync.open(docId, {});
        const rec = new Recorder(ch, opts);
        await rec.until(() => rec.accesses.length >= 1, 'the initial access');
        await waitUntil(opts, () => seen.length >= 1, 'PermissionsPort.onAccess');
        jsonEqual(b.permissions.current(docId), ch.opened.access, 'current() after open()');
        await h.setGrants(docId, [
          LEGAL_GRANT,
          { region: IDS.locked, principal: `user:${USERS.editor.sub}`, role: 'editor' },
        ]);
        await rec.until(() => rec.accesses.length >= 2, 'perm.changed');
        await waitUntil(opts, () => seen.length >= 2, 'PermissionsPort.onAccess after the change');
        jsonEqual(seen, rec.accesses, 'the same accesses as the channel');
        jsonEqual(b.permissions.current(docId), rec.accesses.at(-1), 'current() after the change');
        ch.close();
        await rec.untilState('closed');
        equal(b.permissions.current(docId), null, 'no access once the channel is closed');
        await b.close();
      },
    ),
    c(
      'permissions.regions',
      'regions() lists the regions with title, policy, order and state',
      'PermissionsPort',
      ['PermissionsPort.regions'],
      async (h, ctx) => {
        const docId = await createDoc(h);
        const b = await connect(h, USERS.owner, { [docId]: 'owner' });
        if (!b.permissions.regions)
          return ctx.skip('no regions member (feature `regions` not announced)');
        const list = await b.permissions.regions(docId);
        jsonEqual(
          list.map((r) => [r.id, r.title, r.policy, r.state]),
          [
            [IDS.open, 'Open', 'inherit', 'draft'],
            [IDS.locked, 'Locked', 'restricted', 'draft'],
          ],
          'the regions in document order',
        );
        check(list[0]!.order < list[1]!.order, 'order follows the document');
        await b.close();
      },
    ),
    c(
      'permissions.grants',
      'grants() and updateGrants() with If-Match; only manage may change grants',
      'PermissionsPort',
      ['PermissionsPort.grants', 'PermissionsPort.updateGrants'],
      async (h, ctx) => {
        const docId = await createDoc(h);
        const owner = await connect(h, USERS.owner, { [docId]: 'owner' });
        if (!owner.permissions.grants || !owner.permissions.updateGrants)
          return ctx.skip('no grants members (feature `regions` not announced)');
        const g = await owner.permissions.grants(docId);
        jsonEqual(
          g.value.grants.map((x) => [x.region, x.principal, x.role]),
          [[LEGAL_GRANT.region, LEGAL_GRANT.principal, LEGAL_GRANT.role]],
          'the initial grant',
        );
        check(g.etag.length > 0, 'an ETag');
        const extra = {
          region: IDS.locked,
          principal: `user:${USERS.editor.sub}`,
          role: 'editor' as const,
        };
        const u = await owner.permissions.updateGrants(
          docId,
          { grants: [...g.value.grants, extra] },
          { ifMatch: g.etag },
        );
        check(u.value.rev > g.value.rev, 'a new grants revision');
        check(u.etag !== g.etag, 'a new ETag');
        equal(
          codeOf(
            await rejects(
              owner.permissions.updateGrants(docId, { grants: [] }, { ifMatch: g.etag }),
              'a stale If-Match',
            ),
          ),
          'precondition_failed',
          'code for a stale ETag (G50)',
        );
        const editor = await connect(h, USERS.editor, { [docId]: 'editor' });
        equal(
          codeOf(
            await rejects(
              editor.permissions.updateGrants!(docId, { grants: [] }, { ifMatch: u.etag }),
              'an editor without manage',
            ),
          ),
          'forbidden',
          'manage is required (07 §12)',
        );
        await Promise.all([owner.close(), editor.close()]);
      },
    ),
    c(
      'permissions.setRegionState',
      'an approved region is limited to view and comment for everyone',
      'PermissionsPort',
      ['PermissionsPort.setRegionState'],
      async (h, ctx) => {
        const docId = await createDoc(h);
        const owner = await connect(h, USERS.owner, { [docId]: 'owner' });
        if (!owner.permissions.setRegionState)
          return ctx.skip('no setRegionState member (feature `regions` not announced)');
        const g = await join(h, opts, docId, 'grantee');
        await g.rec.until(() => g.rec.accesses.length >= 1, 'the initial access');
        includes(g.rec.accesses[0]!.scopes[LOCKED_SCOPE], 'edit', 'the grant gives edit');
        const r = await owner.permissions.setRegionState(docId, IDS.locked, 'approved', {
          ifMatch: '*',
        });
        equal(r.value.state, 'approved', 'state');
        await g.rec.until(() => g.rec.accesses.length >= 2, 'perm.changed');
        excludes(
          g.rec.accesses.at(-1)!.scopes[LOCKED_SCOPE],
          'edit',
          'approved freezes the region (07 §4 limit 2)',
        );
        const e = await rejects(
          submit(g, [insertText(posIn(g.content.doc, IDS.lockedPara), 'x')]),
          'editing an approved region',
        );
        check(isSyncReject(e), 'a SyncRejectError');
        equal(e.code, 'permission_denied', 'code');
        const editor = await connect(h, USERS.editor, { [docId]: 'editor' });
        equal(
          codeOf(
            await rejects(
              editor.permissions.setRegionState!(docId, IDS.locked, 'draft', { ifMatch: '*' }),
              'without manage',
            ),
          ),
          'forbidden',
          'manage is required',
        );
        await Promise.all([owner.close(), editor.close(), g.backend.close()]);
      },
    ),
  ];
}

/** Every member of the core ports, for the coverage check (PRO-092 criterion on contract tests). */
export const CORE_MEMBERS: readonly string[] = [
  'Backend.features',
  'Backend.connect',
  'Backend.close',
  'AuthPort.session',
  'AuthPort.refresh',
  'AuthPort.onExpiring',
  'AuthPort.onRevoked',
  'AuthPort.onAuthRequired',
  'SyncPort.loadContent',
  'SyncPort.open',
  'SyncChannel.docId',
  'SyncChannel.opened',
  'SyncChannel.submit',
  'SyncChannel.onCommits',
  'SyncChannel.onReset',
  'SyncChannel.onAccess',
  'SyncChannel.onEvent',
  'SyncChannel.onState',
  'SyncChannel.onCheck',
  'SyncChannel.close',
  'PermissionsPort.current',
  'PermissionsPort.onAccess',
  'PermissionsPort.regions',
  'PermissionsPort.grants',
  'PermissionsPort.updateGrants',
  'PermissionsPort.setRegionState',
];
