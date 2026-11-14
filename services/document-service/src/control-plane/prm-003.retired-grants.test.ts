// PRM-003 criterion 5: once a commit retires a region, `GET /v1/documents/{id}/grants` no longer
// lists the region's grants (07 §3; PRO-051). Memory storage, over the HTTP surface of the test
// harness. The PostgreSQL run is not made here (it needs a running PostgreSQL; the storage is the
// same interface).
import type { StoredCommit, WriteRequest } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  startHarness,
  type Harness,
} from '../../test/control-plane/support.ts';

const LEGAL = 'rLegal0000000001';

describe('grants of a retired region are not listed (PRM-003 criterion 5, memory storage)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness('memory', {});
  });
  afterAll(async () => {
    await h?.close();
  });

  it('stops listing a region grant once a commit retires the region', async () => {
    const doc = await h.createDocument({ content: documentWithRegions(), title: 'Retire' });
    const ref = { tenant: h.tenant, doc };

    // A grant on the region, set through the control plane.
    const before = await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.apiKey });
    expect(before.status).toBe(200);
    const put = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
      token: h.apiKey,
      headers: { 'If-Match': before.headers.get('etag')! },
      body: { grants: [{ region: LEGAL, principal: 'user:alice', role: 'viewer' }] },
    });
    expect(put.status).toBe(200);
    const listed = await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.apiKey });
    expect(listed.json.grants.filter((g: { region?: string }) => g.region === LEGAL)).toHaveLength(
      1,
    );

    // A commit that removes the region: it retires the region (I3) in the same log write.
    const head = await h.parts.logs.head(ref);
    const epoch = await h.parts.ownership.claim(ref, 'node-prm-003');
    const { revision } = await h.parts.grants.current(ref);
    const seq = head.seq + 1;
    const commit: StoredCommit = {
      seq,
      id: uuid7(),
      kind: 'steps',
      steps: [
        { stepType: 'replace', from: 3, to: 3, slice: { content: [{ type: 'text', text: 'x' }] } },
      ],
      user: 'owner',
      session: 's-owner',
      time: 1_760_000_000_000,
      origin: 'input',
      scopes: ['body', `region:${LEGAL}`],
      revision,
      cdm: 1,
      engine: 'pm-steps/1',
      retired: [LEGAL],
      claimed: [],
    };
    const write: WriteRequest = { epoch, revision, fromSeq: seq, commits: [commit] };
    expect(await h.parts.logs.append(ref, write)).toEqual({ status: 'ok' });
    expect(await h.parts.grants.retired(ref)).toEqual([LEGAL]);

    // The grants resource no longer names the retired region.
    const after = await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.apiKey });
    expect(after.status).toBe(200);
    expect(after.json.grants.filter((g: { region?: string }) => g.region === LEGAL)).toEqual([]);
  });
});
