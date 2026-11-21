/**
 * SEC-002 — the adversarial client is not the component: it speaks the DEP wire format itself and
 * can send what the component never would (10 §2, §5). This file exercises each capability the
 * story asks for, so the negative tests of the rest of the packet have a client that can reach
 * every corner of the protocol.
 *
 * The same suite runs against three targets (support/harness.ts, `Target`):
 * - the real service in this process on memory storage, always;
 * - the real service in this process on PostgreSQL, when the integration environment is up
 *   (`infra/test-env.ps1 up -NoExport`); skipped with the reason otherwise;
 * - the compose stack of BE-005, already running, when `DOCEDIT_DEMO_STACK=1` (criterion 5; see
 *   support/stack-target.ts). There the service is another process on its own PostgreSQL and
 *   S3-compatible store, and the first test checks that. tests/security/scripts/stack-suite.ps1
 *   starts the stack, runs this file against it and removes the stack: the one command a CI job
 *   needs.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import {
  documentWithRegions,
  postgresUnavailable,
  startHarness,
  type Target,
} from './support/harness.ts';
import { keyPair } from './support/jws.ts';
import {
  openStackTarget,
  stackDataDir,
  STACK_WANTED,
  type StackTarget,
} from './support/stack-target.ts';
import { WireClient } from './support/wire.ts';

function clientSuite(where: string, open: () => Promise<Target>, skip: string | null): void {
  describe.skipIf(skip !== null)(`SEC-002 the adversarial protocol client (${where})`, () => {
    let h: Target;
    let doc: string;
    beforeAll(async () => {
      h = await open();
      doc = await h.createDocument(h.a, documentWithRegions());
    }, 60_000);
    afterAll(async () => {
      await h?.close();
    });

    it('sends any envelope, message type, channel number, chunk and step JSON, including malformed', async () => {
      const token = await h.mintToken(h.a, 'ann', { [doc]: 'editor' });
      const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      try {
        expect((await c.hello(token)).t).toBe('welcome');
        // An arbitrary unknown type with a step-shaped payload (non-fatal: the connection survives).
        c.send({ t: 'x-probe', id: 'x2', d: { steps: [{ stepType: 'frob', from: -1, to: 1e9 }] } });
        const err = await c.take((m) => m.re === 'x2', 3000, 'the unknown_type answer');
        expect(err.t).toBe('error');
        // A known type carrying a crafted payload (validation off), on an odd channel number.
        c.sendEncoded({
          t: 'ch.open',
          id: 'x1',
          ch: 99,
          d: { kind: 'doc', doc, engine: 'pm-steps/1', cdm: 1, features: [] },
        });
        // A chunk frame by hand.
        c.send({ t: 'chunk', d: { of: 'z', i: 0, n: 2, part: 'abc' } });
      } finally {
        c.terminate();
      }
      // A raw malformed frame, on its own connection (it is fatal: close 4400).
      const bad = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      try {
        bad.sendRaw('{ this is not valid json');
        expect((await bad.closed).code).toBe(4400);
      } finally {
        bad.terminate();
      }
    });

    it('calls any REST route with any token or credential and sets DEP-Actor, Idempotency-Key, If-Match, Origin and raw bodies', async () => {
      // A raw body and an Origin header on a service-credential route.
      const minted = await h.call('POST', '/v1/tokens', {
        token: h.a.apiKey,
        raw: JSON.stringify({ sub: 'ann', docs: { [doc]: 'viewer' } }),
        headers: {
          'Content-Type': 'application/json',
          Origin: h.a.origin,
          'Idempotency-Key': uuid7(),
          'DEP-Actor': '00000000-0000-7000-8000-0000000000ac',
        },
      });
      expect(minted.status).toBe(200);
      // An If-Match header on a mutating route (a stale tag is rejected, proving the header is read).
      const bad = await h.call('PATCH', `/v1/documents/${doc}`, {
        token: h.a.apiKey,
        body: { title: 'x' },
        headers: { 'If-Match': '"m-stale"' },
      });
      expect([409, 412, 428]).toContain(bad.status);
      // Any token, including a service credential, on any route.
      const asUser = await h.call('GET', `/v1/documents/${doc}`, {
        token: await h.mintToken(h.a, 'ann', { [doc]: 'viewer' }),
      });
      expect(asUser.status).toBe(200);
    });

    it('withholds, delays and reorders frames, and keeps a connection open without sending hello', async () => {
      const quiet = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      try {
        // No hello is sent; the connection is held open (the hello timeout is 10 s).
        await new Promise((r) => setTimeout(r, 300));
        expect(quiet.closeInfo).toBeNull();
      } finally {
        quiet.terminate();
      }
      // Sending out of order: a ch.open before hello is refused, which the client can still send.
      const early = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      try {
        early.send({
          t: 'ch.open',
          id: 'c1',
          ch: 1,
          d: { kind: 'doc', doc, engine: 'pm-steps/1', cdm: 1, features: [] },
        });
        expect((await early.closed).code).toBe(4400); // the first message must be hello
      } finally {
        early.terminate();
      }
    });

    it('mints tokens for several tenants and roles, and signs tokens with arbitrary keys for confusion tests', async () => {
      // Several tenants and roles through POST /tokens.
      const aEditor = await h.mintToken(h.a, 'ann', { [doc]: 'editor' });
      const docB = await h.createDocument(h.b, documentWithRegions());
      const bViewer = await h.mintToken(h.b, 'ben', { [docB]: 'viewer' });
      for (const [tok, origin, document] of [
        [aEditor, h.a.origin, doc],
        [bViewer, h.b.origin, docB],
      ] as const) {
        const c = await WireClient.connect(h.wsUrl, { origin });
        try {
          expect((await c.hello(tok)).t).toBe('welcome');
          expect((await c.open(1, document)).t).toBe('ch.opened');
        } finally {
          c.terminate();
        }
      }
      // One tenant's token does not open the other tenant's document.
      const cross = await h.call('GET', `/v1/documents/${docB}`, { token: aEditor });
      expect([403, 404]).toContain(cross.status);
      // A token the client signs itself with the key the tenant registered is accepted.
      const own = h.userToken(h.a, 'ann', { [doc]: 'viewer' });
      expect((await h.call('GET', `/v1/documents/${doc}`, { token: own })).status).toBe(200);
      // The same token signed with an arbitrary key of the same algorithm is refused.
      const stranger = keyPair(h.a.hostKey.alg as 'ES256' | 'EdDSA' | 'RS256');
      const forged = h.userToken(h.a, 'ann', { [doc]: 'editor' }, { sign: stranger });
      expect((await h.call('GET', `/v1/documents/${doc}`, { token: forged })).status).toBe(401);
      // And so is one signed with the registered key of the other tenant.
      const confused = h.userToken(
        h.a,
        'ann',
        { [doc]: 'editor' },
        { sign: h.b.hostKey, header: { alg: h.b.hostKey.alg } },
      );
      expect((await h.call('GET', `/v1/documents/${doc}`, { token: confused })).status).toBe(401);
    });
  });
}

clientSuite('memory', () => startHarness('memory'), null);

// The service on PostgreSQL in this process: the CI integration job runs this path.
clientSuite('PostgreSQL', () => startHarness('postgres'), await postgresUnavailable());

// Criterion 5: the compose stack of BE-005, started beforehand.
const stackSkip = STACK_WANTED
  ? null
  : 'start the stack and set DOCEDIT_DEMO_STACK=1 (tests/security/scripts/stack-suite.ps1 does both)';

describe.skipIf(stackSkip !== null)('SEC-002 the target is the compose stack of BE-005', () => {
  it('is another process, on the PostgreSQL and S3 containers of the stack', async () => {
    const h: StackTarget = await openStackTarget();
    try {
      // The service is ready and announces what it serves.
      expect((await h.call('GET', '/readyz')).status).toBe(200);
      expect(h.features).toEqual(expect.arrayContaining(['regions']));
      // What the client creates through the service is a row in the stack's own PostgreSQL, read
      // here over the database port; an identifier the service never saw is not there.
      const doc = await h.createDocument(h.a, documentWithRegions());
      expect(await h.documentStored(h.a, doc), 'the document is in the stack database').toBe(true);
      expect(await h.documentStored(h.a, uuid7())).toBe(false);
      // The service was started by the stack: its process identifier is on record and is not ours.
      const pidFile = join(stackDataDir(), 'pids', 'document-service.pid');
      expect(existsSync(pidFile), 'the stack recorded its document service').toBe(true);
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(pid).not.toBe(process.pid);
      expect(
        () => process.kill(pid, 0),
        'the document service of the stack is running',
      ).not.toThrow();
      // Its containers, by the names the compose file's project gives them.
      const cli = process.env['DOCEDIT_CONTAINER_CLI'] || 'podman';
      for (const service of ['postgres', 's3']) {
        const state = execFileSync(
          cli,
          ['inspect', '--format', '{{.State.Status}}', `${h.project}-${service}`],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        ).trim();
        expect(state, `${h.project}-${service}`).toBe('running');
      }
      console.info(
        `SEC-002: the client's suite runs against the stack '${h.project}' at ${h.base} (features: ${h.features.join(', ')})`,
      );
    } finally {
      await h.close();
    }
  }, 120_000);
});

clientSuite('the compose stack of BE-005', openStackTarget, stackSkip);
