/**
 * SEC-030 criterion 3: the approval record's hash equals the hash of the region's canonical content,
 * and a mismatch is reported (07 §11). The check is `checkApprovalHash` and `checkApprovals` of
 * packages/authority/src/permissions/approval-check.ts, run on the real base document of the authority
 * fixtures. Node.js only (vitest, fast-check). No network, no Podman.
 *
 * These are unit checks of the comparison. The criterion is proved through the room and the room
 * host, with the approval record of `room.regionApproval`, in sec-030-approval-wiring.test.ts.
 */
import fc from 'fast-check';
import { Transform } from 'prosemirror-transform';

import { describe, expect, it } from 'vitest';
import {
  checkApprovalHash,
  checkApprovals,
} from '../../../packages/authority/src/permissions/approval-check.ts';
import { approvalHash } from '../../../packages/authority/src/permissions/states.ts';
import { baseDoc, posInside, posOf, schema } from '../../../packages/authority/test/fixtures.ts';

const TERMS = 'rTerms000000000A';
const PARA = 'pTerms000000001A';
const RUNS = Number(process.env['FUZZ_RUNS'] ?? 50);

describe('SEC-030 criterion 3: an approval hash matches the region it approves', () => {
  it('accepts the hash of the region as it is', async () => {
    const doc = baseDoc();
    const region = doc.nodeAt(posOf(doc, TERMS))!;
    const hash = await approvalHash(region);
    const check = await checkApprovalHash(region, { seq: 1, hash });
    expect(check).toEqual({ ok: true, hash });
  });

  it('reports a mismatch when the content changes after approval', async () => {
    const doc = baseDoc();
    const approved = doc.nodeAt(posOf(doc, TERMS))!;
    const hash = await approvalHash(approved);
    const edited = new Transform(doc).insert(posInside(doc, PARA), schema.text('Changed ')).doc;
    const region = edited.nodeAt(posOf(edited, TERMS))!;
    const check = await checkApprovalHash(region, { seq: 1, hash });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe('approval_mismatch');
    expect(check.expected).toBe(hash);
    expect(check.actual).toBe(await approvalHash(region));
    expect(check.actual).not.toBe(hash);
  });

  it('reports a mismatch for any stored hash that is not the region hash', async () => {
    const doc = baseDoc();
    const region = doc.nodeAt(posOf(doc, TERMS))!;
    const actual = await approvalHash(region);
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[0-9a-f]{64}$/), async (stored) => {
        fc.pre(stored !== actual);
        const check = await checkApprovalHash(region, { seq: 1, hash: stored });
        expect(check.ok).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });

  it('reports an approved region that is missing from the document', async () => {
    const doc = baseDoc();
    const region = doc.nodeAt(posOf(doc, TERMS))!;
    const hash = await approvalHash(region);
    const report = await checkApprovals(
      new Map<string, typeof region | null>([[TERMS, null]]),
      new Map([[TERMS, { seq: 1, hash }]]),
    );
    expect(report).toHaveLength(1);
    expect(report[0]!.region).toBe(TERMS);
    expect(report[0]!.check.reason).toMatch(/not in the document/);
  });

  it('reports nothing for a matching approval and reports a stale one', async () => {
    const doc = baseDoc();
    const region = doc.nodeAt(posOf(doc, TERMS))!;
    const hash = await approvalHash(region);
    expect(
      await checkApprovals(new Map([[TERMS, region]]), new Map([[TERMS, { seq: 1, hash }]])),
    ).toEqual([]);
    const stale = await checkApprovals(
      new Map([[TERMS, region]]),
      new Map([[TERMS, { seq: 1, hash: 'b'.repeat(64) }]]),
    );
    expect(stale.map((r) => r.region)).toEqual([TERMS]);
  });
});
