/**
 * SEC-047 criterion 1, two more classes of canary (lane w3, 2026-11-15): form field values and
 * alternative text. The earlier suites (logs-no-content.test.ts, sec-047-v-canary-surfaces.test.ts)
 * seed titles, body text, comments, filenames, query values, tokens, credentials and a webhook
 * secret; they could not seed these two.
 *
 * - Field values: a document is created whose form field already holds a canary value; a commit
 *   over the wire sets a second canary value; a commit with a value past the 4 KiB limit that
 *   contains a third canary is refused (so the refusal path is exercised); the field-value routes
 *   are read.
 * - Alternative text: a commit inserts an inline image whose `alt` is a canary. The image names an
 *   asset that is not attached to the document. Today the data plane accepts that commit (SEC-037
 *   Notes); when it starts refusing it, the canary travels the refusal path instead. Either way the
 *   canary reaches the service, which is what this test needs, so both answers are accepted.
 *
 * Every structured log line, the `/metrics` scrape and every request span are then searched for the
 * canaries. Still not seeded anywhere, so the criterion stays unticked: access codes (no route names
 * them in this tree) and signed-URL signatures (the memory store's URLs carry none), and the
 * workers' own outputs. Memory and PostgreSQL storage, through the security harness.
 */
import { randomBytes } from 'node:crypto';
import { AttrStep } from 'prosemirror-transform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import { at, inside, loadDoc, stepsJson } from './support/cdm.ts';
import {
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';
import {
  baseOf,
  contentOf,
  openAsOwner,
  readCase,
  submitCommit,
  type Json,
} from './support/invariant-corpus.ts';

const METRICS_TOKEN = `metrics-w3-sec-047-${randomBytes(12).toString('hex')}`;
const FIELD = 'ffIncome00000001';

const CANARY = {
  storedValue: 'CANARY_W347_FIELD_STORED_91c2',
  committedValue: 'CANARY_W347_FIELD_COMMITTED_a3d4',
  refusedValue: 'CANARY_W347_FIELD_REFUSED_b5e6',
  altText: 'CANARY_W347_ALT_TEXT_c7f8',
};

/** The field-ready base of the invariant corpus, with its field made a text field with a value. */
function documentWithField(): Json {
  const base = baseOf(readCase('i15-fields-2000')['base']);
  const visit = (n: Json): void => {
    if (n['type'] === 'form_field' && n['attrs']['id'] === FIELD)
      n['attrs'] = { ...n['attrs'], kind: 'text', value: CANARY.storedValue };
    for (const c of (n['content'] ?? []) as Json[]) visit(c);
  };
  visit(base['doc'] as Json);
  return base;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  describe(`SEC-047 criterion 1: field values and alternative text (${storage})`, () => {
    let h: Harness;
    const spans: unknown[] = [];
    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, {
        env: { DOCEDIT_METRICS_TOKEN: METRICS_TOKEN },
        onSpan: (span) => void spans.push(span),
      });
    });
    afterAll(async () => {
      await h?.close();
    });
    const t = () => (skip ? it.skip : it);

    t()(
      'canaries in field values and alternative text appear in no log line, metric or span',
      async () => {
        const base = documentWithField();
        const doc = await h.createDocument(h.a, base);
        const d = loadDoc(base['doc']);
        const owner = await openAsOwner(h, doc, base['requires']);
        try {
          let seq = (await contentOf(h, doc))['seq'] as number;

          // A field value set by a commit.
          const set = await submitCommit(owner, {
            id: uuid7(),
            base: seq,
            steps: stepsJson([new AttrStep(at(d, FIELD), 'value', CANARY.committedValue)]),
          });
          expect(set.t, JSON.stringify(set.d)).toBe('sync.ack');
          seq += 1;

          // A field value the authority refuses (past 4 KiB, I15).
          const refused = await submitCommit(owner, {
            id: uuid7(),
            base: seq,
            steps: stepsJson([
              new AttrStep(at(d, FIELD), 'value', CANARY.refusedValue + 'x'.repeat(4097)),
            ]),
          });
          expect(refused.t, JSON.stringify(refused.d)).toBe('sync.reject');
          // The refusal goes to the client; it must not quote the value either.
          expect(JSON.stringify(refused.d)).not.toContain(CANARY.refusedValue);

          // Alternative text on an inline image (accepted or refused: see the header).
          const image = {
            type: 'image',
            attrs: {
              asset: '0192f0c4-7b1e-7c3a-9a54-0000000000ff',
              width: 480,
              height: 480,
              alt: CANARY.altText,
            },
          };
          const pos = inside(d, 'p3Jq8sLw0aZx1VbN');
          const alt = await submitCommit(owner, {
            id: uuid7(),
            base: seq,
            steps: [{ stepType: 'replace', from: pos, to: pos, slice: { content: [image] } }],
          });
          expect(['sync.ack', 'sync.reject'], JSON.stringify(alt.d)).toContain(alt.t);
        } finally {
          owner.terminate();
        }

        // The control: the committed value is really in the service, and the routes that return
        // field values and content are called, so their access logs exist.
        const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey });
        expect(content.text).toContain(CANARY.committedValue);
        await h.call('GET', `/v1/documents/${doc}/fields`, { token: h.a.apiKey });
        await h.call('GET', `/v1/documents/${doc}/field-values`, { token: h.a.apiKey });

        const metrics = await h.call('GET', '/metrics', { token: METRICS_TOKEN });
        expect(metrics.status, 'the scrape answers with the metrics token').toBe(200);
        expect(h.logs.length, 'the service logged something').toBeGreaterThan(0);
        expect(metrics.text.length, 'the scrape has content').toBeGreaterThan(0);
        expect(spans.length, 'the service recorded request spans').toBeGreaterThan(0);

        const surfaces = [
          { name: 'logs', text: h.logs.join('\n') },
          { name: 'metrics', text: metrics.text },
          { name: 'spans', text: JSON.stringify(spans) },
        ];
        for (const surface of surfaces)
          for (const [name, value] of Object.entries(CANARY))
            expect(surface.text, `${name} must not appear in ${surface.name}`).not.toContain(value);
      },
      60_000,
    );
  });
}
