// Replacing a document's content as a snapshot (BE-037 criteria 2 to 4): the control plane refuses
// content that breaks the CDM, content above the canonical size, and a replacement that would
// change an approved region or runs while a workflow is active. The data plane is a stand-in that
// records what it is given (criterion 1 needs the outbox and the rooms, and is not tested here).
// Runs over HTTP with the harness of test/control-plane, in memory and on PostgreSQL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from '../../test/control-plane/support.ts';
import type { DocRef } from '../storage/types.ts';

const LEGAL = 'rLegal0000000001';
const LEGAL_PARAGRAPH = 'pLegal0000000001';

/** A fresh copy of the fixture, so that a test can change it without touching the others. */
function fixture(): {
  cdm: number;
  requires: unknown[];
  doc: { type: string; content: Array<{ type: string; content: Array<Record<string, unknown>> }> };
} {
  return JSON.parse(JSON.stringify(documentWithRegions()));
}

/** The paragraphs of the body (the second child of the document). */
function bodyOf(content: ReturnType<typeof fixture>): Array<Record<string, unknown>> {
  return content.doc.content[1]!.content;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`PUT /documents/{id}/content (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    /** What the stand-in data plane was asked to store, in order. */
    const stored: unknown[] = [];

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage);
      h.stub.replaceContent = async (_ref, content) => {
        stored.push(content);
        return { seq: stored.length };
      };
    });
    afterAll(async () => {
      await h?.close();
    });

    const create = () => h.createDocument({ content: documentWithRegions() });
    const etagOf = async (doc: string) =>
      (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey })).headers.get(
        'etag',
      )!;
    const put = async (doc: string, body: unknown) =>
      h.call('PUT', `/v1/documents/${doc}/content`, {
        token: h.apiKey,
        body,
        headers: { 'If-Match': await etagOf(doc) },
      });

    it.skipIf(skip)(
      'refuses content that fails the CDM invariants with validation_failed and stores nothing (BE-037 criterion 2)',
      async () => {
        const doc = await create();
        const before = stored.length;
        // A second paragraph with the id of the first breaks the uniqueness of identifiers.
        const broken = fixture();
        bodyOf(broken).push({
          type: 'paragraph',
          attrs: { id: 'pIntro0000000001', style: 'Normal' },
          content: [{ type: 'text', text: 'again' }],
        });
        const refused = await put(doc, broken);
        expect(refused.status).toBe(400);
        expect(refused.json.code).toBe('validation_failed');
        expect(stored.length).toBe(before);
        // The control: the same content without the duplicate is stored.
        const ok = await put(doc, fixture());
        expect(ok.status).toBe(204);
        expect(stored.length).toBe(before + 1);
      },
    );

    it.skipIf(skip)(
      'refuses a body above the 16 MiB canonical limit with too_large and stores nothing (BE-037 criterion 3)',
      async () => {
        const doc = await create();
        const before = stored.length;
        const big = fixture();
        bodyOf(big).push({
          type: 'paragraph',
          attrs: { id: 'pBig00000000001', style: 'Normal' },
          content: [{ type: 'text', text: 'x'.repeat(16 * 1024 * 1024) }],
        });
        const refused = await h.call('PUT', `/v1/documents/${doc}/content`, {
          token: h.apiKey,
          raw: JSON.stringify(big),
          headers: { 'If-Match': await etagOf(doc), 'Content-Type': 'application/json' },
        });
        expect(refused.json.code).toBe('too_large');
        expect(stored.length).toBe(before);
      },
    );

    it.skipIf(skip)(
      'refuses a change to an approved region, and any replacement while a workflow is active (BE-037 criterion 4; PRM-046, PRM-047)',
      async () => {
        const doc = await create();
        const ref: DocRef = { tenant: h.tenant, doc };
        await h.parts.grants.change(
          ref,
          { setRegionStates: [{ region: LEGAL, state: 'approved' }] },
          { actor: 'system' },
        );
        const before = stored.length;
        const amended = fixture();
        const legal = bodyOf(amended)[1]!;
        expect(legal['attrs']).toMatchObject({ id: LEGAL });
        const paragraph = (legal['content'] as Array<Record<string, unknown>>)[0]!;
        expect(paragraph['attrs']).toMatchObject({ id: LEGAL_PARAGRAPH });
        paragraph['content'] = [{ type: 'text', text: 'Liability, amended' }];
        const conflict = await put(doc, amended);
        expect(conflict.json.code).toBe('conflict');
        expect(stored.length).toBe(before);
        // The control: the same content with the approved region as it stands is stored.
        expect((await put(doc, fixture())).status).toBe(204);
        expect(stored.length).toBe(before + 1);
        // A workflow refuses every replacement, whatever the content.
        await h.parts.grants.change(ref, { workflowActive: true }, { actor: 'system' });
        const flow = await put(doc, fixture());
        expect(flow.json.code).toBe('workflow_active');
        expect(stored.length).toBe(before + 1);
      },
    );
  });
}
