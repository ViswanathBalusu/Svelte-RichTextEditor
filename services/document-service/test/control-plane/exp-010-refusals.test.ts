// EXP-010 criteria 1 and 2: a caller restricted with `no-export`, and a caller whose token does not
// cover the document, are refused by the export route, and no job is created (09 §9.1; 07 §12 row 12).
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXPORT_KIND, PREVIEW_KIND } from '../../src/control-plane/exports.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`EXP-010 export refusals (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage);
    });

    afterAll(async () => {
      if (!skip) await h.close();
    });

    /** True when the tenant holds no export or preview job for the document. */
    async function noJobFor(doc: string): Promise<boolean> {
      for (const kind of [EXPORT_KIND, PREVIEW_KIND]) {
        if (await h.parts.queue.latestFor(h.tenant, doc, kind)) return false;
      }
      return true;
    }

    it.skipIf(skip)(
      'criterion 1: a caller restricted with no-export is refused and no job is created',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const restricted = h.userToken({ [doc]: 'owner' }, { restrict: ['no-export'] });
        const exported = await h.call('POST', `/v1/documents/${doc}/exports`, {
          token: restricted,
          body: { target: 'pdf' },
        });
        expect(exported.status).toBe(403);
        expect(exported.json.code).toBe('forbidden');
        const preview = await h.call('POST', `/v1/documents/${doc}/exports`, {
          token: restricted,
          body: { target: 'pdf', options: { profile: 'preview' } },
        });
        expect(preview.status).toBe(403);
        expect(preview.json.code).toBe('forbidden');
        expect(await noJobFor(doc)).toBe(true);
      },
    );

    it.skipIf(skip)(
      'criterion 2: a caller whose token does not cover the document is refused with forbidden and no job is created',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const stranger = h.userToken({ [uuid7()]: 'owner' });
        const exported = await h.call('POST', `/v1/documents/${doc}/exports`, {
          token: stranger,
          body: { target: 'pdf' },
        });
        expect(exported.status).toBe(403);
        expect(exported.json.code).toBe('forbidden');
        expect(await noJobFor(doc)).toBe(true);
      },
    );

    it.skipIf(skip)(
      'the control: a caller with view and no restriction gets a job, so the refusals above are not caused by the setup',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const viewer = h.userToken({ [doc]: 'viewer' });
        const accepted = await h.call('POST', `/v1/documents/${doc}/exports`, {
          token: viewer,
          body: { target: 'pdf' },
        });
        expect(accepted.status).toBe(202);
        expect(await noJobFor(doc)).toBe(false);
      },
    );
  });
}
