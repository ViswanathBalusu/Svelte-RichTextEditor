// SEC-067 criterion 5: the audit export (`GET /documents/{id}/audit-segment`) carries the receipt of
// the transparency log and the proof of a head in the published root, and the evidence in the
// segment verifies offline with the log's public key. The service is the memory composition with the
// real data plane; the log is a local log of the proposed log's format on an ephemeral port.
import { type StoredCommit } from '@docedit/authority';
import { type AuditSegment } from '@docedit/history';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryAudit } from '../../src/data-plane/memory-ports.ts';
import { MemoryHeadAnchorFiles } from '../../src/control-plane/head-anchoring.ts';
import { PublicAnchorExport } from '../../src/control-plane/public-anchor-export.ts';
import {
  MemoryPublicRootStore,
  MemoryTenantSaltStore,
  PublicRoots,
  TenantSalts,
  type DocumentHead,
} from '../../src/control-plane/public-root.ts';
import { PublicRootAnchors } from '../../src/control-plane/public-root-submit.ts';
import { MemoryKeyService } from '../../src/storage/key-service.ts';
import type { DocRef } from '../../src/storage/types.ts';
import { HttpTransparencyLog, LocalTransparencyLog } from '../../src/transparency/local-log.ts';
import { parseVerifierKey } from '../../src/transparency/tlog.ts';
import { verifyPublicAnchor } from '../../src/transparency/verify-public-anchor.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const INTRO = 'pIntro0000000001';
const HOUR = 60 * 60 * 1000;

function inside(doc: unknown, id: string): number {
  let at = -1;
  cdmSchema()
    .nodeFromJSON(doc)
    .descendants((n, pos) => {
      if (n.attrs['id'] === id) at = pos + 1;
      return at < 0;
    });
  return at;
}

async function appendOne(h: Harness, doc: string, text: string): Promise<void> {
  const ref: DocRef = { tenant: h.tenant, doc };
  const epoch = await h.parts.ownership.claim(ref, 'sec-067-node');
  const head = await h.parts.logs.head(ref);
  const perms = await h.parts.grants.current(ref);
  const pos = inside(documentWithRegions()['doc'], INTRO);
  const commit: StoredCommit = {
    seq: head.seq + 1,
    id: uuid7(),
    kind: 'steps',
    steps: [
      { stepType: 'replace', from: pos, to: pos, slice: { content: [{ type: 'text', text }] } },
    ] as StoredCommit['steps'],
    user: 'u-test',
    session: 'session-test',
    time: h.now(),
    origin: 'input',
    scopes: ['body'],
    revision: perms.revision,
    cdm: 1,
    engine: 'pm-steps/1',
    retired: [],
    claimed: [],
  };
  const r = await h.parts.logs.append(ref, {
    epoch,
    revision: perms.revision,
    fromSeq: head.seq + 1,
    commits: [commit],
  });
  expect(r.status).toBe('ok');
}

describe('the audit export carries the public anchor (SEC-067)', () => {
  let h: Harness;
  let local: LocalTransparencyLog;
  let roots: PublicRoots;
  let anchors: PublicRootAnchors;

  beforeAll(async () => {
    local = new LocalTransparencyLog('sec-067-log');
    const url = await local.listen(0);
    const log = new HttpTransparencyLog({
      baseUrl: url,
      verifierKey: parseVerifierKey(local.verifierKey)!,
      timeoutMs: 1000,
    });
    const files = new MemoryHeadAnchorFiles();
    const audit = new MemoryAudit();
    const store = new MemoryPublicRootStore();
    const heads = {
      latestHeads: async (): Promise<DocumentHead[]> => {
        const out: DocumentHead[] = [];
        for (const doc of docs) {
          const ref: DocRef = { tenant: h.tenant, doc };
          const head = await h.parts.logs.head(ref);
          if (head.seq < 1) continue;
          const chain = await h.parts.logs.chainRange!(ref, head.seq, head.seq);
          out.push({ doc, seq: head.seq, chainHead: chain.head.chainHead! });
        }
        return out;
      },
    };
    roots = new PublicRoots({
      heads,
      salts: new TenantSalts(new MemoryTenantSaltStore(), new MemoryKeyService()),
      store,
      files,
      audit,
      retainMs: 365 * 24 * HOUR,
      now: () => Date.now(),
    });
    anchors = new PublicRootAnchors({
      store,
      log,
      files,
      audit,
      retainMs: 365 * 24 * HOUR,
      now: () => Date.now(),
    });
    h = await startHarness('memory', {
      realDataPlane: true,
      parts: { publicAnchors: new PublicAnchorExport(roots, store) },
    });
  });
  afterAll(async () => {
    await h?.close();
    await local?.close();
  });
  const docs: string[] = [];

  it('has the receipt and the proof of the head, and verifies offline with the log key', async () => {
    const doc = await h.createDocument({ content: documentWithRegions(), title: 'Anchored' });
    docs.push(doc);
    for (const t of ['a', 'b', 'c']) await appendOne(h, doc, t);
    const at = Date.now();
    expect((await roots.run(h.tenant, at)).built).toBe(true);
    expect((await anchors.submitPending(h.tenant, at)).submitted).toBe(1);

    const res = await h.call('GET', `/v1/documents/${doc}/audit-segment`, { token: h.apiKey });
    expect(res.status, res.text).toBe(200);
    const segment = res.json as unknown as AuditSegment;
    expect(segment.publicAnchors).toHaveLength(1);
    const evidence = segment.publicAnchors![0]!;
    expect(evidence.head.seq).toBe(3);
    expect(evidence.receipt?.logId).toBe('sec-067-log');
    // The response is JSON text: what leaves the service holds the salt (for the proof) and no
    // identifier of the tenant in the public entry.
    expect(evidence.entry).not.toContain(h.tenant);
    expect(evidence.entry).not.toContain(doc);

    const report = await verifyPublicAnchor(evidence, {
      logKey: parseVerifierKey(local.verifierKey)!,
      chain: segment,
    });
    expect(report).toMatchObject({
      status: 'verified',
      proof: { covered: true },
      chain: { state: 'verified', anchoredHead: 'match' },
    });
  });

  it('says "not yet anchored" for a segment that reaches past the last root', async () => {
    const doc = docs[0]!;
    await appendOne(h, doc, 'd');
    const res = await h.call('GET', `/v1/documents/${doc}/audit-segment`, { token: h.apiKey });
    const segment = res.json as unknown as AuditSegment;
    expect(segment.to).toBe(4);
    // The newest root covers seq 3, which is inside the range: the evidence is still carried.
    const evidence = segment.publicAnchors![0]!;
    expect(evidence.head.seq).toBe(3);
    const report = await verifyPublicAnchor(evidence, {
      logKey: parseVerifierKey(local.verifierKey)!,
      chain: segment,
    });
    expect(report.status).toBe('not-yet-anchored');
    expect(report.notYetAnchored).toMatchObject({ afterSeq: 3, logHead: 4 });
  });

  it('carries no public anchor for a document with no root', async () => {
    const doc = await h.createDocument({ content: documentWithRegions(), title: 'Unanchored' });
    await appendOne(h, doc, 'x');
    const res = await h.call('GET', `/v1/documents/${doc}/audit-segment`, { token: h.apiKey });
    expect(res.status, res.text).toBe(200);
    expect((res.json as unknown as AuditSegment).publicAnchors).toBeUndefined();
  });
});
