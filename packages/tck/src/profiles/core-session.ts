/**
 * The `core` profile, part 1 (PRO-111 criteria 1 and 2): discovery, minted tokens, CORS, framing and
 * the session (05 §2 to §5.1, §5.7).
 */
import { chunkMessage, utf8Length, type ServerMessage } from '@docedit/protocol';
import { isTimestamp, isUuid7, uuid7 } from '@docedit/model';
import { KitFailure, check, equal, includes, jsonEqual, oneOf } from '../assert.ts';
import { HELLO_BASE, shapeViolations, type ScenarioContext } from '../context.ts';
import { IDS, insertText, posIn } from '../documents.ts';
import { ALLOWED_ALGS, verifyJws } from '../jwt.ts';
import { scenario, type ScenarioDef } from '../scenario.ts';
import type { Wire } from '../wire.ts';
import { claimsOf, openChannel, opened, problemOf } from './support.ts';

const s = (def: Omit<ScenarioDef, 'id'> & { id: string }) => scenario('core', def);

const LIMITS = [
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
] as const;

/** The close codes of 05 §5.7. */
export const CLOSE_CODES = [4400, 4401, 4403, 4406, 4408, 4413, 4429, 4500, 4503];

const RELAY_FORBIDDEN = ['regions', 'suggest-enforced', 'fields'];
const REFUSED_ORIGIN = 'https://refused.tck.invalid';

/** Expects a fatal close with `code`, preceded by an `error` with `errorCode` when one is sent (D25). */
async function expectFatal(
  ctx: ScenarioContext,
  w: Wire,
  code: number,
  errorCode: string,
  what: string,
) {
  const closed = await w.closes(what, ctx.timeoutMs);
  ctx.closeCode(closed.code);
  equal(closed.code, code, `${what}: the close code (05 §5.7)`);
  const err = w.messages.find((m) => m.t === 'error');
  if (err && err.t === 'error') {
    equal(err.d.code, errorCode, `${what}: the error before the close (05 §5.8; D25)`);
    equal(err.d.fatal, true, `${what}: the error is fatal (05 §5.1)`);
  } else
    ctx.note(`${what}: no error message preceded close ${closed.code} (the error is optional)`);
}

async function welcomed(ctx: ScenarioContext, name = 'user') {
  const doc = await ctx.document();
  return { doc, ...(await ctx.session(name, { [doc]: 'editor' })) };
}

