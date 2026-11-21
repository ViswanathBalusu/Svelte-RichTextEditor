// FRW-055 criterion 2, the evidence half: each salted evidence commitment of a signing, a completion
// and a decline is the `evidenceHash` of a control commit of the segment; a view and a consent are
// not anchored. An item the chain does not hold is named; a segment with an erased control payload
// does not fail an item it could not look for; an anchor with no item is reported, not failed.
import { buildBundle, commitEvidence, newEvidenceSalt, type BundleItem } from '@docedit/authority';
import { describe, expect, it } from 'vitest';
import { chainHash, payloadDigest, type BundleCommit } from '../src/chain.ts';
import {
  WORKFLOW_BUNDLE_FORMAT,
  WORKFLOW_BUNDLE_INSTRUCTIONS,
  verifyWorkflowEvidenceBundle,
  type WorkflowEvidenceBundle,
} from '../src/workflow-evidence-bundle.ts';
import { bundleOf } from './bundle.ts';
import { LogBuilder, typeAt } from './fixtures.ts';

async function item(id: string, kind: string): Promise<BundleItem> {
  const salt = newEvidenceSalt();
  const canonical = JSON.stringify({ evidence: { at: 'x' }, item: kind, participant: 'p1' });
  return {
    id,
    saltHex: Buffer.from(salt).toString('hex'),
    canonical,
    commitment: await commitEvidence(canonical, salt),
  };
}

/** Re-chains `commits` after their payloads or metadata were changed. */
async function rechain(commits: BundleCommit[]): Promise<BundleCommit[]> {
  const out: BundleCommit[] = [];
  let prev: string | null = null;
  for (const c of commits) {
    const d = await payloadDigest(c.payload ?? {});
    const meta = { ...c.meta, size: d.size };
    const hash = await chainHash(prev, meta, d.hash);
    out.push({ ...c, meta, payloadHash: d.hash, prevHash: prev, hash });
    prev = hash;
  }
  return out;
}

async function fixture(
  items: BundleItem[],
  anchored: Record<number, { origin: string; evidenceHash: string }>,
): Promise<WorkflowEvidenceBundle> {
  const b = new LogBuilder();
  for (let i = 0; i < 5; i++) b.add((d) => typeAt(d, 'pIntro0000000001', 0, `t${i} `));
  const full = await bundleOf(b.log);
  const commits = await rechain(
    full.commits.map((c) => ({
      ...c,
      meta: { ...c.meta, kind: 'control' },
      payload: {
        steps: [],
        retired: [],
        claimed: [],
        ...(anchored[c.meta.seq] ? { evidence: anchored[c.meta.seq] } : {}),
      },
    })),
  );
  const last = commits[commits.length - 1]!;
  return {
    format: WORKFLOW_BUNDLE_FORMAT,
    doc: full.doc,
    workflow: 'wf-1',
    log: { from: 1, to: 5, head: { seq: 5, chainHead: last.hash }, commits },
    evidence: buildBundle(items),
    instructions: WORKFLOW_BUNDLE_INSTRUCTIONS,
  };
}

describe('the evidence of a bundle is in the chain (FRW-055 criterion 2)', () => {
  it('finds a signing and a completion in control commits, and asks nothing of a view or a consent', async () => {
    const signed = await item('ev-signed', 'signed');
    const completed = await item('ev-completed', 'completed');
    const viewed = await item('ev-viewed', 'viewed');
    const consent = await item('ev-consent', 'consent');
    const bundle = await fixture([signed, completed, viewed, consent], {
      3: { origin: 'sign', evidenceHash: signed.commitment },
      5: { origin: 'rules', evidenceHash: completed.commitment },
    });
    const verdict = await verifyWorkflowEvidenceBundle(bundle);
    expect(verdict).toMatchObject({
      ok: true,
      failedEvidence: [],
      evidenceInChain: ['ev-signed', 'ev-completed'],
      evidenceUnchecked: [],
      unmatchedAnchors: [],
    });
  });

  it('names a signing that no control commit holds', async () => {
    const signed = await item('ev-signed', 'signed');
    const other = await item('ev-other', 'signed');
    const bundle = await fixture([signed, other], {
      3: { origin: 'sign', evidenceHash: signed.commitment },
    });
    const verdict = await verifyWorkflowEvidenceBundle(bundle);
    expect(verdict.ok).toBe(false);
    expect(verdict.failedEvidence).toEqual(['ev-other']);
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ kind: 'evidence', ref: 'ev-other' }),
    );
  });

  it('a commit whose anchored hash was changed breaks the chain, and the item is then not in it', async () => {
    const signed = await item('ev-signed', 'signed');
    const bundle = await fixture([signed], {
      3: { origin: 'sign', evidenceHash: signed.commitment },
    });
    const tampered = structuredClone(bundle);
    (
      tampered.log.commits[2]!.payload as { evidence: { evidenceHash: string } }
    ).evidence.evidenceHash = '0'.repeat(64);
    const verdict = await verifyWorkflowEvidenceBundle(tampered);
    expect(verdict.ok).toBe(false);
    expect(verdict.log.status).toBe('altered');
    expect(verdict.findings).toContainEqual(expect.objectContaining({ kind: 'commit', ref: 3 }));
  });

  it('does not fail an item it could not look for when a control payload is erased', async () => {
    const signed = await item('ev-signed', 'signed');
    const bundle = await fixture([signed], {
      3: { origin: 'sign', evidenceHash: signed.commitment },
    });
    const erased = structuredClone(bundle);
    delete (erased.log.commits[2] as { payload?: unknown }).payload;
    const verdict = await verifyWorkflowEvidenceBundle(erased);
    expect(verdict.failedEvidence).toEqual([]);
    expect(verdict.evidenceUnchecked).toEqual(['ev-signed']);
    expect(verdict.ok).toBe(true);
  });

  it('reports an anchor that has no item, without failing', async () => {
    const signed = await item('ev-signed', 'signed');
    const bundle = await fixture([], { 4: { origin: 'sign', evidenceHash: signed.commitment } });
    const verdict = await verifyWorkflowEvidenceBundle(bundle);
    expect(verdict.ok).toBe(true);
    expect(verdict.unmatchedAnchors).toEqual([4]);
  });
});
