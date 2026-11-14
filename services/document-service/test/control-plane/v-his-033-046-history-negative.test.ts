// HIS-046 criterion 5 (lane V-HIS-033-046): negative tests over the history routes of the control
// plane, for a reader who holds no grant on the restricted region. The region holds the word
// "Liability" (`documentWithRegions`). No response of a history route may carry that word, its
// paragraph id or its region id. The routes the service does not serve yet (diff, history,
// attribution; HIS-026) are asserted to answer 404 and carry no content, so that the test fails
// when one of them starts to serve without the gate. The restore route, served since HIS-019,
// answers a reader 403 with no content. Memory storage, through the HTTP surface.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const LEGAL = 'rLegal0000000001';
// The region id stays in the placeholder of a hidden region by design (`regionVisible`), so only the
// text and the paragraph id of the hidden region are checked.
const HIDDEN_WORDS = ['Liability', 'pLegal0000000001'];

/**
 * The fixture with the legal region made confidential: only a confidential region hides from a
 * reader without a grant (ADR 0019; `visibility.ts`). `restricted` only limits changes.
 */
function confidentialFixture(): Record<string, unknown> {
  const env = documentWithRegions() as {
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  const body = env.doc.content.find((n) => n.type === 'body')!;
  for (const block of body.content as Array<{ type: string; attrs?: Record<string, unknown> }>)
    if (block.type === 'region' && block.attrs?.['id'] === LEGAL)
      block.attrs['policy'] = 'confidential';
  return env as unknown as Record<string, unknown>;
}

describe('history routes never return hidden content to a reader without the region (HIS-046, negative)', () => {
  let h: Harness;
  let doc: string;
  let reader: string;

  beforeAll(async () => {
    h = await startHarness('memory', {});
    doc = await h.createDocument({ content: confidentialFixture(), title: 'Negative' });
    reader = h.userToken({ [doc]: 'viewer' });
  });
  afterAll(async () => {
    await h?.close();
  });

  const text = (r: { text: string }) => r.text;

  it('serves no hidden text on the served history reads (content, versions, activity, commits)', async () => {
    const paths = [
      `/v1/documents/${doc}/content`,
      `/v1/documents/${doc}/content?seq=0`,
      `/v1/documents/${doc}/versions`,
      `/v1/documents/${doc}/activity`,
      `/v1/documents/${doc}/commits`,
    ];
    for (const path of paths) {
      const r = await h.call('GET', path, { token: reader });
      expect(r.status, path).toBeLessThan(500);
      for (const word of HIDDEN_WORDS) expect(text(r), `${path} leaks ${word}`).not.toContain(word);
    }
  });

  it('refuses a region filter on a hidden scope as if the scope did not exist (HIS-046 criterion 2)', async () => {
    // The served reads take no region filter; the unserved history routes answer 404 for it too.
    for (const path of [
      `/v1/documents/${doc}/diff?fromSeq=0&toSeq=0&region=${LEGAL}`,
      `/v1/documents/${doc}/history?region=${LEGAL}`,
      `/v1/documents/${doc}/attribution?region=${LEGAL}`,
    ]) {
      const r = await h.call('GET', path, { token: reader });
      expect(r.status, path).toBe(404);
      for (const word of HIDDEN_WORDS) expect(text(r)).not.toContain(word);
    }
  });

  it('refuses a restore to a reader with no content in the answer (07 §12: restore needs manage)', async () => {
    // The whole-document restore is served since HIS-019 criterion 1 (lane V-HIS-017-032, ADR
    // 0358). A viewer can see the document but lacks `manage`, so the route answers 403 before it
    // reads the body: a region named in the body, hidden or not, changes nothing.
    for (const body of [{ toSeq: 0, dryRun: true }, { toSeq: 0 }, { toSeq: 0, region: LEGAL }]) {
      const r = await h.call('POST', `/v1/documents/${doc}/restore`, {
        token: reader,
        headers: { 'Idempotency-Key': randomUUID() },
        body,
      });
      expect(r.status, JSON.stringify(body)).toBe(403);
      for (const word of HIDDEN_WORDS) expect(text(r)).not.toContain(word);
    }
  });

  it('refuses a fork to a user credential, so no copy of hidden content is made for a reader', async () => {
    const r = await h.call('POST', `/v1/documents/${doc}/fork`, {
      token: reader,
      headers: { 'Idempotency-Key': randomUUID() },
      body: { atSeq: 0, copyGrants: false },
    });
    expect(r.status).toBe(403);
    for (const word of HIDDEN_WORDS) expect(text(r)).not.toContain(word);
  });
});
