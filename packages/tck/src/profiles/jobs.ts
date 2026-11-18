/**
 * The `exports` and `assets` profiles (PRO-114; 05 §6.2; 09 §9.1; D68, D69). Exports: `202` with a
 * job, the states in order, progress, a terminal state, cancellation, and the identifier checks.
 * Assets: the upload through quarantine, completion, `asset.ready` and `asset.failed`, short-lived
 * URLs, and refusal for callers of another document. The asset upload descriptor is a placeholder
 * in the definition (G72): the kit follows its one named member, `upload.url`.
 */
import type { ExportJob, ServerMessage } from '@docedit/protocol';
import { KitFailure, check, equal, includes, isObject, oneOf } from '../assert.ts';
import { shapeViolations, type ScenarioContext } from '../context.ts';
import { IDS, paragraph, withBody } from '../documents.ts';
import type { HttpResponse } from '../rest.ts';
import { scenario, type ProfileDef, type ScenarioDef } from '../scenario.ts';
import { join, problemOf, type Member } from './support.ts';

const ex = (def: Omit<ScenarioDef, 'id'> & { id: string }) => scenario('exports', def);
const as = (def: Omit<ScenarioDef, 'id'> & { id: string }) => scenario('assets', def);

const ORDER = ['queued', 'converting', 'compiling'];
const TERMINAL = ['completed', 'failed', 'cancelled'];

async function requestExport(
  ctx: ScenarioContext,
  token: string,
  doc: string,
  body: Record<string, unknown> = { target: 'pdf' },
) {
  return ctx.service.as(token, 'POST', `/documents/${doc}/exports`, { body });
}

function jobOf(res: HttpResponse, what: string): ExportJob {
  check(
    res.status === 202,
    `${what}: an export is accepted with 202 (05 §6.2)`,
    202,
    `HTTP ${res.status} ${res.text.slice(0, 300)}`,
  );
  const v = shapeViolations('ExportJob', res.json);
  check(v.length === 0, `${what}: the job matches the published schema (D68)`, 'no violations', v);
  return res.json as ExportJob;
}

async function viewerExport(ctx: ScenarioContext) {
  const doc = await ctx.document();
  const { sub, token } = await ctx.token('exporter', { [doc]: 'viewer' });
  const job = jobOf(await requestExport(ctx, token, doc), 'POST /documents/{id}/exports');
  return { doc, sub, token, job };
}

/** A document with an unresolved suggestion (an `ins` mark with an identifier). */
function withSuggestion() {
  return withBody([
    {
      type: 'paragraph',
      attrs: { id: IDS.intro },
      content: [
        { type: 'text', text: 'Hello ' },
        {
          type: 'text',
          text: 'suggested',
          marks: [{ type: 'ins', attrs: { id: 'sTck000000000001', user: 'tck' } }],
        },
      ],
    },
    paragraph(IDS.end, ''),
  ]);
}

