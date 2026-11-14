/**
 * SEC-025 — checks run on the rebased steps, so a commit built on a false or stale base cannot land
 * where its author could not write (10 §3.3; 04 §5, §6; 07 §16). The adversarial client submits
 * commits with chosen `base` values and inspects the stored steps.
 *
 * A `base` more than maxRebaseSteps (5,000) behind is reached with eleven 500-step commits (the
 * per-commit maximum). A `base` before a snapshot is not reachable as a black-box test yet: it needs
 * the snapshot route (`PUT /content`, BE-037), which this server does not serve. The authority's own
 * snapshot tests cover that branch (SEC-025 Notes).
 */
import { ReplaceAroundStep } from 'prosemirror-transform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import {
  documentWithRegions,
  insertText,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { at, Fragment, inside, loadDoc, node, schema, Slice, stepsJson } from './support/cdm.ts';
import { WireClient } from './support/wire.ts';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null; // probed at collection so skipIf-style skips apply (SEC harness)
  describe(`SEC-025 rebase tricks cannot bypass checks (${storage})`, () => {
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });
    const t = () => (skip ? it.skip : it);

    const open = async (sub: string, role: string, doc: string) => {
      const token = await h.mintToken(h.a, sub, { [doc]: role });
      const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      await c.hello(token);
      await c.open(1, doc);
      return c;
    };
    const contentOf = async (doc: string) =>
      (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey })).json;

    t()(
      'steps built on an old base that map into a protected region are refused once rebased',
      async () => {
        const doc = await h.createDocument(h.a, documentWithRegions());
        const c0 = await contentOf(doc);
        const owner = await open('olivia', 'owner', doc);
        const editor = await open('ed', 'editor', doc);
        try {
          // The owner wraps the intro paragraph in a new restricted region (structure + manage).
          const d0 = loadDoc(c0.doc);
          const p = at(d0, 'pIntro0000000001');
          const end = p + node(d0, 'pIntro0000000001').nodeSize;
          const wrap = new ReplaceAroundStep(
            p,
            end,
            p,
            end,
            new Slice(
              Fragment.from(
                schema.nodes['region']!.create({ id: 'rWrap00000000001', policy: 'restricted' }),
              ),
              0,
              0,
            ),
            1,
            true,
          );
          const wrapped = await owner.submit(1, { id: uuid7(), base: 0, steps: stepsJson([wrap]) });
          expect(wrapped.t).toBe('sync.ack');

          // The editor's commit was made against the old document and names the intro's old position.
          // Once rebased past the wrap it lands inside the restricted region; the mapped steps are
          // checked, not the sent ones, so it is refused.
          const stale = await editor.submit(1, {
            id: uuid7(),
            base: 0,
            steps: [insertText(inside(d0, 'pIntro0000000001'), 'pwned')],
          });
          expect(stale.t).toBe('sync.reject');
          expect(stale.d?.['code']).toBe('permission_denied');
          expect(stale.d?.['scopes']).toContain('region:rWrap00000000001');
        } finally {
          owner.terminate();
          editor.terminate();
        }
      },
    );

    t()(
      'a base above the tentative head is refused with invalid_op and action reload',
      async () => {
        const doc = await h.createDocument(h.a, documentWithRegions());
        const c = await open('ann', 'editor', doc);
        try {
          const r = await c.submit(1, { id: uuid7(), base: 999, steps: [insertText(1, 'x')] });
          expect(r.t).toBe('sync.reject');
          expect(r.d?.['code']).toBe('invalid_op');
          expect(r.d?.['action']).toBe('reload');
        } finally {
          c.terminate();
        }
      },
    );

    t()(
      'an accepted rebased commit stores the mapped steps, not the steps the client sent',
      async () => {
        const doc = await h.createDocument(h.a, documentWithRegions());
        const c0 = await contentOf(doc);
        const a = await open('ann', 'editor', doc);
        const b = await open('ben', 'editor', doc);
        try {
          const introStart = inside(loadDoc(c0.doc), 'pIntro0000000001');
          // A inserts five characters at the start of the intro.
          const ackA = await a.submit(1, {
            id: uuid7(),
            base: 0,
            steps: [insertText(introStart, 'AAAAA')],
          });
          expect(ackA.t).toBe('sync.ack');
          // B submits against the old base with the same start position; its step must be rebased.
          const sentFrom = introStart;
          const ackB = await b.submit(1, {
            id: uuid7(),
            base: 0,
            steps: [insertText(sentFrom, 'B')],
          });
          expect(ackB.t).toBe('sync.ack');
          expect(ackB.d?.['rebased']).toBe(true);

          // The stored step for B's commit (seq 2) has the mapped position, not the sent one.
          const [, stored] = await h.parts.logs.read({ tenant: h.a.id, doc }, 1, 2);
          const storedStep = stored!.steps[0] as unknown as { from: number };
          expect(storedStep.from).toBe(sentFrom + 5);
          expect(storedStep.from).not.toBe(sentFrom);
        } finally {
          a.terminate();
          b.terminate();
        }
      },
    );

    t()(
      'steps that cannot be mapped onto the current document are refused, never stored as sent',
      async () => {
        const doc = await h.createDocument(h.a, documentWithRegions());
        const c0 = await contentOf(doc);
        const a = await open('ann', 'editor', doc);
        const b = await open('ben', 'editor', doc);
        try {
          const d0 = loadDoc(c0.doc);
          const introStart = inside(d0, 'pIntro0000000001');
          // A deletes the whole intro text, so B's base-0 edit of that text no longer maps cleanly.
          const del = await a.submit(1, {
            id: uuid7(),
            base: 0,
            steps: [{ stepType: 'replace', from: introStart, to: introStart + 'Hello'.length }],
          });
          expect(del.t).toBe('sync.ack');
          const r = await b.submit(1, {
            id: uuid7(),
            base: 0,
            steps: [
              {
                stepType: 'replace',
                from: introStart + 1,
                to: introStart + 4,
                slice: { content: [{ type: 'text', text: 'X' }] },
              },
            ],
          });
          // Either the rebase maps it safely (ack) or it is refused; it is never stored as sent.
          if (r.t === 'sync.ack') {
            const commits = await h.parts.logs.read({ tenant: h.a.id, doc }, 2, 2);
            expect(JSON.stringify(commits[0]?.steps)).not.toContain(`"from":${introStart + 1}`);
          } else {
            expect(r.t).toBe('sync.reject');
          }
        } finally {
          a.terminate();
          b.terminate();
        }
      },
    );

    t()(
      'a base more than maxRebaseSteps (5,000) behind is refused with stale_base; 5,000 is accepted',
      async () => {
        const doc = await h.createDocument(h.a, documentWithRegions());
        const owner = await open('olivia', 'owner', doc);
        const editor = await open('ed', 'editor', doc);
        try {
          const pos = inside(loadDoc((await contentOf(doc)).doc), 'pIntro0000000001');
          // Eleven commits of 500 steps each (the per-commit maximum): 5,500 stored steps.
          for (let i = 0; i < 11; i++) {
            const head = (await contentOf(doc)).seq as number;
            const steps = Array.from({ length: 500 }, () => insertText(pos, 'x'));
            const r = await owner.submit(1, { id: uuid7(), base: head, steps });
            expect(r.t).toBe('sync.ack');
          }
          const head = (await contentOf(doc)).seq as number;

          // Eleven commits back is 5,500 steps: more than maxRebaseSteps, so refused.
          const stale = await editor.submit(1, {
            id: uuid7(),
            base: head - 11,
            steps: [insertText(pos, 'pwned')],
          });
          expect(stale.t).toBe('sync.reject');
          expect(stale.d?.['code']).toBe('stale_base');

          // Ten commits back is exactly 5,000 steps: at the limit, not above it, so accepted.
          const atLimit = await editor.submit(1, {
            id: uuid7(),
            base: head - 10,
            steps: [insertText(pos, 'ok')],
          });
          expect(atLimit.t).toBe('sync.ack');
        } finally {
          owner.terminate();
          editor.terminate();
        }
      },
    );
  });
}
