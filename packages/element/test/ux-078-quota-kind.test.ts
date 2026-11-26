// UX-078 criterion 3 (owner decision 110): when the service answers `quota_exceeded` and names the
// kind of quota, the editor tells the person which quota was reached. Node.js: the view is plain
// data; the session is the real one with a backend that refuses.
import { PortError, SyncRejectError } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { quotaOf } from '../src/errors.ts';
import { failureView, type FailureInfo } from '../src/failure.ts';
import { Session } from '../src/session.ts';
import { EN } from '../src/strings.ts';
import { fakeEditor, recordingHost } from './support.ts';

const KINDS = [
  'connections',
  'openDocuments',
  'commitRate',
  'roomCpuBudget',
  'storage',
  'exportConcurrency',
  'exportMinutes',
] as const;

describe('quotaOf', () => {
  it('reads the kind from a sync.reject, a port error with details, and nothing else', () => {
    const reject = new SyncRejectError({
      id: 'c1',
      code: 'quota_exceeded',
      message: 'the commit-rate quota of the tenant is reached',
      action: 'retry',
      head: 3,
      retryAfterMs: 500,
      quota: 'commitRate',
    });
    expect(quotaOf(reject)).toBe('commitRate');
    expect((reject.toJSON() as { quota?: string }).quota).toBe('commitRate');
    expect(quotaOf(new PortError('quota_exceeded', 'x', { details: { quota: 'storage' } }))).toBe(
      'storage',
    );
    expect(quotaOf(new PortError('quota_exceeded', 'x'))).toBeNull();
    expect(
      quotaOf(new PortError('quota_exceeded', 'x', { details: { quota: 'not a kind!' } })),
    ).toBeNull();
    expect(quotaOf('connections')).toBeNull();
    expect(quotaOf(null)).toBeNull();
  });
});

describe('the view of a quota refusal', () => {
  it.each(KINDS)('names the %s quota in the message, with the wait', (kind) => {
    const view = failureView('quota_exceeded', 12_000, undefined, kind);
    expect(view.kind).toBe('quota');
    expect(view.message).toContain(EN.failure.quotaKinds[kind]);
    expect(view.message).toContain('12 seconds');
    expect(view.action.enabledAfterMs).toBe(12_000);
  });

  it('names the kind without a wait, and falls back to the general words for an unknown kind', () => {
    const named = failureView('quota_exceeded', null, undefined, 'storage');
    expect(named.message).toBe(
      EN.failure.quotaKindMessageUnknown.replace('{kind}', EN.failure.quotaKinds['storage']!),
    );
    expect(failureView('quota_exceeded', null, undefined, 'something new').message).toBe(
      EN.failure.quotaMessageUnknown,
    );
    expect(failureView('quota_exceeded', 5_000).message).toBe(
      EN.failure.quotaMessage.replace('{seconds}', '5'),
    );
  });

  it('gives every kind of the protocol its own words', () => {
    const words = KINDS.map((k) => EN.failure.quotaKinds[k]);
    expect(words.every((w) => typeof w === 'string' && w.length > 0)).toBe(true);
    expect(new Set(words).size).toBe(KINDS.length);
  });
});

describe('Session reports the kind of quota to the host', () => {
  it('passes the quota of a refused load in the failure', async () => {
    const editor = fakeEditor();
    const host = recordingHost(editor);
    const failures: FailureInfo[] = [];
    const session = new Session({
      docId: 'd1',
      backend: async () => {
        throw new PortError('quota_exceeded', 'the tenant has reached its connection quota', {
          retryAfterMs: 1_000,
          details: { code: 'quota_exceeded', quota: 'connections' },
        });
      },
      ownsBackend: true,
      host: { ...host, failed: (info) => failures.push(info) },
    });
    await session.start();
    expect(failures).toEqual([
      { code: 'quota_exceeded', retryAfterMs: 1_000, quota: 'connections' },
    ]);
    const view = failureView(
      failures[0]!.code,
      failures[0]!.retryAfterMs,
      undefined,
      failures[0]!.quota ?? null,
    );
    expect(view.message).toContain('connections');
  });
});
