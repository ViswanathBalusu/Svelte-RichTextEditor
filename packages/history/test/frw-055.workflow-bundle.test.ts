// FRW-055 criterion 3: a workflow evidence bundle with one record or one evidence item altered fails
// verification and names it. The bundle holds a log segment (control commits with their payload, other
// records without it) and the evidence items; one verifier checks both (criterion 3), and the
// instructions name the command that runs it.
import { buildBundle, commitEvidence, newEvidenceSalt, type BundleItem } from '@docedit/authority';
import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_BUNDLE_FORMAT,
  WORKFLOW_BUNDLE_INSTRUCTIONS,
  isWorkflowEvidenceBundle,
  verifyWorkflowEvidenceBundle,
  type WorkflowEvidenceBundle,
} from '../src/workflow-evidence-bundle.ts';
import { bundleOf } from './bundle.ts';
import { CANARY, LogBuilder, typeAt } from './fixtures.ts';

/** The records that carry their payload: the control commits of the workflow. */
const CONTROL = new Set([4, 6]);

async function fixture(): Promise<WorkflowEvidenceBundle> {
  const b = new LogBuilder();
  for (let i = 0; i < 6; i++)
    b.add((d) => typeAt(d, i % 2 ? 'pSecret00000001B' : 'pIntro0000000001', 0, `${CANARY}${i} `), {
      user: i % 2 ? 'bob' : 'carol',
    });
  const full = await bundleOf(b.log);
  const held = full.commits
    .filter((c) => c.meta.seq >= 2)
    .map((c) => {
      const { payload, ...rest } = c;
      return CONTROL.has(c.meta.seq) ? { ...rest, payload } : rest;
    });
  const items: BundleItem[] = [];
  for (const [id, canonical] of [
    ['ev-1', 'Participant one consented to the text.'],
    ['ev-2', 'Participant two signed the field.'],
  ] as const) {
    const salt = newEvidenceSalt();
    items.push({
      id,
      saltHex: Buffer.from(salt).toString('hex'),
      canonical,
      commitment: await commitEvidence(canonical, salt),
    });
  }
  return {
    format: WORKFLOW_BUNDLE_FORMAT,
    doc: full.doc,
    workflow: 'wf-1',
    log: { from: 2, to: 6, head: full.head, commits: held },
    evidence: buildBundle(items),
    instructions: WORKFLOW_BUNDLE_INSTRUCTIONS,
  };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('verifying a workflow evidence bundle (FRW-055 criterion 3)', () => {
  it('verifies an intact bundle with no findings', async () => {
    const bundle = await fixture();
    expect(isWorkflowEvidenceBundle(bundle)).toBe(true);
    const verdict = await verifyWorkflowEvidenceBundle(bundle);
    expect(verdict).toMatchObject({ ok: true, failedEvidence: [], findings: [] });
    expect(verdict.log.status).toBe('intact');
    expect(verdict.log.payloadsChecked).toBe(CONTROL.size);
  });

  it('names a record whose metadata was altered', async () => {
    const tampered = clone(await fixture());
    tampered.log.commits.find((c) => c.meta.seq === 3)!.meta.user = 'mallory';
    const verdict = await verifyWorkflowEvidenceBundle(tampered);
    expect(verdict.ok).toBe(false);
    expect(verdict.log.status).toBe('altered');
    expect(verdict.findings.some((f) => f.kind === 'commit' && f.ref === 3)).toBe(true);
  });

  it('names a control commit whose payload was altered', async () => {
    const tampered = clone(await fixture());
    tampered.log.commits.find((c) => c.meta.seq === 4)!.payload = {
      steps: [],
      retired: [],
      claimed: ['forged'],
    };
    const verdict = await verifyWorkflowEvidenceBundle(tampered);
    expect(verdict.ok).toBe(false);
    expect(verdict.findings).toContainEqual(expect.objectContaining({ kind: 'commit', ref: 4 }));
  });

  it('names an evidence item whose text was altered, and no other', async () => {
    const tampered = clone(await fixture());
    tampered.evidence.items[1]!.canonical = 'Participant two signed another field.';
    const verdict = await verifyWorkflowEvidenceBundle(tampered);
    expect(verdict.ok).toBe(false);
    expect(verdict.failedEvidence).toEqual(['ev-2']);
    expect(verdict.findings).toEqual([{ kind: 'evidence', ref: 'ev-2', reason: 'mismatch' }]);
    expect(verdict.log.status).toBe('intact');
  });

  it('is not intact when the segment does not start where it says', async () => {
    const tampered = clone(await fixture());
    tampered.log.commits = tampered.log.commits.filter((c) => c.meta.seq !== 3);
    const verdict = await verifyWorkflowEvidenceBundle(tampered);
    expect(verdict.ok).toBe(false);
    expect(verdict.log.status).not.toBe('intact');
  });

  it('refuses what is not a bundle of the format, naming the format', async () => {
    const verdict = await verifyWorkflowEvidenceBundle({ format: 'other' } as never);
    expect(verdict.ok).toBe(false);
    expect(verdict.findings[0]).toMatchObject({ kind: 'format' });
  });

  it('writes the command that verifies it into the instructions', async () => {
    const bundle = await fixture();
    expect(bundle.instructions.join(' ')).toContain('verify-log.ts');
    expect(bundle.instructions.join(' ')).toContain('does not prove who any participant is');
  });
});
