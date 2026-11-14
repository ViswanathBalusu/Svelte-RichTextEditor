/**
 * SEC-064 criterion 3 — a new endpoint or message type cannot ship without a decision about its
 * read projection (ADR 0019; the pattern of SEC-060). Two gates:
 *
 * - Endpoints: the leak sweep of `read-restrictions.test.ts` calls every operation of the protocol
 *   definition (`DEP1.operations`) as a reader without access, so a new endpoint is swept by
 *   construction. The sweep is the only place that calls them; nothing is excluded from it.
 * - Messages: every server-to-client (and both-direction) message type of `DEP1.messages` must have
 *   an entry here. An entry is one of:
 *     `exercised`  the type is named in `read-restrictions.test.ts`, which checks its frames;
 *     `no-content` the type carries no document data, with the reason;
 *     `gap`        the type may carry document data and no test names it yet, with the reason.
 *   A type with no entry fails the build. A `gap` is a recorded exception: it passes, and it is
 *   listed in the story's Notes until a test covers it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEP1 } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';

type Entry = { kind: 'exercised'; test: string } | { kind: 'no-content' | 'gap'; reason: string };

const SWEEP = 'read-restrictions.test.ts';

const MESSAGE_REVIEW: Record<string, Entry> = {
  welcome: { kind: 'no-content', reason: 'handshake: versions, features and limits' },
  'auth.expiring': { kind: 'no-content', reason: 'token lifecycle: expiry only' },
  'auth.ok': { kind: 'no-content', reason: 'token lifecycle: acknowledgement only' },
  'auth.revoked': { kind: 'no-content', reason: 'token lifecycle: revocation only' },
  ping: { kind: 'no-content', reason: 'keep-alive' },
  pong: { kind: 'no-content', reason: 'keep-alive' },
  goaway: { kind: 'no-content', reason: 'server shutdown: retry hint only' },
  error: {
    kind: 'gap',
    reason:
      'problem details: codes and positions (SEC-047 criterion 2); not provoked with canaries here',
  },
  chunk: {
    kind: 'gap',
    reason: 'framing of other messages; frames are scanned whole but chunks are not named',
  },
  'ch.opened': { kind: 'exercised', test: SWEEP },
  'ch.rejected': { kind: 'no-content', reason: 'refusal with a code; no document data' },
  'ch.closed': { kind: 'gap', reason: 'close on revocation is not asserted by name' },
  'sync.ack': { kind: 'exercised', test: SWEEP },
  'sync.reject': { kind: 'exercised', test: SWEEP },
  'sync.commit': { kind: 'exercised', test: SWEEP },
  'sync.caughtUp': { kind: 'gap', reason: 'catch-up marker; the stream is not replayed here' },
  'sync.reset': {
    kind: 'gap',
    reason: 'reset of a stream carries a fresh document; not exercised',
  },
  'sync.check': { kind: 'gap', reason: 'consistency check of the view; not exercised' },
  'presence.state': {
    kind: 'gap',
    reason: 'presence within the view class (ADR 0019); not exercised',
  },
  'perm.changed': { kind: 'gap', reason: 'permission change notice; not exercised by name' },
  event: { kind: 'gap', reason: 'document events; not exercised' },
  'wf.changed': { kind: 'gap', reason: 'workflow change notice (12); not exercised' },
};

const testDir = fileURLToPath(new URL('.', import.meta.url));

describe('SEC-064 criterion 3: every server message has a read-projection decision', () => {
  const serverTypes = DEP1.messages
    .filter((m) => m.dir === 's2c' || m.dir === 'both')
    .map((m) => m.t);

  it('no server message type is missing from the review (a new type fails here)', () => {
    const missing = serverTypes.filter((t) => !(t in MESSAGE_REVIEW));
    expect(missing, 'message types without a read-projection entry').toEqual([]);
  });

  it('no review entry names a message type the definition does not have', () => {
    const stale = Object.keys(MESSAGE_REVIEW).filter((t) => !serverTypes.includes(t));
    expect(stale, 'review entries for types that no longer exist').toEqual([]);
  });

  it('every exercised type is named in the test file that checks it', () => {
    for (const [t, entry] of Object.entries(MESSAGE_REVIEW)) {
      if (entry.kind !== 'exercised') continue;
      const file = `${testDir}${entry.test}`;
      expect(existsSync(file), `${entry.test} exists`).toBe(true);
      expect(readFileSync(file, 'utf8'), `${entry.test} names '${t}'`).toContain(`'${t}'`);
    }
  });

  it('records every gap with its reason, so the open ones are visible', () => {
    const gaps = Object.entries(MESSAGE_REVIEW).filter(([, e]) => e.kind === 'gap');
    for (const [, e] of gaps) expect(e.kind === 'gap' ? e.reason : '').not.toBe('');
    // The count is reported for the story; it is not a pass condition.
    console.info(`SEC-064 read-projection gaps: ${gaps.map(([t]) => t).join(', ')}`);
  });
});
