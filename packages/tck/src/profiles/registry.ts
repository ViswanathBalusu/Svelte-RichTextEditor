/**
 * The `registry` profile (PRO-115 criterion 3): every code of the error registry of 05 §5.8 that a
 * server can send in a rejection is provoked on each surface the kit can reach from outside, and
 * the kit checks the code, the surface it arrived on and its retry hint against the registry data
 * of the protocol definition (`retryable`, the `sync.reject` action, the HTTP status of D61). A
 * code that needs a fault, load or a feature the target lacks is skipped with that reason, and the
 * test of PRO-117 checks that every code has an entry here.
 */
import { DEP1, chunkMessage, type ServerMessage, type Step } from '@docedit/protocol';
import { uuid7 } from '@docedit/model';
import { KitFailure, check, equal, includes } from '../assert.ts';
import { HELLO_BASE, type ScenarioContext } from '../context.ts';
import {
  IDS,
  contractDocument,
  deleteRange,
  importedDocument,
  insertText,
  posBefore,
  posIn,
} from '../documents.ts';
import { expectStatus, type HttpResponse } from '../rest.ts';
import { scenario, type ProfileDef, type ScenarioDef } from '../scenario.ts';
import { FIELD_IDS, fieldsDocument } from './fields.ts';
import { TEST_HOOKS_FEATURE, hook } from './fault-injection.ts';
import { join, openChannel, problemOf, submit } from './support.ts';

/** Messages of the burst that provokes 
ate_limited on the socket; provisional. */
const FLOOD = 3000;

type Surface = 'socket' | 'rest' | 'sync' | 'channel-close';

const REGISTRY = new Map(DEP1.errors.map((e) => [e.code, e]));

/** The retry hint of the registry for a code (05 §5.8). */
function retryHint(code: string) {
  const e = REGISTRY.get(code);
  if (!e) throw new KitFailure(`${code} is not in the registry`, 'a registry code', code);
  return e;
}

/** Checks a socket `error` (or `ch.rejected`) against the registry. */
function socketError(m: ServerMessage, code: string) {
  const e = retryHint(code);
  if (m.t === 'ch.rejected') {
    equal(m.d.code, code, 'the ch.rejected code');
    return;
  }
  if (m.t !== 'error') throw new KitFailure(`${code} on the socket`, `error ${code}`, m);
  equal(m.d.code, code, 'the error code');
  includes(e.surfaces as string[], 'socket', `${code} may appear on the socket (05 §5.8)`);
  if (e.retryable === 'no') equal(m.d.retryable, false, `${code} is not retryable (05 §5.8)`);
  if (e.retryable === 'yes' || e.retryable === 'after-retry-after')
    equal(m.d.retryable, true, `${code} is retryable (05 §5.8)`);
}

function syncReject(m: ServerMessage, code: string) {
  const e = retryHint(code);
  if (m.t !== 'sync.reject')
    throw new KitFailure(`${code} in sync.reject`, `sync.reject ${code}`, m);
  equal(m.d.code, code, 'the sync.reject code');
  includes(e.surfaces as string[], 'sync', `${code} may appear in sync.reject (05 §5.8)`);
  if (e.syncAction)
    includes(e.syncAction as string[], m.d.action, `the action for ${code} (04 §8)`);
  if (e.retryable === 'after-retry-after')
    check(typeof m.d.retryAfterMs === 'number', `${code} carries retryAfterMs`, 'a number', m.d);
}

function restProblem(res: HttpResponse, code: string, what: string) {
  const e = retryHint(code);
  const p = problemOf(res, what);
  equal(p.code, code, `${what}: the problem code`);
  includes(e.surfaces as string[], 'rest', `${code} may appear on REST (05 §5.8)`);
  if (code === 'precondition_failed')
    check(
      res.status === 412 || res.status === 428,
      'precondition_failed is 412 or 428 (D61)',
      '412 or 428',
      res.status,
    );
  else equal(res.status, e.httpStatus, `the HTTP status of ${code} (D61)`);
  if (e.retryable === 'after-retry-after')
    check(res.headers.get('retry-after') !== null, `${code} carries Retry-After`, 'a header', null);
}

