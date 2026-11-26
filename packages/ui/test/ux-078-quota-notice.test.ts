/**
 * UX-078 criterion 3 (owner decision 110), the shell's half: a commit the service refused for a
 * quota it named gives a notice that says which quota was reached, in plain words, and that
 * nothing is lost. The engine half is packages/engine/test/ux-078-quota-wait.test.ts; the live
 * region that announces the notice is the shell's (App.svelte), this file tests the tracker.
 */
import { describe, expect, it } from 'vitest';
import { EN_GB } from '../src/i18n/en-GB.ts';
import { NoticeTracker, exportQuotaOf, quotaKey } from '../src/shell/notices.ts';

const KINDS = [
  'connections',
  'openDocuments',
  'commitRate',
  'roomCpuBudget',
  'storage',
  'exportConcurrency',
  'exportMinutes',
] as const;

describe('quota waits (UX-078 criterion 3)', () => {
  it('reports each new wait once, with the words of its own quota', () => {
    const tracker = new NoticeTracker(null, undefined);
    const first = tracker.quota({ n: 1, quota: 'commitRate' });
    expect(first).toMatchObject({ kind: 'quota', key: 'notice.quota.commitRate', count: 1 });
    expect(tracker.quota({ n: 1, quota: 'commitRate' })).toBeNull();
    const second = tracker.quota({ n: 2, quota: 'roomCpuBudget' });
    expect(second).toMatchObject({ kind: 'quota', key: 'notice.quota.roomCpuBudget' });
    expect(second!.serial).toBeGreaterThan(first!.serial);
  });

  it('says nothing when the wait is over, or when there is no view', () => {
    const tracker = new NoticeTracker(null, undefined);
    expect(tracker.quota(null)).toBeNull();
    expect(tracker.quota(undefined)).toBeNull();
  });

  it('has words for every kind, and each names its own quota', () => {
    const texts = KINDS.map((k) => EN_GB[quotaKey(k)]);
    for (const t of texts) expect(typeof t === 'string' && t.length > 0).toBe(true);
    expect(new Set(texts).size).toBe(KINDS.length);
    expect(EN_GB['notice.quota.commitRate']).toMatch(/saves per minute/);
    expect(EN_GB['notice.quota.roomCpuBudget']).toMatch(/editing processing time/);
  });

  it('tells the person that the changes are kept, for the quotas a commit can wait for', () => {
    for (const k of ['commitRate', 'roomCpuBudget'] as const)
      expect(EN_GB[quotaKey(k)]).toMatch(/kept and are sent again/);
  });
});

describe('a picture the service refused for a quota (UX-078 criterion 3)', () => {
  it('names the storage quota, and keeps the general words when no quota is named', () => {
    const tracker = new NoticeTracker(null, undefined);
    expect(
      tracker.refusal({ n: 1, reason: 'upload-failed', scopes: [], quota: 'storage' }),
    ).toMatchObject({ kind: 'quota', key: 'notice.quota.storage' });
    expect(tracker.refusal({ n: 2, reason: 'upload-failed', scopes: [] })).toMatchObject({
      kind: 'refusal',
      key: 'notice.refused.uploadFailed',
    });
    expect(EN_GB['notice.quota.storage']).toMatch(/storage quota/);
  });
});

describe('an export the service refused for a quota (UX-078 criterion 3)', () => {
  it('reads the export quotas from a port error, and nothing else', () => {
    expect(exportQuotaOf({ code: 'quota_exceeded', details: { quota: 'exportMinutes' } })).toBe(
      'exportMinutes',
    );
    expect(exportQuotaOf({ quota: 'exportConcurrency' })).toBe('exportConcurrency');
    expect(exportQuotaOf({ details: { quota: 'storage' } })).toBeNull();
    expect(exportQuotaOf({ details: null })).toBeNull();
    expect(exportQuotaOf('exportMinutes')).toBeNull();
    expect(exportQuotaOf(null)).toBeNull();
  });

  it('has words that name each quota and say what the person can do', async () => {
    await import('../src/i18n/late/dialogs.ts');
    const { EN_GB: all } = await import('../src/i18n/en-GB.ts');
    expect(all['export.failed.quota.exportConcurrency']).toMatch(/simultaneous exports quota/);
    expect(all['export.failed.quota.exportMinutes']).toMatch(/export minutes quota/);
  });
});
