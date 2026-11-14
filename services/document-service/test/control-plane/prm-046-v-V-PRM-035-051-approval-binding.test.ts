// PRM-046 criterion 3 (lane V-PRM-035-051): an approval stores the `seq` and the SHA-256 of the
// region's canonical content at that `seq`, computed by the server, and a change to any other state
// clears that binding. Over HTTP, with memory storage and with PostgreSQL (the region_states row).
// Runs with memory and PostgreSQL (each run creates and drops its own database, test/support/env.ts).
// Start PostgreSQL first:
//   pwsh -NoProfile -File infra/test-env.ps1 up
//   pnpm vitest run test/control-plane/prm-046-v-V-PRM-035-051-approval-binding.test.ts
// (in services/document-service)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from '../../test/control-plane/support.ts';

const LEGAL = 'rLegal0000000001';
const HEX64 = /^[0-9a-f]{64}$/;

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`the approval binding (PRM-046 criterion 3, ${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, {});
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)('binds the approval to the head seq and a server-computed hash', async () => {
      const doc = await h.createDocument({
        content: documentWithRegions(),
        title: 'Binding owner',
      });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: 'owner-046-binding' });
      const grants = await h.call('GET', `/v1/documents/${doc}/grants`, { token: owner });
      expect(grants.status).toBe(200);
      const put = await h.call('PUT', `/v1/documents/${doc}/regions/${LEGAL}/state`, {
        token: owner,
        body: { state: 'approved', seq: 999, hash: 'a'.repeat(64) },
        headers: { 'If-Match': grants.headers.get('etag')! },
      });
      expect(put.status, put.text).toBe(200);
      const seq = put.json.seq as number;
      const hash = put.json.hash as string;
      expect(typeof seq).toBe('number');
      expect(seq).not.toBe(999); // a client-supplied seq or hash is not taken
      expect(hash).toMatch(HEX64);
      expect(hash).not.toBe('a'.repeat(64));

      if (storage === 'postgres') {
        const row = (
          await h.db!.admin.query<{ state: string; approved_seq: string; content_hash: string }>(
            "SELECT state, approved_seq, encode(content_hash, 'hex') AS content_hash FROM region_states WHERE doc_id = $1 AND region_id = $2",
            [doc, LEGAL],
          )
        ).rows[0];
        expect(row).toBeDefined();
        expect(row!.state).toBe('approved');
        expect(Number(row!.approved_seq)).toBe(seq);
        expect(row!.content_hash).toBe(hash);
      }
    });

    it.skipIf(skip)('clears the binding when the region leaves approved', async () => {
      const doc = await h.createDocument({
        content: documentWithRegions(),
        title: 'Binding reopen',
      });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: 'owner-046-reopen' });
      let g = await h.call('GET', `/v1/documents/${doc}/grants`, { token: owner });
      const approve = await h.call('PUT', `/v1/documents/${doc}/regions/${LEGAL}/state`, {
        token: owner,
        body: { state: 'approved' },
        headers: { 'If-Match': g.headers.get('etag')! },
      });
      expect(approve.status, approve.text).toBe(200);

      g = await h.call('GET', `/v1/documents/${doc}/grants`, { token: owner });
      const draft = await h.call('PUT', `/v1/documents/${doc}/regions/${LEGAL}/state`, {
        token: owner,
        body: { state: 'draft' },
        headers: { 'If-Match': g.headers.get('etag')! },
      });
      expect(draft.status, draft.text).toBe(200);
      expect(draft.json.hash).toBeUndefined();
      expect(draft.json.seq).toBeUndefined();

      if (storage === 'postgres') {
        const row = (
          await h.db!.admin.query<{ approved_seq: string | null; content_hash: string | null }>(
            "SELECT approved_seq, encode(content_hash, 'hex') AS content_hash FROM region_states WHERE doc_id = $1 AND region_id = $2",
            [doc, LEGAL],
          )
        ).rows[0];
        // A draft region has no stored state row or a row with both binding columns null.
        if (row) {
          expect(row.approved_seq).toBeNull();
          expect(row.content_hash).toBeNull();
        }
      }
    });
  });
}
