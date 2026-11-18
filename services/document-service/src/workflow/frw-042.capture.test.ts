// FRW-042 criteria 1 and 3, at the evidence ledger: the events a signer's evidence holds (view,
// consent, signing and completion) keep or drop the IP address and the user agent according to the
// tenant's capture setting. The participant endpoints call this ledger, so the rule is the same
// there; the endpoint-level run of criterion 1 is not in this file (see the story's Notes).
import { describe, expect, it } from 'vitest';
import { DEFAULT_CAPTURE_SETTINGS, type CaptureSettings } from '@docedit/authority';
import { MemoryEvidenceLedger, type EvidenceRecordEvent } from './evidence-ledger.ts';

const NETWORK = { ipAddress: '203.0.113.7', userAgent: 'Agent/1.0' };

/** The four events of the criteria: view, consent, signing and completion of one signer. */
function signerEvents(): EvidenceRecordEvent[] {
  const base = { doc: 'doc-1', participant: 'signer-1', kind: 'signer' as const };
  return [
    { ...base, item: 'viewedAt', facts: { items: { viewedAtMs: 1 }, ...NETWORK } },
    {
      ...base,
      item: 'consent',
      facts: {
        items: { consent: { textId: 'consent-1', version: 1, hash: 'ab'.repeat(32) } },
        ...NETWORK,
      },
    },
    { ...base, item: 'signedAt', facts: { items: { signings: [{ field: 'sig' }] }, ...NETWORK } },
    { ...base, item: 'completedAt', facts: { items: { completedAtMs: 4 }, ...NETWORK } },
  ];
}

describe('FRW-042 capture setting in the signer evidence', () => {
  it('with the setting off, no event stores an IP address or a user agent and the other items remain (criterion 1)', async () => {
    const off: CaptureSettings = { captureNetworkIdentity: false };
    const ledger = new MemoryEvidenceLedger(
      () => 1_000,
      () => off,
    );
    for (const event of signerEvents()) {
      const recorded = await ledger.record('tenant-a', event);
      expect(recorded.evidence).not.toHaveProperty('ipAddress');
      expect(recorded.evidence).not.toHaveProperty('userAgent');
      expect(Object.keys(recorded.evidence.items).length).toBeGreaterThan(0);
    }
    const rows = await ledger.list('tenant-a', 'doc-1');
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.evidence).not.toHaveProperty('ipAddress');
      expect(row.evidence).not.toHaveProperty('userAgent');
    }
    expect(rows.map((r) => r.item)).toEqual(['viewedAt', 'consent', 'signedAt', 'completedAt']);
    expect(rows[1]!.evidence.items).toHaveProperty('consent');
  });

  it('with the default setting, both items are recorded for every event (criterion 3)', async () => {
    const ledger = new MemoryEvidenceLedger(
      () => 1_000,
      () => DEFAULT_CAPTURE_SETTINGS,
    );
    for (const event of signerEvents()) {
      const recorded = await ledger.record('tenant-a', event);
      expect(recorded.evidence).toMatchObject(NETWORK);
    }
    const rows = await ledger.list('tenant-a', 'doc-1');
    expect(rows.every((r) => r.evidence.ipAddress === NETWORK.ipAddress)).toBe(true);
    expect(rows.every((r) => r.evidence.userAgent === NETWORK.userAgent)).toBe(true);
  });
});
