// FRW-066 criterion 5: the fill property packaged as the conformance profile `perm-fill`, run
// black-box against the reference service through DEP with tokens minted by `POST /tokens` (the
// `wfr` member, 05 §3.1). Lane w4. Three things are checked:
//   1. the reference service passes, and the run is not vacuous (commits accepted and refused);
//   2. a server that grants more than the contract fails, and the report names the seed, the
//      operations of the failing sequence and the steps of the commit that broke the property
//      (the over-grant is a token that asks for a second role, so the reference service, which
//      honours it, stands for a candidate that grants too much);
//   3. the oracle and the step builder behave as the profile relies on.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fieldsDocument } from '../src/profiles/fields.ts';
import {
  FILL_ROLE,
  fillSteps,
  permFillProfile,
  setAsideFilled,
  type FillOp,
} from '../src/profiles/perm-fill.ts';
import { PROFILES } from '../src/profiles/index.ts';
import type { JsonNode } from '../src/documents.ts';
import type { KitReport } from '../src/report.ts';
import { runKit } from '../src/runner.ts';
import { keep } from './targets/judge.ts';
import { startReference, type StartedTarget } from './targets/reference.ts';

const skip = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';
const SEED = 66;

describe.skipIf(skip)('FRW-066: the perm-fill profile against the reference service', () => {
  let target: StartedTarget;
  beforeAll(async () => {
    target = await startReference();
  }, 300_000);
  afterAll(async () => {
    await target?.stop();
  });

  const run = (profile: ReturnType<typeof permFillProfile>): Promise<KitReport> =>
    runKit(
      {
        discovery: target.discovery,
        credential: target.credential,
        origin: target.origin,
        testMode: false,
        profiles: ['core', 'perm-fill'],
        scenarios: ['perm-fill.property'],
        property: { runs: 12, seed: SEED },
      },
      [PROFILES.find((p) => p.id === 'core')!, profile],
    );
  const scenario = (report: KitReport) =>
    report.profiles.flatMap((p) => p.scenarios).find((s) => s.id === 'perm-fill.property');

  it('passes against a server that grants the fill role and nothing else, and judges commits', async () => {
    const report = await run(permFillProfile());
    keep('reference-perm-fill', report);
    const s = scenario(report);
    expect(s?.outcome, s?.failure?.message ?? s?.reason ?? '').toBe('passed');
    // The run says how many commits it judged: some accepted, some refused.
    const note = (s?.notes ?? []).join(' ');
    expect(note).toMatch(
      /seed 66, 12 runs: \d+ commits submitted, [1-9]\d* accepted, [1-9]\d* refused/,
    );
  }, 600_000);

  it('fails a server that grants more than the contract, and names the failing sequence', async () => {
    const report = await run(permFillProfile([FILL_ROLE, 'role_landlord']));
    keep('reference-perm-fill-overgrant', report);
    const s = scenario(report);
    expect(s?.outcome).toBe('failed');
    const text = `${s?.failure?.message ?? ''} ${s?.failure?.received ?? ''}`;
    // The seed, so that the run can be repeated, and the steps of the commit that broke the property.
    expect(text).toMatch(/seed: 66/);
    expect(text).toMatch(/steps \[\{"stepType":"attr"/);
    expect(text).toContain('an accepted commit changed more than the values of the participant');
    expect(text).toContain('fill-landlord');
  }, 600_000);
});

describe('the oracle and the steps of perm-fill', () => {
  const doc = fieldsDocument().doc as unknown as JsonNode;
  const roles = [FILL_ROLE];

  it('sets aside the value of a field of the role and nothing else', () => {
    const same = (a: JsonNode, b: JsonNode) =>
      JSON.stringify(setAsideFilled(a, roles)) === JSON.stringify(setAsideFilled(b, roles));
    const withAttr = (id: string, attr: string, value: unknown): JsonNode => {
      const copy = structuredClone(doc);
      const visit = (n: JsonNode): void => {
        if (n.attrs?.['id'] === id) n.attrs[attr] = value;
        n.content?.forEach(visit);
      };
      visit(copy);
      return copy;
    };
    // The value of the tenant's text field is the participant's to change.
    expect(same(doc, withAttr('fName00000000001', 'value', 'Ada'))).toBe(true);
    // The landlord's value, a signature, a date a server writes, a label and an assignee are not.
    expect(same(doc, withAttr('fRent00000000001', 'value', '12.50'))).toBe(false);
    expect(same(doc, withAttr('fSign00000000001', 'value', { asset: 'a' }))).toBe(false);
    expect(same(doc, withAttr('fDate00000000001', 'value', '2026-11-17'))).toBe(false);
    expect(same(doc, withAttr('fName00000000001', 'label', 'other'))).toBe(false);
    expect(same(doc, withAttr('fName00000000001', 'assignee', 'role_landlord'))).toBe(false);
  });

  it('builds the steps of each operation on the document the participant read', () => {
    const ops: FillOp[] = [
      { kind: 'fill-own', value: 'x' },
      { kind: 'fill-landlord', value: '1' },
      { kind: 'fill-server', field: 'sign', value: 'x' },
      { kind: 'edit-text', offset: 2, text: 'a' },
      { kind: 'delete-field', field: 'rent' },
      { kind: 'retarget', attr: 'assignee', value: 'role_landlord' },
      { kind: 'paste-field', assignee: 'role_tenant', value: 'v' },
      { kind: 'bold', offset: 1, len: 1 },
      { kind: 'wrap' },
      { kind: 'concurrent', theirs: 'a', mine: 'b' },
    ];
    for (const op of ops) expect(fillSteps(doc, op).length, op.kind).toBeGreaterThan(0);
    expect(fillSteps(doc, { kind: 'fill-own', value: 'x' })[0]).toMatchObject({
      stepType: 'attr',
      attr: 'value',
      value: 'x',
    });
  });
});