interface Provocation {
  code: string;
  surface: Surface;
  how: string;
  needs?: ScenarioDef['needs'];
  /** Why the kit cannot provoke it from outside; the scenario is then skipped. */
  unreachable?: string;
  run?(ctx: ScenarioContext): Promise<void>;
}

async function fresh(ctx: ScenarioContext, frame?: string) {
  const doc = await ctx.document();
  const { token } = await ctx.token('fresh', { [doc]: 'editor' });
  const w = await ctx.connect({ label: 'registry' });
  if (frame !== undefined) return { doc, token, w };
  await ctx.hello(w, token);
  return { doc, token, w };
}

async function firstError(ctx: ScenarioContext, w: Awaited<ReturnType<typeof fresh>>['w']) {
  return w.next((m) => m.t === 'error', 'an error message', { timeoutMs: ctx.timeoutMs });
}

/**
 * Sets tenant quotas through `PUT /quotas` (service credential, 06 §12), runs `fn`, and puts the
 * values the tenant had back, whatever `fn` does. A server that keeps no quota settings answers
 * `not_found` and the scenario is skipped. The scenarios that use it need the test-mode switch,
 * because for a moment the kit's own tenant has a quota of 0.
 */
async function withQuota(
  ctx: ScenarioContext,
  patch: Record<string, number>,
  fn: () => Promise<void>,
) {
  const before = await ctx.service.call('GET', '/quotas');
  if (before.status === 404) ctx.skip('the server keeps no quota settings (GET /quotas is 404)');
  expectStatus(before, 200, 'GET /quotas');
  const values = before.json as Record<string, number | null>;
  const set = async (body: Record<string, number | null>) => {
    const current = await ctx.service.call('GET', '/quotas');
    return ctx.service.call('PUT', '/quotas', {
      body,
      headers: { 'if-match': current.headers.get('etag') ?? '*' },
    });
  };
  expectStatus(await set(patch), 200, 'PUT /quotas');
  try {
    await fn();
  } finally {
    const restore: Record<string, number | null> = {};
    // PUT /quotas takes whole numbers only (a dimension cannot be cleared), so a dimension the
    // tenant had not set goes back as the largest whole number: no quota in practice (ADR 0415).
    for (const k of Object.keys(patch)) restore[k] = values[k] ?? Number.MAX_SAFE_INTEGER;
    expectStatus(await set(restore), 200, 'PUT /quotas, restoring the values');
  }
}

/** A replacement of the content with the document's current ETag, as `replaceContent` of the service helper sends it. */
async function replaceContent(ctx: ScenarioContext, doc: string) {
  const current = await ctx.service.call('GET', `/documents/${doc}/content`);
  return ctx.service.call('PUT', `/documents/${doc}/content`, {
    body: importedDocument(),
    headers: { 'if-match': current.headers.get('etag') ?? '*' },
  });
}
/**
 * `join` that waits for a server that is busy proving its lease: a node answers `unavailable` to a
 * `ch.open` for a moment under load (05 §5.2), and the client opens again as 04 §9 says.
 */
