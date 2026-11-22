/**
 * SEC-029 criterion 5 (lane V-SEC-017-032), against the real S3-compatible store of the shared
 * test environment (`docedit-test-s3`, Versity gateway, port 57070): signed, time-stamped chain
 * heads are written to an Object Lock bucket, and a later rewrite of the history is checked against
 * them (08 §12; 10 §2; HIS-036).
 *
 * What this shows: an anchor written under COMPLIANCE retention cannot be replaced at its key; it
 * reads back with its signature valid; a rewrite up to an anchored head disagrees with that head
 * (`mismatch`, `altered`); an anchor before the rewrite still matches; and a rewrite with no anchor
 * is not detectable by the verifier alone (documented, 10 §2).
 *
 * What this does not show: the product writer. The anchor writer below is test code that signs and
 * writes one head per call. The periodic schedule and the product module of HIS-036 are not built,
 * so criterion 5 stays unticked (see the story Notes).
 *
 * The bucket is created with a unique name (`docedit-v-sec-017-032-…`). COMPLIANCE objects cannot
 * be removed before their retention ends, so the bucket remains until the container is reset
 * (`infra/test-env.ps1 down` removes all test data, which lives on tmpfs).
 */
import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BUNDLE_FORMAT,
  chainHash,
  payloadDigest,
  verifyBundle,
  type Anchor,
  type BundleCommit,
  type ChainMetadata,
  type LogBundle,
} from '../../../packages/history/src/index.ts';
import { S3ObjectStore } from '../../../services/document-service/src/objects/s3.ts';

const ENDPOINT = process.env['DOCEDIT_S3_ENDPOINT'] ?? 'http://127.0.0.1:57070';
const ACCESS_KEY = process.env['DOCEDIT_S3_ACCESS_KEY'] ?? 'docedit-test';
const SECRET_KEY = process.env['DOCEDIT_S3_SECRET_KEY'] ?? 'docedit-test-secret-key-0000';
const RETAIN_MS = 15 * 60 * 1000;

const DOC = 'doc-sec029-anchors';
const BUCKET = `docedit-v-sec-017-032-${randomUUID().slice(0, 8)}`;

function metaFor(seq: number, size: number): ChainMetadata {
  return {
    doc: DOC,
    seq,
    kind: 'commit',
    id: `c-${seq}`,
    user: 'ann',
    session: null,
    agent: null,
    time: '2026-11-13T09:00:00.000Z',
    origin: 'client',
    scopes: ['edit'],
    base: seq - 1,
    rebased: false,
    revision: 1,
    jti: null,
    cdm: 1,
    engine: 'engine-1',
    size,
  };
}

/** A valid n-commit log, built the way the history verifier reads one (as in history-tamper). */
async function buildLog(n: number, salt = 'a'): Promise<LogBundle> {
  const commits: BundleCommit[] = [];
  let prev: string | null = null;
  for (let seq = 1; seq <= n; seq++) {
    const payload = {
      steps: [{ stepType: 'insert', text: `${salt}${seq}` }],
      retired: [],
      claimed: [],
    };
    const { hash: payloadHash, size } = await payloadDigest(payload);
    const meta = metaFor(seq, size);
    const hash = await chainHash(prev, meta, payloadHash);
    commits.push({ meta, payloadHash, prevHash: prev, hash, payload });
    prev = hash;
  }
  return { format: BUNDLE_FORMAT, doc: DOC, head: { seq: n, chainHead: prev }, commits };
}

/** Rewrites every commit from `from` (a seq) to the end, recomputing links and the head. */
async function rewriteFrom(
  b: LogBundle,
  from: number,
  payloadFor: (seq: number) => unknown,
): Promise<LogBundle> {
  const out = JSON.parse(JSON.stringify(b)) as LogBundle;
  for (let i = from - 1; i < out.commits.length; i++) {
    const prev: string | null = i === 0 ? null : out.commits[i - 1]!.hash;
    const c = out.commits[i]!;
    const payload = payloadFor(c.meta.seq);
    const { hash: payloadHash, size } = await payloadDigest(payload);
    const meta = { ...c.meta, size };
    const hash = await chainHash(prev, meta, payloadHash);
    out.commits[i] = { meta, payloadHash, prevHash: prev, hash, payload };
  }
  const last = out.commits[out.commits.length - 1]!;
  out.head = { seq: out.commits.length, chainHead: last.hash };
  return out;
}

/** The signed body of an anchor: its fields in a fixed order, which is what the signature covers. */
interface SignedAnchor {
  doc: string;
  seq: number;
  chainHead: string;
  /** Server time of the anchor, ISO 8601. */
  at: string;
}

interface StoredAnchor {
  body: SignedAnchor;
  /** Ed25519 signature over the canonical JSON of `body`, base64. */
  sig: string;
}

const canonical = (a: SignedAnchor): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify({ at: a.at, chainHead: a.chainHead, doc: a.doc, seq: a.seq }),
  );

