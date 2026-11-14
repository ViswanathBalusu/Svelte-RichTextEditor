// Fork provenance (HIS-022 criterion 2; 08 §8): a copy records the source document and the `seq`
// it was copied at, and an original that was never forked records neither. Lane V-HIS-017-032.
// Runs on memory and on PostgreSQL (FND-010 integration environment: pwsh -NoProfile -File
// infra/test-env.ps1 up). Each PostgreSQL harness creates its own database and drops it on close.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const unavailable = await skipReason('postgres');
if (unavailable) console.warn(`skipped: ${unavailable}`);

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe.skipIf(storage === 'postgres' && unavailable !== null)(
    `fork provenance (HIS-022 criterion 2, ${storage})`,
    () => {
      let h: Harness;

      beforeAll(async () => {
        h = await startHarness(storage, {});
      });
      afterAll(async () => {
        await h?.close();
      });

      const fork = (doc: string, body: Record<string, unknown>) =>
        h.call('POST', `/v1/documents/${doc}/fork`, {
          token: h.apiKey,
          headers: { 'Idempotency-Key': randomUUID() },
          body,
        });

      it('records the source and the seq the copy was made at', async () => {
        const source = await h.createDocument({
          content: documentWithRegions(),
          title: 'HIS-022 provenance',
        });
        const r = await fork(source, { atSeq: 0 });
        expect(r.status).toBe(201);
        const copy = r.json.id as string;
        const record = await h.parts.documents.get({ tenant: h.tenant, doc: copy });
        expect(record).not.toBeNull();
        expect(record!.forkedFrom).toBe(source);
        expect(record!.forkedAtSeq).toBe(0);
      });

      it('records the same provenance again on a second fork, and leaves the original without any', async () => {
        const source = await h.createDocument({
          content: documentWithRegions(),
          title: 'HIS-022 original',
        });
        const first = (await fork(source, { atSeq: 0, copyGrants: true })).json.id as string;
        const second = (await fork(first, { atSeq: 0 })).json.id as string;
        const firstRecord = await h.parts.documents.get({ tenant: h.tenant, doc: first });
        const secondRecord = await h.parts.documents.get({ tenant: h.tenant, doc: second });
        expect(firstRecord!.forkedFrom).toBe(source);
        expect(secondRecord!.forkedFrom).toBe(first);
        const original = await h.parts.documents.get({ tenant: h.tenant, doc: source });
        expect(original!.forkedFrom ?? null).toBeNull();
        expect(original!.forkedAtSeq ?? null).toBeNull();
      });

      it('gives the copy its own incarnation and an empty log, apart from the checkpoint at seq 0', async () => {
        const source = await h.createDocument({
          content: documentWithRegions(),
          title: 'HIS-022 log',
        });
        const copy = (await fork(source, { atSeq: 0 })).json.id as string;
        const sourceHead = await h.parts.logs.head({ tenant: h.tenant, doc: source });
        const copyHead = await h.parts.logs.head({ tenant: h.tenant, doc: copy });
        expect(copyHead.incarnation).not.toBe(sourceHead.incarnation);
        expect(copyHead.seq).toBe(0);
        // Its own hash chain starts empty: the copy has no commit yet, only the checkpoint at seq 0.
        expect((await h.parts.logs.state!({ tenant: h.tenant, doc: copy })).chainHead).toBeNull();
      });
    },
  );
}