export const CORE_SESSION: ScenarioDef[] = [
  s({
    id: 'discovery.shape',
    title: 'discovery has every member of 05 §2 with its type, without a credential',
    spec: '05 §2; D66',
    covers: { operations: ['GET /.well-known/dep'] },
    async run(ctx) {
      const res = await ctx.target.http.request('GET', ctx.target.discoveryUrl);
      equal(res.status, 200, 'GET /.well-known/dep without a credential (D66)');
      check(
        (res.headers.get('content-type') ?? '').startsWith('application/json'),
        'discovery is JSON',
        'application/json',
        res.headers.get('content-type'),
      );
      const v = shapeViolations('Discovery', res.json);
      check(
        v.length === 0,
        'discovery matches the published schema (every member is required, D66)',
        'no violations',
        v,
      );
      const d = ctx.target.discovery;
      includes(d.versions, '1.0', 'versions');
      oneOf(new URL(d.ws).protocol, ['ws:', 'wss:'], 'ws is a WebSocket URL');
      oneOf(new URL(d.rest).protocol, ['http:', 'https:'], 'rest is a complete URL (05 §2)');
      includes(d.engines, 'pm-steps/1', 'engines');
      check(
        d.cdm.min <= 1 && d.cdm.max >= 1,
        'the cdm range includes 1',
        '{ min ≤ 1 ≤ max }',
        d.cdm,
      );
      equal(new Set(d.features).size, d.features.length, 'features are unique');
      for (const f of d.features)
        check(
          /^(x-)?[a-z][a-z0-9-]*$/.test(f),
          'a feature name (05 §1; G01)',
          '^(x-)?[a-z][a-z0-9-]*$',
          f,
        );
      oneOf(d.mode, ['authority', 'relay'], 'mode');
      if (d.mode === 'relay')
        for (const f of RELAY_FORBIDDEN)
          check(
            !d.features.includes(f),
            `a relay never announces ${f} (05 §2)`,
            'absent',
            d.features,
          );
      check(/^https?:\/\//.test(d.jwks_uri), 'jwks_uri is a URL', 'an http(s) URL', d.jwks_uri);
      const again = await ctx.target.http.request('GET', ctx.target.discoveryUrl);
      jsonEqual(again.json, res.json, 'discovery is the same on every read (D66)');
    },
  }),
  s({
    id: 'discovery.no-test-switch',
    title: 'discovery and welcome reveal nothing that switches test mode on',
    spec: '05 §11; PRO-109 criterion 4',
    covers: { operations: ['GET /.well-known/dep'], messages: ['hello', 'welcome'] },
    async run(ctx) {
      const known = ['versions', 'ws', 'rest', 'engines', 'cdm', 'features', 'mode', 'jwks_uri'];
      const d = (await ctx.target.http.request('GET', ctx.target.discoveryUrl)).json as Record<
        string,
        unknown
      >;
      const extra = Object.keys(d).filter((k) => !known.includes(k));
      const suspicious = /test|debug|fault|hook|clock|fake/i;
      check(
        !extra.some((k) => suspicious.test(k)),
        'no discovery member names a test switch',
        'none',
        extra,
      );
      const text = JSON.stringify(d);
      check(
        !/test-?mode|x-test/i.test(text),
        'no discovery value names a test switch',
        'none',
        text,
      );
      const w = await welcomed(ctx);
      check(
        !w.welcome.features.some((f) => suspicious.test(f)),
        'no announced feature is a test switch',
        'none',
        w.welcome.features,
      );
      if (ctx.config.testMode) ctx.note('checked with the test-mode switch on');
    },
  }),
  s({
    id: 'tokens.claims',
    title: 'POST /tokens mints a signed token with the claims of 05 §3.1',
    spec: '05 §3.1; D60',
    covers: { operations: ['POST /tokens'] },
    async run(ctx) {
      const doc = await ctx.document();
      const sub = ctx.sub('claims');
      const before = Math.floor(Date.now() / 1000);
      const minted = await ctx.service.mint({
        sub,
        docs: { [doc]: 'commenter' },
        name: 'Claire',
        grp: ['legal'],
      });
      check(
        isTimestamp(minted.expiresAt),
        'expiresAt is an RFC 3339 timestamp (D60)',
        'a timestamp',
        minted.expiresAt,
      );
      const { header, payload } = claimsOf(minted.token);
      oneOf(
        header['alg'] as string,
        ALLOWED_ALGS,
        'the signing algorithm is on the allow-list (05 §3.1)',
      );
      for (const k of ['iss', 'aud', 'jti', 'tid', 'sub'])
        check(
          typeof payload[k] === 'string' && (payload[k] as string).length > 0,
          `claim ${k} (05 §3.1)`,
          'a string',
          payload[k],
        );
      for (const k of ['iat', 'exp'])
        check(Number.isSafeInteger(payload[k]), `claim ${k}`, 'a NumericDate', payload[k]);
      equal(payload['sub'], sub, 'sub');
      jsonEqual(payload['docs'], { [doc]: 'commenter' }, 'docs');
      equal(payload['name'], 'Claire', 'name');
      jsonEqual(payload['grp'], ['legal'], 'grp');
      equal(
        payload['aud'],
        payload['iss'],
        'the service sets iss and aud to its own identifier (D60)',
      );
      const iat = payload['iat'] as number;
      const exp = payload['exp'] as number;
      check(
        exp - iat <= 900,
        'exp is at most 15 minutes after iat (05 §3.1)',
        '≤ 900 s',
        exp - iat,
      );
      check(Math.abs(iat - before) <= 60, 'iat is the time of minting (60 s skew)', before, iat);
      equal(Math.floor(Date.parse(minted.expiresAt) / 1000), exp, 'expiresAt is exp (D60)');
      const jwks = await ctx.target.http.request('GET', ctx.target.discovery.jwks_uri);
      equal(jwks.status, 200, 'GET jwks_uri');
      const v = await verifyJws(minted.token, jwks.json);
      check(
        v.ok,
        'the token verifies with a key published at jwks_uri (D60)',
        'a valid signature',
        v.reason,
      );
      const second = claimsOf(
        (await ctx.service.mint({ sub, docs: { [doc]: 'commenter' } })).token,
      ).payload;
      check(second['jti'] !== payload['jti'], 'every token has its own jti', 'two identifiers', [
        payload['jti'],
        second['jti'],
      ]);
    },
  }),
  s({
    id: 'tokens.lifetime',
    title: 'expiresIn sets the lifetime, never above 15 minutes',
    spec: '05 §3.1; D60',
    covers: { operations: ['POST /tokens'], errors: ['validation_failed'] },
    async run(ctx) {
      const doc = await ctx.document();
      const short = claimsOf(
        (
          await ctx.service.mint({
            sub: ctx.sub('short'),
            docs: { [doc]: 'viewer' },
            expiresIn: 60,
          })
        ).token,
      ).payload;
      equal((short['exp'] as number) - (short['iat'] as number), 60, 'exp - iat for expiresIn 60');
      const dflt = claimsOf(
        (await ctx.service.mint({ sub: ctx.sub('default'), docs: { [doc]: 'viewer' } })).token,
      ).payload;
      check(
        (dflt['exp'] as number) - (dflt['iat'] as number) <= 900,
        'the default lifetime is at most 900 s',
        '≤ 900',
        dflt,
      );
      const long = await ctx.service.call('POST', '/tokens', {
        body: { sub: ctx.sub('long'), docs: { [doc]: 'viewer' }, expiresIn: 901 },
      });
      equal(
        problemOf(long, 'expiresIn 901').code,
        'validation_failed',
        'a lifetime above 15 minutes is refused (D60)',
      );
    },
  }),
  s({
    id: 'tokens.docs-limit',
    title: 'a token names at most 20 documents',
    spec: '05 §3.1; D74',
    covers: { operations: ['POST /tokens'], errors: ['validation_failed'] },
    async run(ctx) {
      const docs: Record<string, 'viewer'> = {};
      for (let i = 0; i < 21; i++) docs[uuid7()] = 'viewer';
      const res = await ctx.service.call('POST', '/tokens', {
        body: { sub: ctx.sub('many'), docs },
      });
      equal(
        problemOf(res, '21 documents').code,
        'validation_failed',
        'more than 20 documents in docs',
      );
      equal(res.status, 400, 'the HTTP status of validation_failed (D61)');
    },
  }),
  s({
    id: 'cors.preflight',
    title: 'a preflight from an allowed origin gets the allowed headers and methods',
    spec: '05 §6.1; D66',
    needs: { origin: true },
    covers: {},
    async run(ctx) {
      const origin = ctx.config.origin!;
      const doc = await ctx.document();
      const res = await ctx.target.http.request(
        'OPTIONS',
        ctx.service.url(`/documents/${doc}/content`),
        {
          headers: {
            origin,
            'access-control-request-method': 'GET',
            'access-control-request-headers':
              'authorization, content-type, if-match, idempotency-key, dep-actor, traceparent',
          },
        },
      );
      check(
        res.status === 200 || res.status === 204,
        'the preflight succeeds',
        '200 or 204',
        res.status,
      );
      equal(res.headers.get('access-control-allow-origin'), origin, 'Access-Control-Allow-Origin');
      const allowed = (res.headers.get('access-control-allow-headers') ?? '')
        .toLowerCase()
        .split(/\s*,\s*/);
      for (const h of [
        'authorization',
        'content-type',
        'if-match',
        'idempotency-key',
        'dep-actor',
        'traceparent',
      ])
        includes(allowed, h, `the allowed headers include ${h} (05 §6.1)`);
      const methods = (res.headers.get('access-control-allow-methods') ?? '')
        .toUpperCase()
        .split(/\s*,\s*/);
      includes(methods, 'GET', 'the allowed methods include GET');
    },
  }),
  s({
    id: 'cors.expose',
    title: 'a response to an allowed origin exposes ETag, Retry-After, Deprecation and Sunset',
    spec: '05 §6.1; D71',
    needs: { origin: true },
    covers: { operations: ['GET /documents/{id}/content'] },
    async run(ctx) {
      const origin = ctx.config.origin!;
      const doc = await ctx.document();
      const { token } = await ctx.token('cors', { [doc]: 'viewer' });
      const res = await ctx.service.as(token, 'GET', `/documents/${doc}/content`, {
        headers: { origin },
      });
      equal(res.status, 200, 'GET content as a viewer');
      equal(res.headers.get('access-control-allow-origin'), origin, 'Access-Control-Allow-Origin');
      const exposed = (res.headers.get('access-control-expose-headers') ?? '')
        .toLowerCase()
        .split(/\s*,\s*/);
      for (const h of ['etag', 'retry-after', 'deprecation', 'sunset'])
        includes(exposed, h, `the exposed headers include ${h} (05 §6.1)`);
      if (!exposed.includes('dep-request-id'))
        ctx.note('DEP-Request-Id is not exposed (D71 adds it)');
    },
  }),
  s({
    id: 'cors.refused',
    title: 'an origin no tenant allows is granted nothing',
    spec: '05 §6.1; D66',
    covers: {},
    async run(ctx) {
      const doc = await ctx.document();
      const res = await ctx.target.http.request(
        'OPTIONS',
        ctx.service.url(`/documents/${doc}/content`),
        {
          headers: { origin: REFUSED_ORIGIN, 'access-control-request-method': 'GET' },
        },
      );
      check(
        res.headers.get('access-control-allow-origin') !== REFUSED_ORIGIN &&
          res.headers.get('access-control-allow-origin') !== '*',
        'a refused origin gets no Access-Control-Allow-Origin',
        'no grant',
        res.headers.get('access-control-allow-origin'),
      );
    },
  }),
  s({
    id: 'session.welcome',
    title: 'hello is answered by welcome with the session, the user, the features and every limit',
    spec: '05 §5.1',
    covers: { messages: ['hello', 'welcome'], fields: ['hello.traceparent'] },
    async run(ctx) {
      const doc = await ctx.document();
      const minted = await ctx.service.mint({
        sub: ctx.sub('welcome'),
        docs: { [doc]: 'editor' },
        name: 'Wendy',
      });
      const w = await ctx.connect({ label: 'welcome' });
      const id = w.nextId('hello');
      w.send({
        t: 'hello',
        id,
        d: {
          ...HELLO_BASE,
          token: minted.token,
          features: ctx.clientFeatures(),
          traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        },
      });
      const reply = await w.reply(id);
      if (reply.t !== 'welcome') throw new KitFailure('hello was not welcomed', 'welcome', reply);
      equal(reply.re, id, 'welcome carries re (05 §4)');
      const d = reply.d;
      equal(d.version, '1.0', 'the version chosen');
      check(
        isUuid7(d.session),
        'the session identifier is a UUID version 7',
        'a UUID v7',
        d.session,
      );
      check(
        typeof d.user.id === 'string' && d.user.id.length > 0,
        'user.id',
        'a non-empty identifier',
        d.user,
      );
      for (const k of LIMITS)
        check(
          Number.isSafeInteger(d.limits[k]) && d.limits[k] >= 0,
          `limit ${k} (05 §5.1)`,
          'a non-negative integer',
          d.limits[k],
        );
      check(
        isTimestamp(d.tokenExp),
        'tokenExp is an RFC 3339 timestamp (G26)',
        'a timestamp',
        d.tokenExp,
      );
      equal(
        Math.floor(Date.parse(d.tokenExp) / 1000),
        Math.floor(Date.parse(minted.expiresAt) / 1000),
        'tokenExp is the token expiry',
      );
      const missing = d.features.filter((f) => !ctx.target.features.has(f));
      if (missing.length)
        ctx.note(`welcome announces features discovery does not: ${missing.join(', ')}`);
      const other = await ctx.session('welcome2', { [doc]: 'viewer' });
      check(
        other.welcome.session !== d.session,
        'a new session identifier for every connection (05 §5.1)',
        'distinct',
        other.welcome.session,
      );
    },
  }),
  s({
    id: 'session.hello-first',
    title: 'a first message other than hello ends the connection',
    spec: '05 §5.1',
    covers: { messages: ['ping'] },
    async run(ctx) {
      const w = await ctx.connect({ label: 'no-hello' });
      w.send({ t: 'ping', id: 'p1' });
      const closed = await w.closes('a ping before hello', ctx.timeoutMs);
      ctx.closeCode(closed.code);
      oneOf(closed.code, CLOSE_CODES, 'a close code of 05 §5.7');
      if (closed.code !== 4400)
        ctx.note(`closed with ${closed.code}; 4400 (malformed) is the reading of D03`);
    },
  }),
  s({
    id: 'close.4400',
    title: 'a frame that is not a JSON object with a type closes the connection with 4400',
    spec: '05 §4, §5.7; D03',
    covers: { closeCodes: [4400], errors: ['bad_message'], messages: ['error'] },
    async run(ctx) {
      const doc = await ctx.document();
      for (const frame of ['not json', '[1,2,3]', '{"d":{}}', '{"t":7}', '{"t":"ping","ch":-1}']) {
        const { token } = await ctx.token('malformed', { [doc]: 'viewer' });
        const w = await ctx.connect({ label: 'malformed' });
        await ctx.hello(w, token);
        w.sendText(frame);
        await expectFatal(ctx, w, 4400, 'bad_message', `the frame ${frame}`);
      }
    },
  }),
  s({
    id: 'close.4401',
    title: 'an invalid or revoked token is refused with 4401',
    spec: '05 §3.3, §5.7',
    covers: {
      closeCodes: [4401],
      errors: ['unauthenticated', 'revoked'],
      operations: ['POST /sessions/revoke'],
    },
    async run(ctx) {
      const w = await ctx.connect({ label: 'bad-token' });
      w.send({ t: 'hello', id: 'h1', d: { ...HELLO_BASE, token: 'not-a-token', features: [] } });
      await expectFatal(ctx, w, 4401, 'unauthenticated', 'a token that is not a JWT');
      const doc = await ctx.document();
      const { sub, token } = await ctx.token('revoked', { [doc]: 'viewer' });
      await ctx.sleep(1100); // the watermark has whole seconds; a token minted after it must still work
      await ctx.service.revoke(sub);
      const r = await ctx.connect({ label: 'revoked' });
      r.send({ t: 'hello', id: 'h2', d: { ...HELLO_BASE, token, features: [] } });
      await expectFatal(ctx, r, 4401, 'revoked', 'a token issued before the revocation (05 §3.3)');
    },
  }),
  s({
    id: 'close.4403',
    title: 'a disallowed Origin is refused with 4403 when hello names the tenant',
    spec: '05 §4, §5.7; 10 §3.2',
    covers: { closeCodes: [4403], errors: ['forbidden'] },
    async run(ctx) {
      const doc = await ctx.document();
      const { token } = await ctx.token('origin', { [doc]: 'viewer' });
      const w = await ctx.connect({ label: 'refused-origin', origin: REFUSED_ORIGIN });
      w.send({ t: 'hello', id: 'h1', d: { ...HELLO_BASE, token, features: [] } });
      await expectFatal(ctx, w, 4403, 'forbidden', 'a disallowed origin');
      if (ctx.config.origin) {
        const ok = await ctx.connect({ label: 'allowed-origin', origin: ctx.config.origin });
        await ctx.hello(ok, (await ctx.token('origin-ok', { [doc]: 'viewer' })).token);
      } else ctx.note('the allowed half needs --origin');
    },
  }),
  s({
    id: 'close.4406',
    title: 'no common version: error unsupported_version with the server versions, then 4406',
    spec: '05 §1, §5.1, §5.7; D06',
    covers: { closeCodes: [4406], errors: ['unsupported_version'], fields: ['error.versions'] },
    async run(ctx) {
      const doc = await ctx.document();
      const { token } = await ctx.token('version', { [doc]: 'viewer' });
      const w = await ctx.connect({ label: 'version' });
      w.send({
        t: 'hello',
        id: 'h1',
        d: { ...HELLO_BASE, versions: ['9.0'], token, features: [] },
      });
      await expectFatal(ctx, w, 4406, 'unsupported_version', 'versions [9.0]');
      const err = w.messages.find((m) => m.t === 'error');
      if (err?.t === 'error')
        includes(err.d.versions, '1.0', "the error lists the server's versions (05 §5.7; D06)");
    },
  }),
  s({
    id: 'close.4408',
    title: 'a connection that sends no hello within 10 seconds is closed with 4408',
    spec: '05 §5.1, §5.7',
    timeoutMs: 30_000,
    covers: { closeCodes: [4408] },
    async run(ctx) {
      const w = await ctx.connect({ label: 'silent' });
      const started = Date.now();
      const closed = await w.closes('no hello', 15_000);
      ctx.closeCode(closed.code);
      equal(closed.code, 4408, 'the close code for a missing hello');
      const ms = closed.at - started;
      check(
        ms <= 13_000,
        'closed about 10 seconds after connecting (05 §5.1)',
        '≤ 10 s plus slack',
        ms,
      );
      if (ms < 9_000)
        ctx.note(`closed after ${ms} ms, before the 10 seconds of 05 §5.1 (test mode?)`);
    },
  }),
  s({
    id: 'close.4413',
    title: 'a frame above maxMessageBytes closes the connection with 4413',
    spec: '05 §4, §5.7',
    covers: { closeCodes: [4413], errors: ['too_large'] },
    async run(ctx) {
      const w = await welcomed(ctx);
      const max = w.welcome.limits.maxMessageBytes;
      const head = '{"t":"ping","x":"';
      const pad = 'x'.repeat(max + 1 - utf8Length(head) - 2);
      const frame = `${head}${pad}"}`;
      equal(utf8Length(frame), max + 1, 'the kit built a frame of maxMessageBytes + 1');
      w.wire.sendText(frame);
      await expectFatal(ctx, w.wire, 4413, 'too_large', 'a frame of maxMessageBytes + 1 bytes');
    },
  }),
  s({
    id: 'session.ping',
    title: 'ping is answered with pong, with or without an id',
    spec: '05 §4, §5.1; G17',
    covers: { messages: ['ping', 'pong'] },
    async run(ctx) {
      const w = await welcomed(ctx);
      const from = w.wire.mark();
      w.wire.send({ t: 'ping', id: 'p1' });
      const pong = await w.wire.nextOf('pong', { from });
      if (pong.re !== 'p1')
        ctx.note(`the pong does not carry re "p1" (G17 leaves it open): ${JSON.stringify(pong)}`);
      const from2 = w.wire.mark();
      w.wire.send({ t: 'ping' });
      await w.wire.nextOf('pong', { from: from2 });
      check(w.wire.open, 'the connection stays open', 'open', w.wire.closed);
    },
  }),
  s({
    id: 'session.heartbeat',
    title: 'an idle server sends ping after heartbeatMs and accepts the pong',
    spec: '05 §4',
    timeoutMs: 75_000,
    covers: { messages: ['ping', 'pong'] },
    async run(ctx) {
      const hb = ctx.limits.heartbeatMs;
      if (hb * 1.5 + 2000 > 60_000)
        ctx.skip(`heartbeatMs is ${hb} ms, too long for one scenario; use the test-mode switch`);
      const w = await welcomed(ctx);
      const from = w.wire.mark();
      const ping = await w.wire.next((m) => m.t === 'ping', 'a ping from the idle server', {
        from,
        timeoutMs: hb * 1.5 + 2000,
      });
      w.wire.send(ping.id !== undefined ? { t: 'pong', re: ping.id } : { t: 'pong' });
      check(
        await w.wire.staysOpen(500),
        'the connection stays open after the pong',
        'open',
        w.wire.closed,
      );
    },
  }),
  s({
    id: 'session.silence',
    title: 'a peer that hears nothing for two heartbeat intervals closes the connection',
    spec: '05 §4',
    needs: { testMode: true },
    timeoutMs: 60_000,
    covers: { messages: ['ping'] },
    async run(ctx) {
      const hb = ctx.limits.heartbeatMs;
      if (hb * 2.5 + 2000 > 55_000) ctx.skip(`heartbeatMs is ${hb} ms even in test mode`);
      const doc = await ctx.document();
      const w = await ctx.session('silent', { [doc]: 'editor' }, { wire: { autoPong: false } });
      // The kit never answers the server's pings. 05 §4 says the server closes and 05 §5.7 names no
      // code for it, so the normal closures 1000 and 1001 are accepted here as well as the nine
      // (open question: ADR 0315, decision 3). A drop without a close frame (1006) is not.
      w.wire.toleratedCloses.add(1000).add(1001);
      const closed = await w.wire.closes('two silent heartbeat intervals', hb * 2.5 + 2000);
      ctx.closeCode(closed.code);
      check(
        closed.code === 1000 || closed.code === 1001 || CLOSE_CODES.includes(closed.code),
        'a defined close code',
        '05 §5.7',
        closed.code,
      );
    },
  }),
  s({
    id: 'session.unknown-type',
    title: 'an unknown type with an id is answered with unknown_type; without one it is ignored',
    spec: '05 §1 rule 3',
    covers: { errors: ['unknown_type'], messages: ['error'] },
    async run(ctx) {
      const w = await welcomed(ctx);
      const from = w.wire.mark();
      w.wire.send({ t: 'x-tck-unknown', id: 'u1', d: { a: 1 } });
      const r = await w.wire.reply('u1');
      if (r.t !== 'error')
        throw new KitFailure('the reply to an unknown type with an id', 'error unknown_type', r);
      equal(r.d.code, 'unknown_type', 'code');
      equal(r.d.fatal, false, 'fatal: false (05 §1 rule 3)');
      w.wire.send({ t: 'x-tck-silent', d: {} });
      w.wire.send({ t: 'ping', id: 'after' });
      await w.wire.reply('after');
      const errors = w.wire.messages.slice(from).filter((m) => m.t === 'error' && m.re !== 'u1');
      check(errors.length === 0, 'an unknown type without an id is ignored', 'no error', errors);
      check(w.wire.open, 'the connection stays open', 'open', w.wire.closed);
    },
  }),
  s({
    id: 'session.unknown-members',
    title: 'unknown members of the envelope and of a payload are ignored',
    spec: '05 §1 rule 3',
    covers: { messages: ['hello', 'welcome'] },
    async run(ctx) {
      const doc = await ctx.document();
      const { token } = await ctx.token('members', { [doc]: 'viewer' });
      const w = await ctx.connect({ label: 'members' });
      const { reply } = await w.request({
        t: 'hello',
        x: 'envelope',
        d: { ...HELLO_BASE, token, features: [], 'x-tck': { nested: true } },
      });
      equal(reply.t, 'welcome', 'hello with unknown members is welcomed');
      const o = await openChannel(ctx, w, 1, doc, {});
      equal(o.t, 'ch.opened', 'the session works');
    },
  }),
  s({
    id: 'chunk.client',
    title: 'a message sent as chunks is reassembled by the server',
    spec: '05 §4; D04',
    covers: { messages: ['chunk', 'ch.open', 'ch.opened'] },
    async run(ctx) {
      const w = await welcomed(ctx);
      const text = JSON.stringify({
        t: 'ch.open',
        id: 'c1',
        ch: 1,
        d: {
          kind: 'doc',
          doc: w.doc,
          engine: 'pm-steps/1',
          cdm: 1,
          features: ctx.clientFeatures(),
        },
      });
      const frames = chunkMessage(text, 160, uuid7());
      check(frames.length > 2, 'the kit chunked the message', '> 2 chunks', frames.length);
      for (const f of frames) w.wire.sendText(f);
      const r = await w.wire.reply('c1');
      equal(r.t, 'ch.opened', 'the reassembled ch.open is answered');
    },
  }),
  s({
    id: 'chunk.server',
    title: 'a commit larger than maxMessageBytes is chunked both ways and reassembled',
    spec: '05 §4; D04',
    covers: { messages: ['chunk', 'sync.submit', 'sync.ack', 'sync.commit'] },
    async run(ctx) {
      const doc = await ctx.document();
      const a = await ctx.session('writer', { [doc]: 'editor' });
      const b = await ctx.session('reader', { [doc]: 'viewer' });
      const max = a.welcome.limits.maxMessageBytes;
      const size = max + 4096;
      if (size + 1024 > a.welcome.limits.maxCommitBytes)
        ctx.skip(
          `maxCommitBytes ${a.welcome.limits.maxCommitBytes} is below maxMessageBytes ${max}`,
        );
      const oa = await opened(ctx, a.wire, 1, doc, {});
      await opened(ctx, b.wire, 1, doc, {});
      const content = await ctx.service.as(a.token, 'GET', `/documents/${doc}/content`);
      const pos = posIn((content.json as { doc: unknown }).doc, IDS.intro);
      const text = JSON.stringify({
        t: 'sync.submit',
        id: 's1',
        ch: 1,
        d: { id: uuid7(), base: oa.head, steps: [insertText(pos, 'y'.repeat(size))] },
      });
      for (const f of chunkMessage(text, max, uuid7())) a.wire.sendText(f);
      const ack = await a.wire.reply('s1', { timeoutMs: ctx.timeoutMs * 2 });
      if (ack.t !== 'sync.ack')
        throw new KitFailure('the chunked commit is acknowledged', 'sync.ack', ack);
      await b.wire.next(
        (m) => m.t === 'sync.commit' && m.d.commits.some((c) => c.seq === ack.d.seq),
        'the large commit on another channel',
        { timeoutMs: ctx.timeoutMs * 2 },
      );
      const chunks = b.wire.frames.filter(
        (f) => f.result.kind === 'message' && f.result.message.t === 'chunk',
      );
      check(
        chunks.length >= 2,
        'the server chunked the large sync.commit',
        '≥ 2 chunk frames',
        chunks.length,
      );
      const big = b.wire.frames.filter((f) => utf8Length(f.text) > max);
      check(
        big.length === 0,
        'every frame from the server is within maxMessageBytes',
        0,
        big.length,
      );
    },
  }),
  s({
    id: 'chunk.timeout',
    title: 'a reassembly that does not complete within 10 seconds is abandoned',
    spec: '05 §4; G14',
    timeoutMs: 40_000,
    covers: { messages: ['chunk'] },
    async run(ctx) {
      const w = await welcomed(ctx);
      const text = JSON.stringify({
        t: 'ch.open',
        id: 'late',
        ch: 1,
        d: { kind: 'doc', doc: w.doc, engine: 'pm-steps/1', cdm: 1, features: [] },
      });
      const frames = chunkMessage(text, 120, uuid7());
      w.wire.sendText(frames[0]!);
      await ctx.sleep(11_000);
      for (const f of frames.slice(1)) if (w.wire.open) w.wire.sendText(f);
      const answered = await w.wire.arrives((m) => 're' in m && m.re === 'late', 1500);
      check(
        !answered,
        'the message whose chunks took longer than 10 seconds is not delivered (05 §4)',
        'no reply',
        w.wire.messages.slice(-3),
      );
      if (w.wire.closed) {
        ctx.closeCode(w.wire.closed.code);
        oneOf(w.wire.closed.code, CLOSE_CODES, 'a close code of 05 §5.7');
        ctx.note(`the server closed with ${w.wire.closed.code} (G14 leaves the reaction open)`);
      }
    },
  }),
  s({
    id: 'auth.refresh',
    title: 'auth.refresh with a token of the same user is answered by auth.ok with the new expiry',
    spec: '05 §3.1, §5.1',
    covers: { messages: ['auth.refresh', 'auth.ok'] },
    async run(ctx) {
      const doc = await ctx.document();
      const sub = ctx.sub('refresh');
      const first = await ctx.service.mint({ sub, docs: { [doc]: 'editor' }, expiresIn: 300 });
      const w = await ctx.connect({ label: 'refresh' });
      await ctx.hello(w, first.token);
      const next = await ctx.service.mint({ sub, docs: { [doc]: 'editor' }, expiresIn: 600 });
      const { reply } = await w.request({ t: 'auth.refresh', d: { token: next.token } });
      if (reply.t !== 'auth.ok') throw new KitFailure('auth.refresh is answered', 'auth.ok', reply);
      equal(
        Math.floor(Date.parse(reply.d.tokenExp) / 1000),
        Math.floor(Date.parse(next.expiresAt) / 1000),
        'auth.ok carries the new tokenExp',
      );
      const other = await ctx.service.mint({ sub: ctx.sub('intruder'), docs: { [doc]: 'editor' } });
      const { reply: refused } = await w.request({ t: 'auth.refresh', d: { token: other.token } });
      check(
        refused.t === 'error',
        'a token of another user is refused (05 §3.1: same tid and sub)',
        'error',
        refused,
      );
    },
  }),
  s({
    id: 'auth.expiring',
    title: 'auth.expiring arrives about 60 seconds before tokenExp',
    spec: '05 §5.1',
    covers: { messages: ['auth.expiring'] },
    async run(ctx) {
      const doc = await ctx.document();
      const minted = await ctx.service.mint({
        sub: ctx.sub('expiring'),
        docs: { [doc]: 'viewer' },
        expiresIn: 30,
      });
      const w = await ctx.connect({ label: 'expiring' });
      await ctx.hello(w, minted.token);
      const m = await w.nextOf('auth.expiring', { timeoutMs: 5000 });
      check(
        m.d.inMs >= 0 && m.d.inMs <= 31_000,
        'inMs is the time left on a 30-second token',
        '0 to 30,000',
        m.d.inMs,
      );
    },
  }),
  s({
    id: 'auth.expired',
    title: 'a session whose token expires is closed with 4401',
    spec: '05 §3.1, §5.1, §5.7',
    needs: { testMode: true },
    timeoutMs: 45_000,
    covers: { closeCodes: [4401], errors: ['token_expired'] },
    async run(ctx) {
      const doc = await ctx.document();
      const minted = await ctx.service.mint({
        sub: ctx.sub('expired'),
        docs: { [doc]: 'viewer' },
        expiresIn: 3,
      });
      const w = await ctx.connect({ label: 'expired' });
      await ctx.hello(w, minted.token);
      await expectFatal(ctx, w, 4401, 'token_expired', 'an expired token');
    },
  }),
  s({
    id: 'auth.revoked',
    title: 'a revocation sends auth.revoked and closes with 4401; a newer token is accepted',
    spec: '05 §3.3, §5.1',
    covers: {
      messages: ['auth.revoked'],
      closeCodes: [4401],
      operations: ['POST /sessions/revoke'],
    },
    async run(ctx) {
      const doc = await ctx.document();
      const w = await ctx.session('revoked', { [doc]: 'editor' });
      await ctx.sleep(1100);
      await ctx.service.revoke(w.sub);
      const m = await w.wire.nextOf('auth.revoked');
      check(typeof m.d.reason === 'string', 'auth.revoked carries a reason', 'a string', m.d);
      const closed = await w.wire.closes('after auth.revoked');
      ctx.closeCode(closed.code);
      equal(closed.code, 4401, 'auth.revoked is followed by 4401 (05 §5.1)');
      await ctx.sleep(1100);
      const fresh = await ctx.service.token(w.sub, { [doc]: 'editor' });
      const again = await ctx.connect({ label: 'after-revocation' });
      await ctx.hello(again, fresh);
    },
  }),
];

/** Whether a reply is an `error` with this code. */
export function isError(m: ServerMessage, code: string): boolean {
  return m.t === 'error' && m.d.code === code;
}