const anchorKey = (seq: number) => `anchors/${DOC}/${String(seq).padStart(10, '0')}.json`;

const keys = generateKeyPairSync('ed25519');

async function writeAnchor(
  store: S3ObjectStore,
  seq: number,
  chainHead: string,
  signer = keys.privateKey,
): Promise<void> {
  const body: SignedAnchor = {
    doc: DOC,
    seq,
    chainHead,
    at: new Date(Date.now()).toISOString(),
  };
  const sig = sign(null, canonical(body), signer).toString('base64');
  const bytes = new TextEncoder().encode(JSON.stringify({ body, sig } satisfies StoredAnchor));
  await store.putRetained(anchorKey(seq), bytes, Date.now() + RETAIN_MS);
}

async function readAnchor(store: S3ObjectStore, seq: number): Promise<StoredAnchor> {
  const bytes = await store.get(anchorKey(seq));
  if (!bytes) throw new Error(`no anchor at seq ${seq}`);
  return JSON.parse(new TextDecoder().decode(bytes)) as StoredAnchor;
}

function verified(a: StoredAnchor): boolean {
  return verify(null, canonical(a.body), keys.publicKey, Buffer.from(a.sig, 'base64'));
}

const asAnchor = (a: StoredAnchor): Anchor => ({
  seq: a.body.seq,
  hash: a.body.chainHead,
  source: 'anchor',
});

let store: S3ObjectStore;

// The test environment (infra/test-env.ps1) sets DOCEDIT_TEST_ENV=1 for the command it runs. Then
// the store must be up and an unreachable store fails the file. Without it (a plain `pnpm test`
// on a host with no containers, the hosted unit job) the file skips, with the reason on the console.
const probe = await fetch(ENDPOINT).catch((e: unknown) => e);
const unreachable = probe instanceof Error ? probe.message : null;
const required = process.env['DOCEDIT_TEST_ENV'] === '1';
if (unreachable !== null && !required)
  console.warn(
    `sec-029-anchors.s3: skipped: the S3 test store is not reachable at ${ENDPOINT} (${unreachable}); start it with: pwsh -NoProfile -File infra/test-env.ps1 up -NoExport`,
  );

beforeAll(async () => {
  if (unreachable !== null && !required) return;
  store = new S3ObjectStore({
    endpoint: ENDPOINT,
    region: 'us-east-1',
    bucket: BUCKET,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
  });
  await store.createBucket({ objectLock: true });
}, 60_000);

describe.skipIf(unreachable !== null && !required)(
  'SEC-029 criterion 5: signed chain heads in write-once storage',
  () => {
    it('an anchor written under retention is not replaced at its key, and reads back with a valid signature', async () => {
      const log = await buildLog(6);
      const head = log.commits[5]!.hash;
      await writeAnchor(store, 6, head);

      const again = await writeAnchor(store, 6, 'f'.repeat(64)).then(
        () => 'replaced',
        () => 'refused',
      );
      expect(again).toBe('refused');

      const back = await readAnchor(store, 6);
      expect(back.body.chainHead).toBe(head);
      expect(verified(back)).toBe(true);

      // A body edited after signing does not verify, so an edited anchor is visible to a reader.
      const edited: StoredAnchor = { ...back, body: { ...back.body, seq: 5 } };
      expect(verified(edited)).toBe(false);
      // Nor does one signed by another key.
      const other = generateKeyPairSync('ed25519');
      const forged = sign(null, canonical(back.body), other.privateKey).toString('base64');
      expect(verified({ ...back, sig: forged })).toBe(false);
    });

    it('a rewrite up to an anchored head disagrees with the anchor; an earlier anchor still matches', async () => {
      const original = await buildLog(6);
      await writeAnchor(store, 2, original.commits[1]!.hash);
      const anchor2 = await readAnchor(store, 2);
      const anchor6 = await readAnchor(store, 6);
      expect(verified(anchor2)).toBe(true);

      const rewritten = await rewriteFrom(original, 3, (seq) => ({
        steps: [{ stepType: 'insert', text: `rewritten${seq}` }],
        retired: [],
        claimed: [],
      }));

      const before = await verifyBundle(rewritten, { anchors: [asAnchor(anchor2)] });
      expect(before.anchors[0]?.result).toBe('match');
      expect(before.status).toBe('intact');

      const atHead = await verifyBundle(rewritten, { anchors: [asAnchor(anchor6)] });
      expect(atHead.anchors[0]?.result).toBe('mismatch');
      expect(atHead.status).toBe('altered');
      expect(atHead.firstBadSeq).toBe(6);
    });

    it('a rewrite with no anchor held verifies: the verifier alone cannot see it (10 §2, documented)', async () => {
      const original = await buildLog(6, 'u');
      const rewritten = await rewriteFrom(original, 3, (seq) => ({
        steps: [{ stepType: 'insert', text: `unanchored${seq}` }],
        retired: [],
        claimed: [],
      }));
      const r = await verifyBundle(rewritten);
      expect(r.status).toBe('intact');
    });
  },
);