export const EXPORTS: ProfileDef = {
  id: 'exports',
  title: 'Export jobs',
  spec: '05 §6.2; 09 §9.1; D68, D69',
  stories: ['PRO-114'],
  requires: { kind: 'features', features: ['exports'] },
  scenarios: [
    ex({
      id: 'request',
      title: 'POST /documents/{id}/exports answers 202 with a job the requester can read',
      spec: '05 §6.2; D68',
      covers: { operations: ['POST /documents/{id}/exports', 'GET /exports/{jid}'] },
      async run(ctx) {
        const { doc, token, job } = await viewerExport(ctx);
        equal(job.doc, doc, 'the job names its document');
        equal(job.target, 'pdf', 'the target');
        oneOf(job.state, [...ORDER, ...TERMINAL], 'a state of D68');
        const head = (await ctx.service.call('GET', `/documents/${doc}/content`)).json as {
          seq: number;
        };
        equal(job.seq, head.seq, 'seq defaults to the head (D68)');
        const got = await ctx.service.as(token, 'GET', `/exports/${job.id}`);
        equal(got.status, 200, 'GET /exports/{jid} by the requester');
        equal((got.json as ExportJob).id, job.id, 'the same job');
      },
    }),
    ex({
      id: 'states',
      title: 'a job moves through its states in order to a terminal state, with progress',
      spec: '05 §6.2; 09 §9.1; D68',
      timeoutMs: 150_000,
      covers: { operations: ['GET /exports/{jid}'] },
      async run(ctx) {
        const { token, job } = await viewerExport(ctx);
        const seen: string[] = [job.state];
        let last = job;
        let progress = -1;
        const deadline = Date.now() + 120_000;
        while (!TERMINAL.includes(last.state) && Date.now() < deadline) {
          await ctx.sleep(500);
          const r = await ctx.service.as(token, 'GET', `/exports/${job.id}`);
          equal(r.status, 200, 'GET /exports/{jid}');
          last = r.json as ExportJob;
          if (seen.at(-1) !== last.state) seen.push(last.state);
          if (last.progress !== null) {
            check(
              last.progress >= 0 && last.progress <= 100,
              'progress is a percentage (D68)',
              '0 to 100',
              last.progress,
            );
            check(
              last.progress >= progress,
              'progress does not go back',
              `≥ ${progress}`,
              last.progress,
            );
            progress = last.progress;
          }
        }
        const rank = (s: string) => (TERMINAL.includes(s) ? ORDER.length : ORDER.indexOf(s));
        for (let i = 1; i < seen.length; i++)
          check(
            rank(seen[i]!) >= rank(seen[i - 1]!),
            'the states follow the order of D68',
            ORDER.concat('terminal').join(' → '),
            seen.join(' → '),
          );
        if (!TERMINAL.includes(last.state))
          throw new KitFailure(
            'the job reached no terminal state within 120 seconds',
            TERMINAL.join(' or '),
            seen.join(' → '),
          );
        if (last.state === 'completed') {
          check(
            isObject(last.result) && typeof last.result.url === 'string',
            'a completed job has a result URL (D68)',
            'result.url',
            last.result,
          );
          check(
            !('log' in (last.result ?? {})),
            'a viewer gets no raw compile log (07 §12 row 12)',
            'no log',
            last.result,
          );
        }
        if (last.state === 'failed')
          check(isObject(last.error), 'a failed job says why', 'error', last);
      },
    }),
    ex({
      id: 'cancel',
      title:
        'DELETE /exports/{jid} cancels a queued or running job; on a finished job it changes nothing',
      spec: '05 §6.2; D68',
      covers: { operations: ['DELETE /exports/{jid}', 'GET /exports/{jid}'] },
      async run(ctx) {
        const { token, job } = await viewerExport(ctx);
        const del = await ctx.service.as(token, 'DELETE', `/exports/${job.id}`);
        equal(del.status, 204, 'DELETE answers 204 (D68)');
        const after = (await ctx.service.as(token, 'GET', `/exports/${job.id}`)).json as ExportJob;
        oneOf(after.state, TERMINAL, 'the job is finished after DELETE');
        if (after.state !== 'cancelled') ctx.note(`the job had already ended as ${after.state}`);
        const again = await ctx.service.as(token, 'DELETE', `/exports/${job.id}`);
        equal(again.status, 204, 'DELETE of a finished job answers 204');
        equal(
          ((await ctx.service.as(token, 'GET', `/exports/${job.id}`)).json as ExportJob).state,
          after.state,
          'and changes nothing (D68)',
        );
      },
    }),
    ex({
      id: 'identifiers',
      title:
        'a job is not found by another user of the document or by a caller of another document',
      spec: '05 §6.1; D69; review SR-C4',
      covers: {
        operations: ['GET /exports/{jid}', 'DELETE /exports/{jid}'],
        errors: ['not_found'],
      },
      async run(ctx) {
        const { doc, job } = await viewerExport(ctx);
        const { token: colleague } = await ctx.token('colleague', { [doc]: 'owner' });
        equal(
          problemOf(await ctx.service.as(colleague, 'GET', `/exports/${job.id}`), 'another user')
            .code,
          'not_found',
          "another user's job (D69; owner decision 57)",
        );
        equal(
          problemOf(await ctx.service.as(colleague, 'DELETE', `/exports/${job.id}`), 'another user')
            .code,
          'not_found',
          "cancelling another user's job (D69; owner decision 57)",
        );
        const other = await ctx.document();
        const { token: outsider } = await ctx.token('outsider', { [other]: 'owner' });
        const r = await ctx.service.as(outsider, 'GET', `/exports/${job.id}`);
        equal(
          problemOf(r, 'a caller of another document').code,
          'not_found',
          'the token must cover the job document (05 §6.1; owner decision 57)',
        );
        const service = await ctx.service.call('GET', `/exports/${job.id}`);
        equal(service.status, 200, 'a service credential may read any job of its tenant (D69)');
      },
    }),
    ex({
      id: 'refusals',
      title: 'no-export, unresolved suggestions and an unknown target are refused with their codes',
      spec: '05 §6.2; 09 §9.1; D68',
      covers: {
        operations: ['POST /documents/{id}/exports'],
        errors: ['forbidden', 'pending_suggestions', 'validation_failed'],
      },
      async run(ctx) {
        const doc = await ctx.document();
        const { token: restricted } = await ctx.token(
          'restricted',
          { [doc]: 'viewer' },
          { restrict: ['no-export'] },
        );
        const r1 = await requestExport(ctx, restricted, doc);
        equal(
          problemOf(r1, 'no-export').code,
          'forbidden',
          'a caller restricted with no-export (D68)',
        );
        const { token } = await ctx.token('plain', { [doc]: 'viewer' });
        const r2 = await requestExport(ctx, token, doc, { target: 'x-tck' });
        equal(
          problemOf(r2, 'an unknown target').code,
          'validation_failed',
          'an unknown target (D68)',
        );
        const s = await ctx.document(withSuggestion());
        const { token: t3 } = await ctx.token('suggested', { [s]: 'viewer' });
        const r3 = await requestExport(ctx, t3, s);
        equal(
          problemOf(r3, 'pending suggestions').code,
          'pending_suggestions',
          'unresolved suggestions without options.suggestions (05 §6.2)',
        );
        equal(r3.status, 409, 'the HTTP status of pending_suggestions (D61)');
        jobOf(
          await requestExport(ctx, t3, s, { target: 'pdf', options: { suggestions: 'accept' } }),
          'with options.suggestions',
        );
      },
    }),
    ex({
      id: 'notifications',
      title: 'a connected requester is told about the job by event notifications',
      spec: '05 §5.6',
      needs: { features: ['exports'] },
      timeoutMs: 150_000,
      covers: {
        messages: ['event'],
        events: ['export.progress', 'export.completed', 'export.failed', 'export.cancelled'],
      },
      async run(ctx) {
        const doc = await ctx.document();
        const m = await join(ctx, 'notified', doc, 'viewer');
        const from = m.wire.mark();
        const job = jobOf(await requestExport(ctx, m.token, doc), 'POST exports');
        await ctx.service.as(m.token, 'DELETE', `/exports/${job.id}`);
        const pred = (x: ServerMessage) =>
          x.t === 'event' &&
          x.d.type.startsWith('export.') &&
          x.d.resource === `/exports/${job.id}`;
        // Which connections receive which event is not stated (G47): the kit checks the events that
        // arrive and does not fail a server that sends none.
        if (!(await m.wire.arrives(pred, 20_000, from)))
          return ctx.skip(
            'no export notification reached the requester within 20 s; 05 §5.6 does not say which connections receive one (G47)',
          );
        const ev = m.wire.messages.slice(from).find(pred)!;
        if (ev.t === 'event') {
          includes(
            ['export.progress', 'export.completed', 'export.failed', 'export.cancelled'],
            ev.d.type,
            'an export notification type (05 §5.6)',
          );
          equal(ev.d.resource, `/exports/${job.id}`, 'the resource is relative to rest (05 §5.6)');
        }
      },
    }),
  ],
};

