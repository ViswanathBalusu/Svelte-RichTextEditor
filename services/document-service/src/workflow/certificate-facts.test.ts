// FRW-050: the facts of the certificate of completion, from the evidence the service holds
// (docs/adr/0400-w4-FRW-050-certificate-pages.md, proposed).
import { AUTHENTICATION_PHRASE, isWithinLegalStance } from '@docedit/authority';
import { describe, expect, it } from 'vitest';
import { certificateFactsOf } from './certificate-facts.ts';
import { MemoryEvidenceLedger } from './evidence-ledger.ts';
import type { WorkflowResourceView } from './workflow-resource.ts';

const TENANT = 't1';
const DOC = 'd1';
const HASH = 'cd'.repeat(32);

const workflow = {
  id: 'w1',
  doc: DOC,
  state: 'completed',
  rev: 5,
  etag: '"5"',
  sentSeq: 3,
  sentHash: 'sha256:' + 'ee'.repeat(32),
  timeZone: 'UTC',
  participants: [
    { id: 'p1', roles: ['tenant'], kind: 'signer', order: 1, name: 'Ada <b>\\input{x}' },
    { id: 'p2', roles: ['landlord'], kind: 'approver', order: 2 },
  ],
  members: {},
} as unknown as WorkflowResourceView;

async function ledger(captureNetworkIdentity: boolean) {
  const l = new MemoryEvidenceLedger(
    () => 1_000,
    () => ({ captureNetworkIdentity }),
  );
  const net = { ipAddress: '203.0.113.9', userAgent: 'Agent/9' };
  const rec = (participant: string, kind: 'signer' | 'approver', item: string, items: object) =>
    l.record(TENANT, { doc: DOC, participant, kind, item, facts: { items, ...net } });
  await rec('p1', 'signer', 'viewed', { viewedAtMs: 1_100 });
  await rec('p1', 'signer', 'consent', {
    consent: { textId: 't', version: 1, hash: 'h', atMs: 1_200 },
  });
  await rec('p1', 'signer', 'signed', {
    signings: [
      { seq: 5, chainHash: HASH, fieldKey: 'a', atMs: 1_300, mode: 'typed', imageHash: 'x' },
      { seq: 6, chainHash: HASH, fieldKey: 'b', atMs: 1_400, mode: 'typed', imageHash: 'x' },
    ],
  });
  await rec('p1', 'signer', 'completed', { completedAtMs: 1_500 });
  await rec('p2', 'approver', 'completed', { completedAtMs: 1_600 });
  return l;
}

describe('the certificate facts come from the evidence rows (FRW-050 criterion 1)', () => {
  it('lists the identifiers, the sequence numbers, the chain head and each participant’s events with server times', async () => {
    const l = await ledger(true);
    const facts = certificateFactsOf({
      workflow,
      rows: await l.list(TENANT, DOC),
      completedSeq: 40,
      chainHead: HASH,
    });
    expect(facts).toMatchObject({
      documentId: DOC,
      workflowId: 'w1',
      sentSeq: 3,
      completedSeq: 40,
      chainHeadHash: HASH,
      networkIdentityIncluded: true,
    });
    const [p1, p2] = facts.participants;
    expect(p1!.label).toBe('Ada <b>\\input{x}');
    expect(p1!.events.map((e) => [e.kind, e.serverTimeMs])).toEqual([
      ['viewed', 1_100],
      ['consent', 1_200],
      ['signed', 1_300],
      ['signed', 1_400],
      ['completed', 1_500],
    ]);
    expect(p2).toMatchObject({ id: 'p2', label: 'p2' });
    expect(p2!.events.map((e) => e.kind)).toEqual(['completed']);
    expect(p1!.events[0]).toMatchObject({ ipAddress: '203.0.113.9', userAgent: 'Agent/9' });
  });
});

describe('a tenant that switched capture off gets no address or agent (FRW-050 criterion 5)', () => {
  it('drops them from the facts when the setting is off now, whatever the rows stored', async () => {
    const l = await ledger(true); // stored while capture was on
    const facts = certificateFactsOf({
      workflow,
      rows: await l.list(TENANT, DOC),
      completedSeq: 40,
      chainHead: HASH,
      captureSettings: { captureNetworkIdentity: false },
    });
    expect(facts.networkIdentityIncluded).toBe(false);
    expect(JSON.stringify(facts)).not.toContain('203.0.113.9');
    expect(JSON.stringify(facts)).not.toContain('Agent/9');
    for (const p of facts.participants)
      for (const e of p.events) {
        expect('ipAddress' in e).toBe(false);
        expect('userAgent' in e).toBe(false);
      }
  });

  it('has none when the rows were stored with capture off', async () => {
    const l = await ledger(false);
    const rows = await l.list(TENANT, DOC);
    expect(JSON.stringify(rows.map((r) => r.evidence))).not.toContain('203.0.113.9');
    const facts = certificateFactsOf({ workflow, rows, completedSeq: 40, chainHead: HASH });
    expect(JSON.stringify(facts)).not.toContain('203.0.113.9');
  });

  it('reads the ledger’s current setting', async () => {
    expect(await (await ledger(false)).settings(TENANT)).toEqual({ captureNetworkIdentity: false });
  });
});

describe('the certificate wording follows the legal stance (FRW-050 criterion 7)', () => {
  it('has fixed sentences with no overclaim that describe authentication as asserted by the host', async () => {
    const facts = certificateFactsOf({
      workflow,
      rows: await (await ledger(true)).list(TENANT, DOC),
      completedSeq: 40,
      chainHead: HASH,
    });
    expect(facts.statement.length).toBeGreaterThan(0);
    for (const sentence of facts.statement)
      expect(isWithinLegalStance(sentence), sentence).toBe(true);
    expect(facts.statement.join(' ')).toContain(AUTHENTICATION_PHRASE);
    expect(facts.statement.join(' ')).toContain('does not verify identity');
  });
});
