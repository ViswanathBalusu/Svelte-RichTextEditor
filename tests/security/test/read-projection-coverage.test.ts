/**
 * SEC-064 criterion 3 — a new endpoint or message type cannot ship without a decision about its
 * read projection (ADR 0019; the pattern of SEC-060). Two gates:
 *
 * - Endpoints (the second describe below): the leak sweep of `read-restrictions.test.ts` calls every operation of the protocol
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
const SURFACES = 'sec-064-w8-surfaces.test.ts';
const FAULTS = 'sec-064-w8-faults.test.ts';

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
  'ch.closed': { kind: 'exercised', test: FAULTS },
  'sync.ack': { kind: 'exercised', test: SWEEP },
  'sync.reject': { kind: 'exercised', test: SWEEP },
  'sync.commit': { kind: 'exercised', test: SWEEP },
  'sync.caughtUp': { kind: 'gap', reason: 'catch-up marker; the stream is not replayed here' },
  'sync.reset': {
    kind: 'gap',
    reason: 'reset of a stream carries a fresh document; not exercised',
  },
  'sync.check': { kind: 'gap', reason: 'consistency check of the view; not exercised' },
  'presence.state': { kind: 'exercised', test: SURFACES },
  'perm.changed': { kind: 'gap', reason: 'permission change notice; not exercised by name' },
  event: { kind: 'exercised', test: SURFACES },
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

  // The gaps that exist today. A type that is not in this list cannot be added as a gap: a new
  // message type has to be exercised or to carry no content, so it ships with a projection test.
  // The list can only shrink.
  const KNOWN_GAPS = [
    'error',
    'chunk',
    'sync.caughtUp',
    'sync.reset',
    'sync.check',
    'perm.changed',
    'wf.changed',
  ];

  it('records every gap with its reason, and allows no new gap (a new type must be tested)', () => {
    const gaps = Object.entries(MESSAGE_REVIEW).filter(([, e]) => e.kind === 'gap');
    for (const [, e] of gaps) expect(e.kind === 'gap' ? e.reason : '').not.toBe('');
    const added = gaps.map(([t]) => t).filter((t) => !KNOWN_GAPS.includes(t));
    expect(added, 'gaps that are not in the list of known gaps').toEqual([]);
    const closed = KNOWN_GAPS.filter((t) => MESSAGE_REVIEW[t]?.kind !== 'gap');
    expect(closed, 'known gaps that are now closed: remove them from KNOWN_GAPS').toEqual([]);
  });
});

/**
 * Endpoints: every operation a user token may call and that reads (GET) is named here with where
 * its answer is scanned for canaries. `read-restrictions.test.ts` calls every operation of the
 * definition once, as a reader without access (so a new endpoint is called by construction), but
 * with absent identifiers and without the query its route needs. An endpoint that is only covered
 * by that call is `swept`; a new one cannot be added as `swept`: it needs a call with its
 * parameters in a test that names its path.
 */
type EndpointEntry = { kind: 'exercised'; test: string; path: string } | { kind: 'swept' };

const SURFACES_FILE = 'sec-064-w8-surfaces.test.ts';
const ENDPOINT_REVIEW: Record<string, EndpointEntry> = {
  getDocument: { kind: 'swept' },
  getContent: { kind: 'exercised', test: SURFACES_FILE, path: '/content?seq=' },
  listCommits: { kind: 'exercised', test: SURFACES_FILE, path: '/commits?after=0' },
  listRegions: { kind: 'exercised', test: SURFACES_FILE, path: '/regions' },
  getGrants: { kind: 'exercised', test: SURFACES_FILE, path: '/grants' },
  // The segment holds hashes and metadata, never a payload (HIS-037); the reader's gate cuts it.
  getAuditSegment: { kind: 'exercised', test: SURFACES_FILE, path: '/audit-segment?fromSeq=' },
  // The suggestion's date comes from an index, not from the log (HIS-042).
  getSuggestionIntroduction: { kind: 'exercised', test: SURFACES_FILE, path: '/introduction' },
  listHistory: { kind: 'exercised', test: SURFACES_FILE, path: '/history?region=' },
  listVersions: { kind: 'exercised', test: SURFACES_FILE, path: '/versions' },
  getDiff: { kind: 'exercised', test: SURFACES_FILE, path: '/diff?fromSeq=' },
  getAttribution: { kind: 'exercised', test: SURFACES_FILE, path: '/attribution?region=' },
  // The hint names a node and its address and carries no content of a document.
  getConnect: { kind: 'exercised', test: SURFACES_FILE, path: '/connect' },
  getActivity: { kind: 'exercised', test: SURFACES_FILE, path: '/activity' },
  listThreads: { kind: 'exercised', test: SURFACES_FILE, path: '/threads?seq=' },
  getThread: { kind: 'exercised', test: SURFACES_FILE, path: '/threads/${thread}' },
  getExport: { kind: 'exercised', test: SURFACES_FILE, path: '/exports/' },
  getImport: { kind: 'swept' },
  getFonts: { kind: 'swept' },
  listFields: { kind: 'exercised', test: SURFACES_FILE, path: '/fields' },
  getFieldValues: { kind: 'exercised', test: SURFACES_FILE, path: '/field-values?seq=' },
  getWorkflow: { kind: 'swept' },
  getWorkflowEvidence: { kind: 'swept' },
  getWorkflowFinal: { kind: 'swept' },
};
const KNOWN_SWEPT = [
  'getDocument',
  'getImport',
  'getFonts',
  'getWorkflow',
  'getWorkflowEvidence',
  'getWorkflowFinal',
];

describe('SEC-064 criterion 3: every read endpoint has a read-projection decision', () => {
  const reads = DEP1.operations.filter(
    (o) => o.method === 'GET' && (o.security as readonly string[]).includes('user'),
  );

  it('no read endpoint is missing from the review (a new endpoint fails here)', () => {
    const missing = reads.map((o) => o.operationId).filter((id) => !(id in ENDPOINT_REVIEW));
    expect(missing, 'read endpoints without a read-projection entry').toEqual([]);
  });

  it('no review entry names an endpoint the definition does not have', () => {
    const ids = reads.map((o) => o.operationId as string);
    expect(Object.keys(ENDPOINT_REVIEW).filter((id) => !ids.includes(id))).toEqual([]);
  });

  it('every exercised endpoint has its path in the test that scans its answer', () => {
    const text = (file: string) => readFileSync(`${testDir}${file}`, 'utf8');
    for (const [id, e] of Object.entries(ENDPOINT_REVIEW)) {
      if (e.kind !== 'exercised') continue;
      expect(text(e.test), `${e.test} calls ${id} (${e.path})`).toContain(e.path);
    }
  });

  it('allows no new swept-only endpoint', () => {
    const swept = Object.entries(ENDPOINT_REVIEW)
      .filter(([, e]) => e.kind === 'swept')
      .map(([id]) => id);
    expect(swept.filter((id) => !KNOWN_SWEPT.includes(id))).toEqual([]);
    expect(KNOWN_SWEPT.filter((id) => !swept.includes(id))).toEqual([]);
  });

  it('is shown to fail: an endpoint that is not reviewed is reported', () => {
    const reviewed = new Set(Object.keys(ENDPOINT_REVIEW));
    const withNew = [...reads.map((o) => o.operationId as string), 'getNewThing'];
    expect(withNew.filter((id) => !reviewed.has(id))).toEqual(['getNewThing']);
  });
});
