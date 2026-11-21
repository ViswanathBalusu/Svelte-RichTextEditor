// FRW-018 criterion 4 at completion, through the real service: a participant whose stored value
// does not match the `validation.pattern` of its field is refused by
// `POST /documents/{id}/workflow/participants/{pid}/complete` (FRW-047), and the violation of that
// field carries the message the author gave (`validation.message`; owner decision 187 of
// 2026-11-15). A pattern without a message, and a required field that is empty, carry none: the
// message is the author's text and nothing else is sent. No value is in the answer. Once the values
// match, the same participant completes. Real data plane; memory storage and, when the test
// environment is up, PostgreSQL in Podman.
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DepClient } from '../data-plane/client.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const CODE = 'fd00000000000181';
const REF = 'fd00000000000182';
const NAME = 'fd00000000000183';
const PATTERN = '[A-Z]{2}[0-9]{4}';
const MESSAGE = 'Enter two letters and four digits, such as AB1234.';
/** Stored values that do not match; none may appear in a refusal. */
const WRONG = { code: 'wrongcode1', ref: 'notdigits7' };

function document(): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  d.requires = ['fields'];
  d.doc.content[0]!.content.push({
    type: 'role_def',
    attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' },
  });
  const field = (id: string, key: string, extra: Record<string, unknown>) => ({
    type: 'form_field',
    attrs: { id, key, kind: 'text', label: key, assignee: 'tenant', value: null, ...extra },
  });
  const sp = { type: 'text', text: ' ' };
  d.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pPattern00000181' },
    content: [
      // A pattern with the author's message.
      field(CODE, 'tenant.code', {
        validation: { pattern: PATTERN, message: MESSAGE },
        value: WRONG.code,
      }),
      sp,
      // A pattern without one.
      field(REF, 'tenant.ref', { validation: { pattern: '[0-9]+' }, value: WRONG.ref }),
      sp,
      field(NAME, 'tenant.name', { required: true }),
    ],
  });
  return d as unknown as Record<string, unknown>;
}

const body = (doc: string) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8181',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  participants: [{ id: 'p1', roles: ['tenant'], kind: 'filler', order: 1, sub: 'sub-p1' }],
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`completion reports a pattern with the author's message (${storage}; FRW-018 criterion 4)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    const clients: DepClient[] = [];
    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, { realDataPlane: true, config: { jobIdleMs: 20 } });
    }, 60_000);
    afterAll(async () => {
      for (const c of clients.splice(0)) c.terminate();
      await h?.close();
    });

    it.skipIf(skip)(
      'refuses with the message for the field that has one, and completes once the values match',
      async () => {
        const doc = await h.createDocument({ content: document() });
        const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-018-${doc}` });
        const participant = h.userToken({ [doc]: 'filler' }, { sub: 'sub-p1', wfp: 'p1' });
        const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
          token: owner,
          body: body(doc),
          headers: { 'if-match': '"0"' },
        });
        expect(made.status, made.text).toBe(201);
        const sent = await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner });
        expect(sent.status, sent.text).toBe(200);
        const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
        clients.push(c);
        expect((await c.hello(participant)).t).toBe('welcome');
        const opened = await c.open(1, doc);
        expect(opened.t, JSON.stringify(opened.d)).toBe('ch.opened');
        for (let i = 0; i < 100; i++) {
          const w = await h.call('GET', `/v1/documents/${doc}/workflow`, { token: owner });
          if (w.json.state === 'in_progress') break;
          await new Promise((r) => setTimeout(r, 50));
        }
        const complete = () =>
          h.call('POST', `/v1/documents/${doc}/workflow/participants/p1/complete`, {
            token: participant,
            body: {},
          });

        // Refused: one violation for each field that does not pass.
        const refused = await complete();
        expect(refused.status, refused.text).toBe(400);
        expect(refused.json.code).toBe('validation_failed');
        const violations = refused.json.violations as Array<Record<string, unknown>>;
        const byPath = (path: string) => violations.filter((v) => v['path'] === path);
        // The field with the author's message: the message, as the author wrote it.
        expect(byPath('/fields/tenant.code')).toEqual([
          { path: '/fields/tenant.code', rule: 'pattern', message: MESSAGE },
        ]);
        // No message of the author: none is sent, and the service's own wording is not sent either.
        expect(byPath('/fields/tenant.ref')).toEqual([
          { path: '/fields/tenant.ref', rule: 'pattern' },
        ]);
        expect(byPath('/fields/tenant.name')).toEqual([
          { path: '/fields/tenant.name', rule: 'required' },
        ]);
        expect(violations).toHaveLength(3);
        // Never a value (D71; BE-088).
        for (const value of Object.values(WRONG)) expect(refused.text).not.toContain(value);
        const state = async () =>
          (
            (await h.call('GET', `/v1/documents/${doc}/workflow`, { token: owner })).json
              .participants as Array<{ id: string; state: string }>
          ).find((p) => p.id === 'p1')!.state;
        expect(await state()).toBe('active');

        // The participant enters values that match, over the channel, and completes.
        const content = await h.call('GET', `/v1/documents/${doc}/content`, {
          token: h.serviceJwt(),
        });
        const root = cdmSchema().nodeFromJSON(content.json.doc);
        const posOf = (id: string): number => {
          let found = -1;
          root.descendants((n, pos) => {
            if (n.attrs['id'] === id) found = pos;
            return found < 0;
          });
          expect(found, `the field ${id}`).toBeGreaterThan(0);
          return found;
        };
        let base = opened.d!['head'] as number;
        for (const [id, value] of [
          [CODE, 'AB1234'],
          [REF, '42'],
          [NAME, 'Ada'],
        ] as const) {
          const ack = await c.submit(1, {
            base,
            steps: [{ stepType: 'attr', pos: posOf(id), attr: 'value', value }],
          });
          expect(ack.t, `${id}: ${JSON.stringify(ack.d)}`).toBe('sync.ack');
          base = ack.d!['seq'] as number;
        }
        const done = await complete();
        expect(done.status, done.text).toBe(200);
        expect(await state()).toBe('completed');
      },
      90_000,
    );
  });
}