/**
 * The longest life the kit accepts for a signed asset URL. The spec says "short-lived" and gives no
 * number (10 §3.7); the kit uses the 15 minute maximum that 05 §3 sets for tokens. The reference
 * service's default is 300 s (DOCEDIT_SIGNED_URL_SECONDS). Proposed in docs/adr/0315-lane-V-PRO-103-119.md decision 1; owner to confirm.
 */
const SHORT_LIVED_MS = 15 * 60_000;

/** A valid PNG of one grey pixel. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

export async function upload(
  ctx: ScenarioContext,
  token: string,
  doc: string,
  bytes: Buffer,
  mime: string,
) {
  const res = await ctx.service.as(token, 'POST', `/documents/${doc}/assets`, {
    body: { filename: 'tck.png', mime, size: bytes.length },
  });
  check(
    res.status === 200 || res.status === 201,
    'POST /documents/{id}/assets',
    '200 or 201',
    `HTTP ${res.status} ${res.text.slice(0, 200)}`,
  );
  const v = shapeViolations('AssetUpload', res.json);
  check(
    v.length === 0,
    'the upload descriptor matches the published schema (G72)',
    'no violations',
    v,
  );
  const d = res.json as {
    asset: string;
    upload: { url: string; method?: string; headers?: Record<string, string> };
  };
  const put = await fetch(d.upload.url, {
    method: d.upload.method ?? 'PUT',
    headers: { 'content-type': mime, ...d.upload.headers },
    body: bytes,
  });
  check(
    put.status >= 200 && put.status < 300,
    'the upload into quarantine succeeds',
    '2xx',
    put.status,
  );
  const done = await ctx.service.as(token, 'POST', `/assets/${d.asset}/complete`);
  equal(done.status, 202, 'POST /assets/{aid}/complete starts the check (D61)');
  return d.asset;
}

/**
 * How long the kit waits for `asset.ready` or `asset.failed`. 05 and 06 give no bound for the check.
 * Lane U-PRO-103-119 (PRO-114 leftover): a run on a heavily loaded host may need longer, so the
 * budget can be raised with DOCEDIT_TCK_ASSET_WAIT_MS (milliseconds); the default is unchanged.
 */
