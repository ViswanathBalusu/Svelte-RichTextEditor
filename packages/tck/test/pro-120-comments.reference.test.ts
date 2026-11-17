// The `comments` profile against the reference service (PRO-120). The service is started with
// `comments` in DOCEDIT_FEATURES, as an operator announces it, and with a rebase window of 5 steps
// (DOCEDIT_MAX_REBASE_STEPS), so that the kit can go past the window with a few commits. A server
// with the default window of 5000 steps skips that scenario (it names the reason).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runKit } from '../src/runner.ts';
import type { KitReport } from '../src/report.ts';
import { startReference, type StartedTarget } from './targets/reference.ts';

const skip = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';

describe.skipIf(skip)('comments profile against the reference service (PRO-120)', () => {
  let target: StartedTarget;
  let report: KitReport;

  beforeAll(async () => {
    target = await startReference({
      env: {
        DOCEDIT_FEATURES: 'presence,regions,suggest-enforced,read-restrictions,comments',
        DOCEDIT_MAX_REBASE_STEPS: '5',
      },
    });
    report = await runKit({
      discovery: target.discovery,
      credential: target.credential,
      origin: target.origin,
      testMode: false,
      profiles: ['comments'],
    });
  }, 600_000);

  afterAll(async () => {
    await target?.stop();
  });

  const outcome = (id: string) =>
    report.profiles.flatMap((p) => p.scenarios).find((x) => x.id === id);

  it('runs the profile for a server that announces comments', () => {
    const p = report.profiles.find((x) => x.id === 'comments');
    expect(p?.outcome, p?.reason ?? '').not.toBe('skipped');
  });

  it.each([
    ['comments.range.follows-text', 'the range follows the text (criterion 1)'],
    [
      'comments.permissions.comment-scope',
      'view may not start a thread, comment may (criterion 2)',
    ],
    [
      'comments.range.base-seq-window',
      'a baseSeq outside the rebase window is refused (criterion 3)',
    ],
    [
      'comments.events.thread-and-comment',
      'thread and comment changes reach the channel (criterion 4)',
    ],
    ['comments.identifiers', 'a caller of another document is refused (PRO-045)'],
  ])('%s: %s', (id) => {
    const s = outcome(id);
    expect(s?.outcome, JSON.stringify(s?.failure ?? s)).toBe('passed');
  });
});
