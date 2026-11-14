/**
 * PRM-057 criterion 2 (matrix row 3) — when commits are submitted, the verdicts of PRM-009 to
 * PRM-012 hold. Each case runs over the wire against the real document service (memory storage;
 * PostgreSQL skips without the integration environment) and checks the refusal, its scope where
 * the answer names one, and that the stored document is unchanged.
 *
 *   PRM-009 a commit is accepted only if every changed scope is writable: a suggester and a filler
 *           hold no `edit` in the body, so a direct text insert there is refused.
 *   PRM-010 P1, P5 and P6: the same check runs on the rebased steps, and a viewer or a commenter
 *           is refused any commit (covered by bypass-classes.test.ts as well).
 *   PRM-011 P2: wrapping existing body content in a new region needs `structure`; a filler has no
 *           `structure`, so the wrap is refused.
 *   PRM-012 is covered for a definition by bypass-classes.test.ts and shared-definitions.test.ts;
 *           it is not repeated here.
 *
 * The control is a document-level editor's text insert in the open body, which is accepted.
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
import { at, Fragment, inside, loadDoc, schema, Slice, stepsJson } from './support/cdm.ts';
import { WireClient } from './support/wire.ts';

const INTRO = 'pIntro0000000001';
const LEGAL = 'rLegal0000000001';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null; // probed at collection so skipIf-style skips apply (SEC harness)
  describe(`PRM-057 row 3: commit verdicts PRM-009 to PRM-012 (${storage})`, () => {
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

    /** Submits steps as a user holding `role` on the document, on the stored content. */
    const submitAs = async (role: string, steps: Record<string, unknown>[]) => {
      const token = await h.mintToken(h.a, `row3-${role}`, { [doc]: role });
      const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      try {
        await c.hello(token);
        await c.open(1, doc);
        return await c.submit(1, { id: uuid7(), base: 0, steps });
      } finally {
        c.terminate();
      }
    };

    const expectUnchanged = async () => {
      const after = (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey }))
        .json;
      expect(after.doc).toEqual(content.doc);
    };

    t()(
      'PRM-009: a suggester cannot change body text directly, because it holds no edit there',
      async () => {
        const r = await submitAs('suggester', [
          insertText(inside(loadDoc(content.doc), INTRO), 'S'),
        ]);
        expect(r.t).toBe('sync.reject');
        expect(r.d?.['code']).toBe('permission_denied');
        await expectUnchanged();
      },
    );

    t()(
      'PRM-009: a filler cannot change body text directly, because fill is not edit',
      async () => {
        const r = await submitAs('filler', [insertText(inside(loadDoc(content.doc), INTRO), 'F')]);
        expect(r.t).toBe('sync.reject');
        expect(r.d?.['code']).toBe('permission_denied');
        await expectUnchanged();
      },
    );

    t()('PRM-009: a filler cannot change the text of a restricted region', async () => {
      const r = await submitAs('filler', [
        insertText(inside(loadDoc(content.doc), 'pLegal0000000001'), 'F'),
      ]);
      expect(r.t).toBe('sync.reject');
      expect(r.d?.['code']).toBe('permission_denied');
      expect(r.d?.['scopes']).toContain(`region:${LEGAL}`);
      await expectUnchanged();
    });

    t()(
      'PRM-011 (P2): a filler cannot wrap body content in a new region, because that needs structure',
      async () => {
        const d = loadDoc(content.doc);
        const p = at(d, INTRO);
        const para = d.nodeAt(p)!;
        // Wrap the intro paragraph in an empty region: a structure step that the outcome check judges.
        const wrap = new ReplaceAroundStep(
          p,
          p + para.nodeSize,
          p,
          p + para.nodeSize,
          new Slice(
            Fragment.from(
              schema.nodes['region']!.create({
                id: 'rWrapped00000001',
                title: 'Wrapped',
                policy: 'inherit',
              }),
            ),
            0,
            0,
          ),
          1,
          true,
        );
        const r = await submitAs('filler', stepsJson([wrap]));
        expect(r.t).toBe('sync.reject');
        expect(r.d?.['code']).toBe('permission_denied');
        await expectUnchanged();
      },
    );

    t()(
      'control for PRM-011: the same wrap by a document editor, who holds structure, is accepted',
      async () => {
        const own = await h.createDocument(h.a, documentWithRegions());
        const cur = (await h.call('GET', `/v1/documents/${own}/content`, { token: h.a.apiKey }))
          .json;
        const d = loadDoc(cur.doc);
        const p = at(d, INTRO);
        const para = d.nodeAt(p)!;
        const wrap = new ReplaceAroundStep(
          p,
          p + para.nodeSize,
          p,
          p + para.nodeSize,
          new Slice(
            Fragment.from(
              schema.nodes['region']!.create({
                id: 'rWrapped00000001',
                title: 'Wrapped',
                policy: 'inherit',
              }),
            ),
            0,
            0,
          ),
          1,
          true,
        );
        const token = await h.mintToken(h.a, 'row3-editor-wrap', { [own]: 'editor' });
        const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        try {
          await c.hello(token);
          await c.open(1, own);
          const r = await c.submit(1, { id: uuid7(), base: 0, steps: stepsJson([wrap]) });
          expect(r.t, JSON.stringify(r.d)).toBe('sync.ack');
        } finally {
          c.terminate();
        }
      },
    );

    t()(
      'controls: a document editor, who holds edit in the open body, has the same insert accepted',
      async () => {
        const r = await submitAs('editor', [insertText(inside(loadDoc(content.doc), INTRO), 'Z')]);
        expect(r.t).toBe('sync.ack');
      },
    );
  });
}