export const ASSET_EVENT_WAIT_MS = (() => {
  const raw = process.env['DOCEDIT_TCK_ASSET_WAIT_MS'];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 150_000;
})();
/** The token is refreshed this often while waiting: within the 60 s test-mode token (ADR 0315 item 4). */
const REFRESH_EVERY_MS = 25_000;

/**
 * Waits for an asset event on the member's connection and keeps its token fresh while it waits
 * (05 §3.1 `auth.refresh`). The check runs in a sandbox and can outlast one token, which would close
 * the connection (4401) before the event arrives. Returns the last token, for the calls that follow.
 */
export async function awaitAssetEvent(
  ctx: ScenarioContext,
  m: Member,
  doc: string,
  type: 'asset.ready' | 'asset.failed',
  aid: string,
  from: number,
): Promise<string> {
  const pred = (x: ServerMessage) =>
    x.t === 'event' && x.d.type === type && x.d.resource.endsWith(aid);
  const deadline = Date.now() + ASSET_EVENT_WAIT_MS;
  for (;;) {
    const token = await ctx.service.token(m.sub, { [doc]: 'editor' });
    const refreshed = await m.wire.request({ t: 'auth.refresh', d: { token } });
    equal(refreshed.reply.t, 'auth.ok', `auth.refresh while waiting for ${type}`);
    const left = deadline - Date.now();
    if (await m.wire.arrives(pred, Math.max(0, Math.min(REFRESH_EVERY_MS, left)), from))
      return token;
    const shut = m.wire.messages
      .slice(from)
      .find((x) => (x.t === 'ch.closed' && x.ch === m.ch) || (x.t === 'error' && x.d.fatal));
    if (shut)
      throw new KitFailure(
        `${type} did not arrive: the server ended the channel while the kit waited`,
        type,
        JSON.stringify(shut),
      );
    if (Date.now() >= deadline) {
      await m.wire.next(pred, type, { from, timeoutMs: 0 });
      return token;
    }
  }
}

