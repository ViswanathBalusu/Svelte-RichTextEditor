// PRO-013 criterion 3: a service call that names a user in `DEP-Actor` and changes a document is
// attributed by history to that user. The real data plane writes the change (not the stub), and
// the log, the commit list and the attribution route (HIS-014, HIS-015; PRO-055) are read back.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

/** The regions fixture with the introduction's text replaced. */
function replacement(text: string): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    doc: { content: Array<{ type: string; content: Array<Record<string, unknown>> }> };
  };
  const intro = d.doc.content[1]!.content[0]!;
  intro['content'] = [{ type: 'text', text }];
  return d as unknown as Record<string, unknown>;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`a service call acting for a user is attributed to that user (${storage}; PRO-013 criterion 3)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { realDataPlane: true });
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'names the DEP-Actor as the author of the commit and of the text it wrote',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const owner = h.userToken({ [doc]: 'owner' });
        const head = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
        const first = await h.call('PUT', `/v1/documents/${doc}/content`, {
          token: h.apiKey,
          body: replacement('Written by ivy'),
          headers: { 'If-Match': head.headers.get('etag')!, 'DEP-Actor': 'ivy' },
        });
        expect(first.status).toBe(204);

        // The log's commit is the user's, as a surrogate; a content replacement is a snapshot commit,
        // which the commit list does not page (it answers `conflict`).
        const ref = { tenant: h.tenant, doc };
        const log = await h.parts.logs.read(ref, 1, 1);
        expect(log[0]!.user).toBe((await h.parts.users.resolve(h.tenant, 'ivy')).surrogate);

        // The attribution route says the same of the text the call wrote.
        const attribution = await h.call('GET', `/v1/documents/${doc}/attribution`, {
          token: owner,
        });
        expect(attribution.status).toBe(200);
        expect(attribution.json.seq).toBe(1);
        expect(attribution.json.spans.length).toBeGreaterThan(0);
        expect(attribution.json.spans.every((s: { user: string }) => s.user === 'ivy')).toBe(true);
        expect(attribution.text).not.toContain('service');

        // A call by the same credential with another actor is attributed to that actor.
        const again = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
        const second = await h.call('PUT', `/v1/documents/${doc}/content`, {
          token: h.apiKey,
          body: replacement('Written by jo'),
          headers: { 'If-Match': again.headers.get('etag')!, 'DEP-Actor': 'jo' },
        });
        expect(second.status).toBe(204);
        const later = await h.call('GET', `/v1/documents/${doc}/attribution`, { token: owner });
        expect(later.json.seq).toBe(2);
        expect(later.json.spans.every((s: { user: string }) => s.user === 'jo')).toBe(true);
      },
    );
  });
}
