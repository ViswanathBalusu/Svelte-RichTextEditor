/**
 * SEC-064 — hidden content never reaches a reader without access (ADR 0019, proposed; spike S12;
 * 10; R3, R10). A confidential region (its title and text) and a sensitive field value carry canary
 * strings. A reader with no grant on the region sweeps every REST operation of the protocol
 * definition (DEP1.operations) and every channel message of one WebSocket channel, and no canary
 * appears in anything they receive. Readers with access see the canaries, so the check is not
 * vacuous. The service log is scanned too.
 *
 * The harness runs the service with the production read-restriction function (`visibility`) and
 * the full view classes (`FULL_VIEWS`) with the visibility function substituted, the same way the
 * service's own route tests compose it. PostgreSQL runs the same cases when it is reachable.
 *
 * Criterion 2 (grant changes during a run) is covered for one grant revocation with an open channel
 * and a measured window; lost notifications and failovers are not run here (see the story's Notes).
 */
import { randomUUID } from 'node:crypto';
import { uuid7 } from '@docedit/model';
import { DEP1 } from '@docedit/protocol';
import { visibility } from '@docedit/authority';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_VIEWS } from '../../../services/document-service/src/control-plane/visibility.ts';
import {
  documentWithRegions,
  insertText,
  posInside,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { WireClient } from './support/wire.ts';

const CANARY = {
  title: 'CANARY_CONF_TITLE_4e1d',
  text: 'CANARY_CONF_TEXT_8a2c',
  value: 'CANARY_SENSITIVE_6f0b',
  typed: 'CANARY_TYPED_2b9e',
  afterRevoke: 'CANARY_AFTER_REVOKE_7c3d',
};
const CANARIES = Object.values(CANARY);

const CONF = 'rConf00000000001';
const CONF_PARA = 'pConf00000000001';
const SENS = 'fSens00000000001';
const SENS_PARA = 'pSens00000000001';

/** The shared fixture: the standard regions, plus a confidential region and a sensitive field. */
function confidentialDocument(): Record<string, unknown> {
  const content = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  content.requires = ['fields']; // a form field needs the feature (CDM invariant I1)
  const body = content.doc.content[1]!;
  const end = body.content.pop()!; // the trailing empty paragraph stays last
  body.content.push(
    {
      type: 'region',
      attrs: { id: CONF, title: CANARY.title, policy: 'confidential' },
      content: [
        {
          type: 'paragraph',
          attrs: { id: CONF_PARA, style: 'Normal' },
          content: [{ type: 'text', text: CANARY.text }],
        },
      ],
    },
    {
      type: 'paragraph',
      attrs: { id: SENS_PARA, style: 'Normal' },
      content: [
        { type: 'text', text: 'Deposit: ' },
        {
          type: 'form_field',
          attrs: {
            id: SENS,
            key: 'deposit',
            kind: 'text',
            label: 'deposit',
            assignee: null,
            sensitive: true,
            value: CANARY.value,
          },
        },
      ],
    },
    end,
  );
  return content;
}

/** A channel opened with the feature the document requires (its `requires` lists `fields`). */
const OPEN = { features: ['regions', 'presence', 'fields'] };

/** Polls a condition until it holds, for messages that arrive asynchronously over the channel. */
async function waitFor(pred: () => boolean, timeoutMs = 3000, what = 'a condition'): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > until) throw new Error(`${what} did not hold within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Every operation path with its parameters filled: the document, its confidential region, or an absent id. */
function concretePath(path: string, doc: string): string {
  return path.replace(/\{(\w+)\}/g, (_m, name: string) => {
    if (name === 'id') return doc;
    if (name === 'rid') return CONF;
    return `missing-${name}`;
  });
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null; // probed at collection so skipIf-style skips apply (SEC harness)
  describe(`SEC-064 hidden content never reaches a reader without access (${storage})`, () => {
    let h: Harness;
    let doc: string;
    let frank: string; // viewer of the document, no grant on the confidential region
    let gina: string; // viewer with a grant on the confidential region
    let ann: string; // owner
    const measured: { revokeMs?: number; staleReads?: number; notified?: boolean } = {};

    const service = () => ({ token: h.a.apiKey });
    const grantsOf = async () =>
      (await h.call('GET', `/v1/documents/${doc}/grants`, service())).headers.get('etag')!;
    const setGrants = (grants: unknown[]) =>
      grantsOf().then((etag) =>
        h.call('PATCH', `/v1/documents/${doc}/grants`, {
          ...service(),
          headers: { 'If-Match': etag },
          body: { grants },
        }),
      );

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, {
        views: { ...FULL_VIEWS, visibility: visibility(() => Date.now()) },
      });
      doc = await h.createDocument(h.a, confidentialDocument());
      frank = h.userToken(h.a, 'frank', { [doc]: 'viewer' });
      gina = h.userToken(h.a, 'gina', { [doc]: 'viewer' });
      ann = h.userToken(h.a, 'ann', { [doc]: 'owner' });
      const granted = await setGrants([{ region: CONF, principal: 'user:gina', role: 'viewer' }]);
      expect(granted.status, 'the grant is recorded').toBe(200);
    });
    afterAll(async () => {
      await h?.close();
    });
    const t = () => (skip ? it.skip : it);

    t()('a reader with access sees the canaries, so the check below can fail', async () => {
      const asGina = await h.call('GET', `/v1/documents/${doc}/content`, { token: gina });
      expect(asGina.status).toBe(200);
      expect(asGina.text).toContain(CANARY.text);
      const asAnn = await h.call('GET', `/v1/documents/${doc}/content`, { token: ann });
      expect(asAnn.text).toContain(CANARY.value);
      expect(asAnn.text).toContain(CANARY.title);
    });

    /** Calls every operation of the definition as the reader without access, and scans each answer. */
    const sweep = async (): Promise<string[]> => {
      const seen: string[] = [];
      for (const op of DEP1.operations) {
        const path = concretePath(op.path, doc);
        const isEndpoint = op.base === 'endpoint';
        const url = isEndpoint ? path : `/v1${path}`;
        const headers: Record<string, string> = {};
        if (op.method === 'POST') headers['Idempotency-Key'] = randomUUID();
        const body = op.method === 'GET' || op.method === 'DELETE' ? undefined : {};
        const r = await h.call(op.method, url, {
          token: frank,
          headers,
          ...(body !== undefined ? { body } : {}),
        });
        seen.push(`${op.method} ${op.path} ${r.status}`);
        for (const c of CANARIES) {
          expect(
            r.text,
            `${op.operationId} (${op.method} ${op.path}) must not carry ${c}`,
          ).not.toContain(c);
        }
        // A 5xx is a failure inside the service, except the one deliberate answer: a reader whose
        // view hides content is told to reload with `unavailable` (activity-route.ts; ADR 0019).
        const reloadAnswer =
          r.status === 503 &&
          (r.json as Record<string, unknown> | undefined)?.['code'] === 'unavailable';
        expect(
          r.status < 500 || reloadAnswer,
          `${op.operationId} must not fail inside the service (status ${r.status})`,
        ).toBe(true);
      }
      // The projection is applied: the reader gets the document, with the hidden region replaced.
      const projected = await h.call('GET', `/v1/documents/${doc}/content`, { token: frank });
      expect(projected.text).toContain('hidden_region');
      expect(seen.length).toBe(DEP1.operations.length);
      return seen;
    };

    t()(
      'a reader without access gets the projection and no canary from any REST operation',
      async () => {
        const seen = await sweep();
        const content = seen.find((s) => s.startsWith('GET /documents/{id}/content '));
        expect(content).toBe('GET /documents/{id}/content 200');
      },
    );

    t()(
      'a reader without access receives no canary on an open channel, while a granted reader does',
      async () => {
        const writer = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        const reader = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        const granted = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        try {
          expect((await writer.hello(ann)).t).toBe('welcome');
          expect((await reader.hello(frank)).t).toBe('welcome');
          expect((await granted.hello(gina)).t).toBe('welcome');
          expect((await writer.open(1, doc, OPEN)).t).toBe('ch.opened');
          expect((await reader.open(1, doc, OPEN)).t).toBe('ch.opened');
          expect((await granted.open(1, doc, OPEN)).t).toBe('ch.opened');

          const pos = posInside(
            (await h.call('GET', `/v1/documents/${doc}/content`, { token: ann })).json.doc,
            CONF_PARA,
          );
          const ack = await writer.submit(1, {
            id: uuid7(),
            base: 0,
            steps: [insertText(pos, ` ${CANARY.typed}`)],
          });
          expect(ack.t, JSON.stringify(ack.d)).toBe('sync.ack');

          await waitFor(
            () => granted.frames.some((f) => f.includes(CANARY.typed)),
            3000,
            'the granted reader to receive the commit',
          );
          expect(
            granted.all('sync.commit').length,
            'the granted reader gets the commit',
          ).toBeGreaterThan(0);
          // The reader gets the commit's envelope (seq, author, time) with no steps: nothing inside the
          // hidden region goes out. Whether the envelope itself may show the author is an open question
          // of ADR 0019 (see the story's Notes); the check here is on content.
          for (const m of reader.all('sync.commit')) {
            const commits = (m.d?.['commits'] ?? []) as Array<{ steps: unknown[] }>;
            expect(
              commits.every((c) => c.steps.length === 0),
              'a commit to a reader without access carries no steps',
            ).toBe(true);
          }
          // Commits reach a channel in order, so a reader who lacks access would have seen it by now.
          for (const c of CANARIES) {
            expect(reader.frames.join('\n'), `reader frames must not carry ${c}`).not.toContain(c);
          }
          expect(reader.frames.join('\n')).not.toContain(CANARY.typed);

          // A reader without edit who writes into the hidden region is refused, and the refusal
          // carries no document text.
          const refusedPos = posInside(
            (await h.call('GET', `/v1/documents/${doc}/content`, { token: ann })).json.doc,
            CONF_PARA,
          );
          const refused = await reader.submit(1, {
            id: uuid7(),
            base: 1,
            steps: [insertText(refusedPos, ' CANARY_REFUSED')],
          });
          expect(refused.t, JSON.stringify(refused.d)).toBe('sync.reject');
          for (const c of CANARIES) expect(JSON.stringify(refused.d)).not.toContain(c);
        } finally {
          writer.terminate();
          reader.terminate();
          granted.terminate();
        }
      },
    );

    t()('after a commit into the hidden region, the sweep still finds no canary', async () => {
      // The commit of the channel case is now in the history, so history, commits and activity
      // carry it; the reader without access must not see its text.
      const seen = await sweep();
      expect(seen.length).toBe(DEP1.operations.length);
    });

    t()('the service log holds no canary of the hidden content', async () => {
      const blob = h.logs.join('\n');
      expect(blob.length, 'the service did log something').toBeGreaterThan(0);
      for (const c of CANARIES)
        expect(blob, `canary ${c} must not appear in logs`).not.toContain(c);
    });

    t()(
      "a grant change ends the reader's access: no stale read after the change, window measured",
      async () => {
        const before = await h.call('GET', `/v1/documents/${doc}/content`, { token: gina });
        expect(before.text).toContain(CANARY.text);

        const revoke = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        try {
          expect((await revoke.hello(gina)).t).toBe('welcome');
          expect((await revoke.open(1, doc, OPEN)).t).toBe('ch.opened');

          const started = Date.now();
          const change = await setGrants([]);
          expect(change.status).toBe(200);

          // Reads after the change: each one is checked; the window ends at the first clean read.
          let stale = 0;
          let cleanAt = -1;
          for (let i = 0; i < 20 && cleanAt < 0; i++) {
            const r = await h.call('GET', `/v1/documents/${doc}/content`, { token: gina });
            if (r.text.includes(CANARY.text)) stale++;
            else cleanAt = Date.now();
          }
          expect(cleanAt, 'the revoked reader gets a projection').toBeGreaterThan(0);
          measured.revokeMs = cleanAt - started;
          measured.staleReads = stale;
          expect(stale, 'no read after the grant change carries the canary').toBe(0);

          // Whether the open channel is told of the change (a notice, or a close) is measured, not
          // assumed: in this run it was not told within the bounded wait (see the story's Notes).
          await new Promise((r) => setTimeout(r, 1000));
          measured.notified = revoke.all('perm.changed').length > 0 || revoke.closeInfo !== null;
          for (const c of CANARIES) {
            expect(revoke.frames.join('\n'), `revoked channel must not carry ${c}`).not.toContain(
              c,
            );
          }

          // The open channel of the revoked reader gets no commit made after the change.
          const writer = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
          try {
            expect((await writer.hello(ann)).t).toBe('welcome');
            expect((await writer.open(1, doc, OPEN)).t).toBe('ch.opened');
            const pos = posInside(
              (await h.call('GET', `/v1/documents/${doc}/content`, { token: ann })).json.doc,
              CONF_PARA,
            );
            const ack = await writer.submit(1, {
              id: uuid7(),
              base: 1,
              steps: [insertText(pos, ` ${CANARY.afterRevoke}`)],
            });
            expect(ack.t).toBe('sync.ack');
            await new Promise((r) => setTimeout(r, 500));
            const got = revoke.frames.join('\n');
            expect(
              got,
              'the revoked channel must not carry a commit made after revocation',
            ).not.toContain(CANARY.afterRevoke);
            for (const c of CANARIES)
              expect(got, `revoked channel must not carry ${c}`).not.toContain(c);
          } finally {
            writer.terminate();
          }
        } finally {
          revoke.terminate();
        }
        // The measured window, reported for the story's Notes: wall-clock time from the change's
        // request to the first clean read, in this process, on this storage.
        console.info(
          `SEC-064 ${storage}: grant change to first clean read ${measured.revokeMs} ms; stale reads ${measured.staleReads}; open channel told of the change within 1 s: ${measured.notified}`,
        );
      },
    );
  });
}