export const ASSETS: ProfileDef = {
  id: 'assets',
  title: 'Asset upload through quarantine and signed URLs',
  spec: '05 §6.2; 06 §4.4; 10 §3.7',
  stories: ['PRO-114'],
  requires: { kind: 'features', features: ['assets'] },
  scenarios: [
    as({
      id: 'ready',
      title: 'an upload is checked, raises asset.ready and resolves to a short-lived URL',
      spec: '05 §5.6, §6.2',
      timeoutMs: ASSET_EVENT_WAIT_MS + 60_000,
      covers: {
        operations: [
          'POST /documents/{id}/assets',
          'POST /assets/{aid}/complete',
          'POST /documents/{id}/assets/resolve',
        ],
        events: ['asset.ready'],
      },
      async run(ctx) {
        const doc = await ctx.document();
        const m = await join(ctx, 'uploader', doc, 'editor');
        // Quarantine: bytes sent into the quarantine area but never completed are not ready, so
        // the asset gets no URL (a refusal or an answer without it; 05 §6.2 does not say which).
        const pending = await ctx.service.as(m.token, 'POST', `/documents/${doc}/assets`, {
          body: { filename: 'tck-pending.png', mime: 'image/png', size: PNG.length },
        });
        check(
          pending.status === 200 || pending.status === 201,
          'POST /documents/{id}/assets for an upload that is never completed',
          '200 or 201',
          `HTTP ${pending.status}`,
        );
        const held = pending.json as {
          asset: string;
          upload: { url: string; method?: string; headers?: Record<string, string> };
        };
        const pendingId = held.asset;
        const sent = await fetch(held.upload.url, {
          method: held.upload.method ?? 'PUT',
          headers: { 'content-type': 'image/png', ...held.upload.headers },
          body: PNG,
        });
        check(
          sent.status >= 200 && sent.status < 300,
          'the bytes reach the quarantine area',
          '2xx',
          sent.status,
        );
        const early = await ctx.service.as(m.token, 'POST', `/documents/${doc}/assets/resolve`, {
          body: { assets: [pendingId] },
        });
        check(
          early.status === 200 || (early.status >= 400 && early.status < 500),
          'resolve of a quarantined asset answers or refuses',
          '200 or 4xx',
          `HTTP ${early.status}`,
        );
        check(
          early.status !== 200 || !JSON.stringify(early.json).includes(pendingId),
          'a quarantined asset gets no URL until it is ready (PRO-062, 05 §6.2)',
          'no URL for the quarantined asset',
          early.json,
        );
        const from = m.wire.mark();
        const aid = await upload(ctx, m.token, doc, PNG, 'image/png');
        // The test-mode token lives 60 s and the check runs in a container, so the wait can outlast
        // the token: it is refreshed while waiting, so the wire and the resolve stay valid.
        const next = await awaitAssetEvent(ctx, m, doc, 'asset.ready', aid, from);
        const res = await ctx.service.as(next, 'POST', `/documents/${doc}/assets/resolve`, {
          body: { assets: [aid] },
        });
        equal(res.status, 200, 'resolve');
        check(
          JSON.stringify(res.json).includes('http'),
          'resolve returns signed URLs (05 §6.2)',
          'a URL',
          res.json,
        );
        const signed =
          (res.json as { assets?: Array<{ asset: string; url: string; expiresAt: string }> })
            .assets ?? [];
        check(
          signed.some((u) => u.asset === aid),
          'the ready asset is resolved',
          aid,
          res.json,
        );
        const now = Date.now();
        for (const u of signed) {
          check(
            typeof u.url === 'string' && /^https?:\/\//.test(u.url),
            'each resolved entry has a URL (05 §6.2)',
            'an http or https URL',
            u,
          );
          const aheadMs = Date.parse(u.expiresAt) - now;
          check(
            aheadMs > 0 && aheadMs <= SHORT_LIVED_MS,
            'each signed URL expires in the future and within the short-lived bound (10 §3.7; ADR 0315)',
            `expiresAt in (now, now + ${SHORT_LIVED_MS} ms]`,
            u.expiresAt,
          );
        }
      },
    }),
    as({
      id: 'failed',
      title: 'an upload whose bytes do not match its type raises asset.failed',
      spec: '05 §5.6, §6.2',
      timeoutMs: ASSET_EVENT_WAIT_MS + 60_000,
      covers: { events: ['asset.failed'] },
      async run(ctx) {
        const doc = await ctx.document();
        const m = await join(ctx, 'mismatch', doc, 'editor');
        const from = m.wire.mark();
        const aid = await upload(
          ctx,
          m.token,
          doc,
          Buffer.from('this is not a picture'),
          'image/png',
        );
        // As in `ready`: the check can outlast the 60 s test-mode token, so it is refreshed while waiting.
        await awaitAssetEvent(ctx, m, doc, 'asset.failed', aid, from);
      },
    }),
    as({
      id: 'other-document',
      title: 'a caller of another document can neither complete nor resolve the asset',
      spec: '05 §6.1, §6.2',
      covers: {
        operations: ['POST /assets/{aid}/complete', 'POST /documents/{id}/assets/resolve'],
        errors: ['not_found'],
      },
      async run(ctx) {
        const doc = await ctx.document();
        const { token } = await ctx.token('owner', { [doc]: 'editor' });
        const res = await ctx.service.as(token, 'POST', `/documents/${doc}/assets`, {
          body: { filename: 'x.png', mime: 'image/png', size: PNG.length },
        });
        const aid = (res.json as { asset: string }).asset;
        const other = await ctx.document();
        const { token: outsider } = await ctx.token('outsider', { [other]: 'editor' });
        equal(
          problemOf(
            await ctx.service.as(outsider, 'POST', `/assets/${aid}/complete`),
            'another document',
          ).code,
          'not_found',
          'completing an asset of another document (owner decision 57)',
        );
        const r = await ctx.service.as(outsider, 'POST', `/documents/${other}/assets/resolve`, {
          body: { assets: [aid] },
        });
        check(
          r.status >= 400 ||
            !JSON.stringify(r.json).includes(aid) ||
            !JSON.stringify(r.json).includes('http'),
          'an asset of another document is not resolved',
          'a refusal or no URL',
          r.json,
        );
      },
    }),
  ],
};
