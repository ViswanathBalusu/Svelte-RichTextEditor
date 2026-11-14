/**
 * SEC-027 — every commit that would break the document is refused, so no user can leave a document
 * that cannot be loaded, exported or edited (10 §3.3; 04 §4, §5; 03 §8). The adversarial client
 * submits disallowed step types, malformed step JSON and invariant violations, and a separate check
 * replays the stored log from the start in a fresh authority.
 *
 * The step-validation fuzz target (SEC-059) and the model's invariant suite cover every invariant
 * and step type exhaustively (I1–I15); this file is the end-to-end gate for the reachable classes.
 */
import { AddMarkStep, AttrStep } from 'prosemirror-transform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySteps, parseSteps } from '@docedit/authority';
import { cdmSchema } from '@docedit/model/prosemirror';
import { uuid7 } from '@docedit/model';
import {
  documentWithRegions,
  insertText,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { at, inside, loadDoc, node, schema, stepsJson } from './support/cdm.ts';
import { WireClient } from './support/wire.ts';

const UNLIMITED = { maxStepsPerCommit: 1e6, maxCommitBytes: 1e9, maxRebaseSteps: 1e9 };

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null; // probed at collection so skipIf-style skips apply (SEC harness)
  describe(`SEC-027 corrupting commits are refused (${storage})`, () => {
    let h: Harness;
    let doc: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the CDM content envelope
    let content: any;
    beforeAll(async () => {
      if (!skip) {
        h = await startHarness(storage);
        doc = await h.createDocument(h.a, documentWithRegions());
        content = (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey })).json;
      }
    });
    afterAll(async () => {
      await h?.close();
    });
    const t = () => (skip ? it.skip : it);

    const editor = async () => {
      const token = await h.mintToken(h.a, 'ann', { [doc]: 'editor' });
      const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      await c.hello(token);
      await c.open(1, doc);
      return c;
    };
    const headSeq = async () =>
      (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey })).json
        .seq as number;

    t()(
      'refuses step types outside the allow-list and malformed step JSON with invalid_op',
      async () => {
        const c = await editor();
        try {
          const before = await headSeq();
          const cases: Array<{ what: string; steps: unknown[] }> = [
            { what: 'docAttr', steps: [{ stepType: 'docAttr', attr: 'x', value: 1 }] },
            { what: 'unknown type', steps: [{ stepType: 'frobnicate', from: 1, to: 1 }] },
            {
              what: 'malformed known type',
              steps: [{ stepType: 'replace', from: 'oops', to: {} }],
            },
            { what: 'no stepType', steps: [{ from: 1, to: 1 }] },
          ];
          for (const { what, steps } of cases) {
            const r = await c.submit(1, { id: uuid7(), base: 0, steps });
            // Refused either by the codec (envelope `error` bad_message) or by the authority
            // (`sync.reject` invalid_op); either way the commit never reaches the log.
            expect(['error', 'sync.reject'], what).toContain(r.t);
            expect(['bad_message', 'invalid_op'], what).toContain(r.d?.['code']);
          }
          expect(await headSeq()).toBe(before); // the document is unchanged
        } finally {
          c.terminate();
        }
      },
    );

    t()('refuses a commit that violates an invariant, leaving the document unchanged', async () => {
      const c = await editor();
      try {
        const before = await headSeq();
        const d = loadDoc(content.doc);
        const intro = node(d, 'pIntro0000000001');
        const introStart = inside(d, 'pIntro0000000001');

        // I2: a non-null id never changes.
        const i2 = await c.submit(1, {
          id: uuid7(),
          base: 0,
          steps: stepsJson([new AttrStep(at(d, 'pIntro0000000001'), 'id', 'pEnd000000000001')]),
        });
        expect(i2.d?.['code']).toBe('invalid_op');

        // I9 / I11: a link with a forbidden scheme (the grammar keeps hostile URLs out).
        const i9 = await c.submit(1, {
          id: uuid7(),
          base: 0,
          steps: stepsJson([
            new AddMarkStep(
              introStart,
              introStart + 'Hello'.length,
              schema.marks['link']!.create({ href: 'javascript:alert(1)' }),
            ),
          ]),
        });
        expect(i9.d?.['code']).toBe('invalid_op');

        // I11: an attribute value outside its grammar (align is start | center | end | null).
        const i11 = await c.submit(1, {
          id: uuid7(),
          base: 0,
          steps: stepsJson([new AttrStep(at(d, 'pIntro0000000001'), 'align', 'sideways')]),
        });
        expect(i11.d?.['code']).toBe('invalid_op');

        // I7: a `latex` attribute longer than 4,000 characters.
        const eqn = schema.nodes['equation']!.create({ latex: 'x'.repeat(4001) });
        const i7 = await c.submit(1, {
          id: uuid7(),
          base: 0,
          steps: [
            {
              stepType: 'replace',
              from: introStart + intro.content.size,
              to: introStart + intro.content.size,
              slice: { content: [eqn.toJSON()] },
            },
          ],
        });
        expect(i7.d?.['code']).toBe('invalid_op');

        expect(await headSeq()).toBe(before);
      } finally {
        c.terminate();
      }
    });

    t()(
      'every stored commit replays from the start in a fresh authority (no commit corrupts the log)',
      async () => {
        // A scenario of accepted edits from two editors, some rebased.
        const a = await editor();
        const token = await h.mintToken(h.a, 'ben', { [doc]: 'editor' });
        const b = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        await b.hello(token);
        await b.open(1, doc);
        try {
          const introStart = inside(loadDoc(content.doc), 'pIntro0000000001');
          expect(
            (await a.submit(1, { id: uuid7(), base: 0, steps: [insertText(introStart, 'AAA')] })).t,
          ).toBe('sync.ack');
          expect(
            (await b.submit(1, { id: uuid7(), base: 0, steps: [insertText(introStart, 'B')] })).t,
          ).toBe('sync.ack');
          const head = await headSeq();
          expect(head).toBeGreaterThanOrEqual(2);

          // Replay the stored log on the content at seq 0, as a cold room would on open.
          const ref = { tenant: h.a.id, doc };
          const env = await h.service.checkpoints.get(ref, 0);
          expect(env).not.toBeNull();
          const freshSchema = cdmSchema();
          let node0 = freshSchema.nodeFromJSON(env!.doc);
          node0.check();
          const log = await h.parts.logs.read(ref, 1);
          expect(log.length).toBe(head);
          for (const commit of log) {
            if (commit.steps.length === 0) continue; // a control commit changes no content
            const parsed = parseSteps(freshSchema, commit.steps, UNLIMITED);
            expect(parsed.ok, `commit ${commit.seq} parses`).toBe(true);
            if (!parsed.ok) break;
            const applied = applySteps(node0, parsed.value);
            expect(applied.ok, `commit ${commit.seq} applies`).toBe(true);
            if (!applied.ok) break;
            node0 = applied.value.doc;
          }
          node0.check(); // the replayed document is valid: it can be loaded and edited
        } finally {
          a.terminate();
          b.terminate();
        }
      },
    );
  });
}