async function joinWhenAvailable(
  ctx: ScenarioContext,
  name: string,
  doc: string,
  role: Parameters<typeof join>[3],
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await join(ctx, name, doc, role);
    } catch (e) {
      if (attempt >= 6 || !(e instanceof KitFailure) || !e.received?.includes('unavailable'))
        throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
/** The fault-injection scenarios need the hooks of the server (ADR 0219, ADR 0398). */
function requireHooks(ctx: ScenarioContext) {
  if (!ctx.has(TEST_HOOKS_FEATURE)) ctx.skip(`the server does not announce ${TEST_HOOKS_FEATURE}`);
}

/** Runs `fn` while the store is unreachable (`POST /_test/database`), and brings it back. */
async function withDatabaseDown(ctx: ScenarioContext, fn: () => Promise<void>) {
  expectStatus(await hook(ctx, 'POST', '/database', { down: true }), 204, 'the database hook');
  try {
    await fn();
  } finally {
    await hook(ctx, 'POST', '/database', { down: false });
  }
}

const PROVOCATIONS: Provocation[] = [
  {
    code: 'bad_message',
    surface: 'socket',
    how: 'a frame that is not JSON',
    async run(ctx) {
      const { w } = await fresh(ctx);
      w.sendText('{not json');
      socketError(await firstError(ctx, w), 'bad_message');
    },
  },
  {
    code: 'unknown_type',
    surface: 'socket',
    how: 'an unknown message type with an id',
    async run(ctx) {
      const { w } = await fresh(ctx);
      w.send({ t: 'x-tck-unknown', id: 'u' });
      socketError(await w.reply('u'), 'unknown_type');
    },
  },
  {
    code: 'unauthenticated',
    surface: 'socket',
    how: 'hello with a token that is not a JWT',
    async run(ctx) {
      const w = await ctx.connect({ label: 'registry' });
      w.send({ t: 'hello', id: 'h', d: { ...HELLO_BASE, token: 'garbage', features: [] } });
      socketError(await firstError(ctx, w), 'unauthenticated');
    },
  },
  {
    code: 'unauthenticated',
    surface: 'rest',
    how: 'a request without a credential',
    async run(ctx) {
      restProblem(
        await ctx.service.as(undefined, 'GET', `/documents/${uuid7()}`),
        'unauthenticated',
        'no credential',
      );
    },
  },
  {
    code: 'token_expired',
    surface: 'socket',
    how: 'hello with a token that expired more than the 60 seconds of skew ago',
    needs: { testMode: true },
    async run(ctx) {
      const doc = await ctx.document();
      const { token } = await ctx.token('expired', { [doc]: 'viewer' }, { expiresIn: 1 });
      await ctx.sleep(3000);
      const w = await ctx.connect({ label: 'registry' });
      w.send({ t: 'hello', id: 'h', d: { ...HELLO_BASE, token, features: [] } });
      socketError(await firstError(ctx, w), 'token_expired');
    },
  },
  {
    code: 'token_expired',
    surface: 'rest',
    how: 'a request with an expired token',
    needs: { testMode: true },
    async run(ctx) {
      const doc = await ctx.document();
      const { token } = await ctx.token('expired', { [doc]: 'viewer' }, { expiresIn: 1 });
      await ctx.sleep(3000);
      restProblem(
        await ctx.service.as(token, 'GET', `/documents/${doc}`),
        'token_expired',
        'an expired token',
      );
    },
  },
  {
    code: 'revoked',
    surface: 'socket',
    how: 'hello with a token issued before a revocation',
    async run(ctx) {
      const doc = await ctx.document();
      const { sub, token } = await ctx.token('revoked', { [doc]: 'viewer' });
      await ctx.sleep(1100);
      await ctx.service.revoke(sub);
      const w = await ctx.connect({ label: 'registry' });
      w.send({ t: 'hello', id: 'h', d: { ...HELLO_BASE, token, features: [] } });
      socketError(await firstError(ctx, w), 'revoked');
    },
  },
  {
    code: 'revoked',
    surface: 'rest',
    how: 'a request with a token issued before a revocation',
    async run(ctx) {
      const doc = await ctx.document();
      const { sub, token } = await ctx.token('revoked', { [doc]: 'viewer' });
      await ctx.sleep(1100);
      await ctx.service.revoke(sub);
      restProblem(
        await ctx.service.as(token, 'GET', `/documents/${doc}`),
        'revoked',
        'a revoked token',
      );
    },
  },
  {
    code: 'forbidden',
    surface: 'socket',
    how: 'hello from a disallowed origin',
    async run(ctx) {
      const doc = await ctx.document();
      const { token } = await ctx.token('origin', { [doc]: 'viewer' });
      const w = await ctx.connect({ label: 'registry', origin: 'https://refused.tck.invalid' });
      w.send({ t: 'hello', id: 'h', d: { ...HELLO_BASE, token, features: [] } });
      socketError(await firstError(ctx, w), 'forbidden');
    },
  },
  {
    code: 'forbidden',
    surface: 'rest',
    how: 'a document outside the token',
    async run(ctx) {
      const doc = await ctx.document();
      const other = await ctx.document();
      const { token } = await ctx.token('outsider', { [other]: 'owner' });
      restProblem(
        await ctx.service.as(token, 'GET', `/documents/${doc}`),
        'forbidden',
        'outside the token',
      );
    },
  },
  {
    code: 'forbidden',
    surface: 'channel-close',
    how: 'a revocation for one document closes its channel',
    async run(ctx) {
      const d1 = await ctx.document();
      const d2 = await ctx.document();
      const s = await ctx.session('closed', { [d1]: 'viewer', [d2]: 'viewer' });
      const o = await openChannel(ctx, s.wire, 1, d1, {});
      equal(o.t, 'ch.opened', 'the channel opens');
      await ctx.sleep(1100);
      await ctx.service.revoke(s.sub, d1);
      const closed = await s.wire.nextOf('ch.closed', { ch: 1 });
      equal(closed.d.code, 'forbidden', 'the ch.closed code');
    },
  },
  {
    code: 'unsupported_version',
    surface: 'socket',
    how: 'hello with versions [9.0]',
    async run(ctx) {
      const doc = await ctx.document();
      const { token } = await ctx.token('version', { [doc]: 'viewer' });
      const w = await ctx.connect({ label: 'registry' });
      w.send({ t: 'hello', id: 'h', d: { ...HELLO_BASE, versions: ['9.0'], token, features: [] } });
      socketError(await firstError(ctx, w), 'unsupported_version');
    },
  },
  ...(
    [
      'unsupported_engine',
      'unsupported_cdm',
      'unsupported_feature',
      'not_found',
      'already_open',
      'channel_limit',
    ] as const
  ).map((code): Provocation => ({
    code,
    surface: 'socket',
    how: `ch.rejected ${code}`,
    async run(ctx) {
      const { doc, w } = await fresh(ctx);
      let reply: ServerMessage;
      if (code === 'unsupported_engine')
        reply = await openChannel(ctx, w, 1, doc, { engine: 'x-tck/1' });
      else if (code === 'unsupported_cdm') reply = await openChannel(ctx, w, 1, doc, { cdm: 99 });
      else if (code === 'unsupported_feature')
        reply = await openChannel(ctx, w, 1, doc, { features: ['x-tck-unannounced'] });
      else if (code === 'not_found') {
        const missing = uuid7();
        const minted = await ctx.service.call('POST', '/tokens', {
          body: { sub: ctx.sub('missing'), docs: { [missing]: 'viewer' } },
        });
        if (minted.status >= 300)
          ctx.skip('the server mints no token for a document that does not exist');
        const w2 = await ctx.connect({ label: 'missing' });
        await ctx.hello(w2, (minted.json as { token: string }).token);
        reply = await openChannel(ctx, w2, 1, missing, {});
      } else if (code === 'already_open') {
        await openChannel(ctx, w, 1, doc, {});
        reply = await openChannel(ctx, w, 2, doc, {});
      } else {
        const max = ctx.limits.maxChannels;
        if (max > 19)
          ctx.skip(
            `maxChannels is ${max}; core.channel.rejected.limit covers it with channel tokens`,
          );
        const docs = [doc];
        for (let i = 0; i < max; i++) docs.push(await ctx.document());
        const token = await ctx.service.token(
          ctx.sub('limit'),
          Object.fromEntries(docs.map((d) => [d, 'viewer'])),
        );
        const w3 = await ctx.connect({ label: 'limit' });
        await ctx.hello(w3, token);
        for (let i = 0; i < max; i++) await openChannel(ctx, w3, i + 1, docs[i]!, {});
        reply = await openChannel(ctx, w3, max + 1, docs[max]!, {});
      }
      socketError(reply, code);
    },
  })),
  {
    code: 'too_large',
    surface: 'socket',
    how: 'a frame above maxMessageBytes',
    async run(ctx) {
      const { w } = await fresh(ctx);
      w.sendText(`{"t":"ping","x":"${'x'.repeat(ctx.limits.maxMessageBytes)}"}`);
      socketError(await firstError(ctx, w), 'too_large');
    },
  },
  {
    code: 'too_large',
    surface: 'sync',
    how: 'a commit above maxCommitBytes',
    async run(ctx) {
      const doc = await ctx.document();
      const m = await join(ctx, 'big', doc, 'editor');
      const text = JSON.stringify({
        t: 'sync.submit',
        id: 'big',
        ch: 1,
        d: {
          id: uuid7(),
          base: m.content.seq,
          steps: [
            insertText(
              posIn(m.content.doc, IDS.intro),
              'b'.repeat(m.welcome.limits.maxCommitBytes + 512),
            ),
          ],
        },
      });
      for (const f of chunkMessage(text, m.welcome.limits.maxMessageBytes, uuid7()))
        m.wire.sendText(f);
      const r = await m.wire.reply('big', { timeoutMs: 30_000 }).catch(() => null);
      if (!r)
        return ctx.skip(
          'the server closed the connection rather than rejecting the commit (see core.sync.too-large)',
        );
      syncReject(r, 'too_large');
    },
  },
  {
    code: 'too_large',
    surface: 'rest',
    how: 'a request body above the server limit',
    async run(ctx) {
      const big = 'x'.repeat(20 * 1024 * 1024);
      const res = await ctx.service.call('POST', '/documents', { rawBody: `{"title":"${big}"}` });
      if (res.status !== 413)
        ctx.skip(`the server took a 20 MiB body (HTTP ${res.status}); its limit is larger`);
      restProblem(res, 'too_large', 'a 20 MiB body');
    },
  },
  {
    code: 'stale_base',
    surface: 'sync',
    how: 'a base older than a snapshot commit',
    async run(ctx) {
      const doc = await ctx.document();
      const m = await join(ctx, 'stale', doc, 'editor');
      const first = await submit(m.wire, 1, {
        base: m.content.seq,
        steps: [insertText(posIn(m.content.doc, IDS.intro), 's')],
      });
      check(first.t === 'sync.ack', 'a first commit', 'sync.ack', first);
      await ctx.service.replaceContent(doc, importedDocument());
      await m.wire.nextOf('sync.reset', { ch: 1 });
      syncReject(
        await submit(m.wire, 1, {
          base: m.content.seq,
          steps: [insertText(posIn(m.content.doc, IDS.intro), 't')],
        }),
        'stale_base',
      );
    },
  },
  {
    code: 'rebase_failed',
    surface: 'sync',
    how: 'a deletion inside text another commit deleted',
    async run(ctx) {
      const doc = await ctx.document();
      const a = await join(ctx, 'a', doc, 'editor');
      const b = await join(ctx, 'b', doc, 'editor');
      const p = posIn(a.content.doc, IDS.intro);
      await submit(a.wire, 1, { base: a.content.seq, steps: [deleteRange(p + 6, p + 11)] });
      syncReject(
        await submit(b.wire, 1, { base: b.content.seq, steps: [deleteRange(p + 7, p + 10)] }),
        'rebase_failed',
      );
    },
  },
  {
    code: 'permission_denied',
    surface: 'sync',
    how: 'a viewer commit',
    async run(ctx) {
      const doc = await ctx.document();
      const v = await join(ctx, 'viewer', doc, 'viewer');
      syncReject(
        await submit(v.wire, 1, {
          base: v.content.seq,
          steps: [insertText(posIn(v.content.doc, IDS.intro), 'v')],
        }),
        'permission_denied',
      );
    },
  },
  {
    code: 'read_only',
    surface: 'sync',
    how: 'a commit to a locked document',
    async run(ctx) {
      const doc = await ctx.document();
      const m = await join(ctx, 'locked', doc, 'editor');
      await ctx.service.setState(doc, 'locked');
      await m.wire.nextOf('perm.changed', { ch: 1 });
      syncReject(
        await submit(m.wire, 1, {
          base: m.content.seq,
          steps: [insertText(posIn(m.content.doc, IDS.intro), 'l')],
        }),
        'read_only',
      );
    },
  },
  {
    code: 'invalid_op',
    surface: 'sync',
    how: 'an unknown step type',
    async run(ctx) {
      const doc = await ctx.document();
      const m = await join(ctx, 'invalid', doc, 'editor');
      syncReject(
        await submit(m.wire, 1, { base: m.content.seq, steps: [{ stepType: 'x-tck' }] }),
        'invalid_op',
      );
    },
  },
  {
    code: 'not_found',
    surface: 'rest',
    how: 'an unknown document',
    async run(ctx) {
      restProblem(
        await ctx.service.call('GET', `/documents/${uuid7()}`),
        'not_found',
        'an unknown document',
      );
    },
  },
  {
    code: 'conflict',
    surface: 'rest',
    how: 'a second document with the same externalId',
    async run(ctx) {
      const externalId = `tck-${uuid7()}`;
      await ctx.service.createDocument({ content: contractDocument(), externalId });
      restProblem(
        await ctx.service.call('POST', '/documents', {
          body: { content: contractDocument(), externalId },
        }),
        'conflict',
        'a duplicate externalId (D62)',
      );
    },
  },
  {
    code: 'precondition_failed',
    surface: 'rest',
    how: 'PATCH without If-Match',
    async run(ctx) {
      const doc = await ctx.document();
      restProblem(
        await ctx.service.call('PATCH', `/documents/${doc}`, { body: { title: 'x' } }),
        'precondition_failed',
        'no If-Match',
      );
    },
  },
  {
    code: 'validation_failed',
    surface: 'rest',
    how: 'a body that breaks the schema',
    async run(ctx) {
      restProblem(
        await ctx.service.call('POST', '/documents', { body: { content: 7 } }),
        'validation_failed',
        'an invalid body',
      );
    },
  },
  {
    code: 'idempotency_mismatch',
    surface: 'rest',
    how: 'one Idempotency-Key with two bodies',
    async run(ctx) {
      const key = `tck-${uuid7()}`;
      await ctx.service.call('POST', '/documents', {
        body: { content: contractDocument(), title: 'a' },
        headers: { 'idempotency-key': key },
      });
      restProblem(
        await ctx.service.call('POST', '/documents', {
          body: { content: contractDocument(), title: 'b' },
          headers: { 'idempotency-key': key },
        }),
        'idempotency_mismatch',
        'a reused key',
      );
    },
  },
  {
    code: 'pending_suggestions',
    surface: 'rest',
    how: 'an export of a document with unresolved suggestions',
    needs: { features: ['exports'] },
    async run(ctx) {
      const env = contractDocument();
      const body = (env.doc as unknown as { content: Array<{ type: string; content: unknown[] }> })
        .content[1]!;
      body.content[0] = {
        type: 'paragraph',
        attrs: { id: IDS.intro },
        content: [
          {
            type: 'text',
            text: 'new',
            marks: [{ type: 'ins', attrs: { id: 'sTck000000000002', user: 'tck' } }],
          },
        ],
      };
      const doc = await ctx.document(env);
      const { token } = await ctx.token('exporter', { [doc]: 'viewer' });
      restProblem(
        await ctx.service.as(token, 'POST', `/documents/${doc}/exports`, {
          body: { target: 'pdf' },
        }),
        'pending_suggestions',
        'unresolved suggestions',
      );
    },
  },
  {
    code: 'busy',
    surface: 'sync',
    how: 'a second submit while the first is pending',
    unreachable: 'needs held writes (fault injection); core.sync.busy tries without them',
  },
  {
    code: 'conflict',
    surface: 'sync',
    how: 'a fill over a value changed after the base (P9)',
    needs: { features: ['fields'] },
    unreachable: 'the `fields` profile provokes it',
  },
  {
    code: 'field_invalid',
    surface: 'sync',
    how: 'a fill that breaks the field rules',
    needs: { features: ['fields'] },
    // P7 (12 §4.2): field_invalid is answered only to a user who holds `fill` and not `edit`.
    async run(ctx) {
      const doc = await ctx.document(fieldsDocument());
      const m = await join(ctx, 'filler', doc, 'filler');
      const r = await submit(m.wire, m.ch, {
        base: m.content.seq,
        steps: [
          {
            stepType: 'attr',
            pos: posBefore(m.content.doc, FIELD_IDS.rent),
            attr: 'value',
            value: 'twelve',
          } as Step,
        ],
      });
      syncReject(r, 'field_invalid');
      await m.wire.close();
    },
  },
  {
    code: 'field_invalid',
    surface: 'rest',
    how: 'a prefill that breaks the field rules',
    needs: { features: ['fields'] },
    async run(ctx) {
      const doc = await ctx.document(fieldsDocument());
      const current = await ctx.service.call('GET', `/documents/${doc}/field-values`);
      const etag = current.headers.get('etag') ?? '*';
      const res = await ctx.service.call('PATCH', `/documents/${doc}/field-values`, {
        body: { values: { rent: 'twelve' } },
        headers: { 'if-match': etag },
      });
      restProblem(res, 'field_invalid', 'a prefill of a number field with text');
    },
  },
  {
    code: 'workflow_active',
    surface: 'rest',
    how: 'replacing an active workflow',
    needs: { features: ['workflow'] },
    unreachable: 'the workflow profiles (phase 2, FRW-068)',
  },
  {
    code: 'rate_limited',
    surface: 'socket',
    how: `a flood of ${FLOOD} messages on one connection`,
    needs: { testMode: true },
    async run(ctx) {
      // The spec names no limit, so the kit sends a bounded burst of ch.open for a document the
      // token does not cover (the figure is provisional, not a measurement; a ping is never limited,
      // 04 §12) and skips when the server takes all of it. Test mode only, because it is a flood.
      const { w } = await fresh(ctx);
      const other = await ctx.document();
      for (let i = 0; i < FLOOD; i++)
        w.send({
          t: 'ch.open',
          ch: 1,
          id: `f${i}`,
          d: { kind: 'doc', doc: other, engine: 'pm-steps/1', cdm: 1, features: [] },
        });
      const limited = await w.arrives(
        (m) => m.t === 'error' && m.d.code === 'rate_limited',
        ctx.timeoutMs,
      );
      if (!limited) ctx.skip(`the server answered ${FLOOD} messages in a burst without a limit`);
      socketError(
        await w.next((m) => m.t === 'error' && m.d.code === 'rate_limited', 'a rate_limited error'),
        'rate_limited',
      );
    },
  },
  {
    code: 'rate_limited',
    surface: 'sync',
    how: 'a spent CPU budget in a room (the tenant quota roomCpuBudget set to 0)',
    needs: { testMode: true },
    async run(ctx) {
      const doc = await ctx.document();
      const m = await joinWhenAvailable(ctx, 'cpu', doc, 'editor');
      await withQuota(ctx, { roomCpuBudget: 0 }, async () => {
        syncReject(
          await submit(m.wire, m.ch, {
            base: m.content.seq,
            steps: [insertText(posIn(m.content.doc, IDS.intro), 'x')],
          }),
          'rate_limited',
        );
      });
      await m.wire.close();
    },
  },
  {
    code: 'rate_limited',
    surface: 'rest',
    how: 'a replacement of the content while the room CPU budget is spent',
    needs: { testMode: true },
    async run(ctx) {
      const doc = await ctx.document();
      await withQuota(ctx, { roomCpuBudget: 0 }, async () => {
        restProblem(await replaceContent(ctx, doc), 'rate_limited', 'a spent CPU budget');
      });
    },
  },
  {
    code: 'quota_exceeded',
    surface: 'socket',
    how: 'a hello over the connection quota of the tenant (set to 0)',
    needs: { testMode: true },
    async run(ctx) {
      const doc = await ctx.document();
      const { token } = await ctx.token('quota', { [doc]: 'editor' });
      await withQuota(ctx, { connections: 0 }, async () => {
        const w = await ctx.connect({ label: 'registry' });
        w.send({
          t: 'hello',
          id: 'h',
          d: { ...HELLO_BASE, token, features: ctx.clientFeatures() },
        });
        socketError(await firstError(ctx, w), 'quota_exceeded');
      });
    },
  },
  {
    code: 'quota_exceeded',
    surface: 'sync',
    how: 'a commit over the commit-rate quota of the tenant (set to 0)',
    needs: { testMode: true },
    async run(ctx) {
      const doc = await ctx.document();
      const m = await joinWhenAvailable(ctx, 'rate', doc, 'editor');
      await withQuota(ctx, { commitRate: 0 }, async () => {
        syncReject(
          await submit(m.wire, m.ch, {
            base: m.content.seq,
            steps: [insertText(posIn(m.content.doc, IDS.intro), 'x')],
          }),
          'quota_exceeded',
        );
      });
      await m.wire.close();
    },
  },
  {
    code: 'quota_exceeded',
    surface: 'rest',
    how: 'a replacement of the content over the commit-rate quota of the tenant (set to 0)',
    needs: { testMode: true },
    async run(ctx) {
      const doc = await ctx.document();
      await withQuota(ctx, { commitRate: 0 }, async () => {
        restProblem(await replaceContent(ctx, doc), 'quota_exceeded', 'a spent commit-rate quota');
      });
    },
  },
  {
    code: 'unavailable',
    surface: 'socket',
    how: 'a ch.open while the store is unreachable (the database hook)',
    needs: { testMode: true },
    async run(ctx) {
      requireHooks(ctx);
      const doc = await ctx.document();
      const { token } = await ctx.token('down', { [doc]: 'editor' });
      const w = await ctx.connect({ label: 'registry' });
      await ctx.hello(w, token);
      await withDatabaseDown(ctx, async () => {
        const reply = await openChannel(ctx, w, 1, doc);
        socketError(reply, 'unavailable');
      });
    },
  },
  {
    code: 'unavailable',
    surface: 'rest',
    how: 'a replacement of the content while the store is unreachable (the database hook)',
    needs: { testMode: true },
    async run(ctx) {
      requireHooks(ctx);
      const doc = await ctx.document();
      await withDatabaseDown(ctx, async () => {
        restProblem(
          await replaceContent(ctx, doc),
          'unavailable',
          'a replacement of the content while the database is down',
        );
      });
    },
  },
  {
    code: 'unavailable',
    surface: 'sync',
    how: 'a commit whose log write fails (the fail-next-write hook)',
    needs: { testMode: true },
    async run(ctx) {
      requireHooks(ctx);
      const doc = await ctx.document();
      const m = await joinWhenAvailable(ctx, 'write', doc, 'editor');
      expectStatus(
        await hook(ctx, 'POST', `/documents/${doc}/fail-next-write`, { at: 'before-insert' }),
        204,
        'fail-next-write',
      );
      syncReject(
        await submit(m.wire, m.ch, {
          base: m.content.seq,
          steps: [insertText(posIn(m.content.doc, IDS.intro), 'x')],
        }),
        'unavailable',
      );
      await m.wire.close();
    },
  },
  {
    code: 'unavailable',
    surface: 'channel-close',
    how: 'a room that is killed under an open channel (the kill-room hook)',
    needs: { testMode: true },
    async run(ctx) {
      requireHooks(ctx);
      const doc = await ctx.document();
      const m = await joinWhenAvailable(ctx, 'fenced', doc, 'editor');
      const from = m.wire.mark();
      expectStatus(await hook(ctx, 'POST', `/documents/${doc}/kill-room`), 200, 'kill-room');
      const closed = await m.wire.next<Extract<ServerMessage, { t: 'ch.closed' }>>(
        (x) => x.t === 'ch.closed' && x.ch === m.ch,
        'ch.closed on the killed room',
        { from },
      );
      equal(closed.d.code, 'unavailable', 'the ch.closed code');
      includes(
        retryHint('unavailable').surfaces as string[],
        'channel-close',
        'unavailable may close a channel (05 §5.8)',
      );
      await m.wire.close();
    },
  },
  {
    code: 'internal',
    surface: 'rest',
    how: 'a server failure',
    unreachable: 'needs fault injection (PRO-126; BE-079)',
  },
  {
    code: 'slow_consumer',
    surface: 'channel-close',
    how: 'a client that does not read',
    unreachable: 'needs a socket that stops reading for longer than the server buffers; PRO-126',
  },
];

/** Codes the kit provokes or names as unreachable, by surface: the PRO-117 check uses it. */
export const PROVOKED: ReadonlyArray<{ code: string; surface: Surface; unreachable?: string }> =
  PROVOCATIONS.map((p) => ({
    code: p.code,
    surface: p.surface,
    ...(p.unreachable ? { unreachable: p.unreachable } : {}),
  }));

export const REGISTRY_PROFILE: ProfileDef = {
  id: 'registry',
  title: 'Every rejection code of the error registry, with its surface and retry hint',
  spec: '05 §5.7, §5.8; D25, D61',
  stories: ['PRO-115'],
  requires: { kind: 'mode', mode: 'authority' },
  scenarios: PROVOCATIONS.map((p) =>
    scenario('registry', {
      id: `${p.code}.${p.surface}`,
      title: `${p.code} on ${p.surface}: ${p.how}`,
      spec: '05 §5.8',
      covers: { errors: p.unreachable ? [] : [p.code] },
      ...(p.needs ? { needs: p.needs } : {}),
      async run(ctx) {
        if (p.unreachable || !p.run) return ctx.skip(p.unreachable ?? 'no provocation');
        await p.run(ctx);
      },
    }),
  ),
};
