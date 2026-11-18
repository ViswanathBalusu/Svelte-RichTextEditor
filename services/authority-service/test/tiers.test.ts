// What a sidecar-backed backend may announce is what the authority service supports (05 §9;
// PRO-101 criterion 2), read from the service itself.
import { DEP1_WIRE } from '@docedit/protocol';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilities, sidecarProblems, type Capabilities } from '../src/capabilities.ts';
import { type RunningServer, listen } from '../src/http.ts';
import { AuthorityService } from '../src/service.ts';

const ALL = DEP1_WIRE.features.map((f) => f.name);

describe('capabilities', () => {
  let running: RunningServer | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('are served at /v1/authority/capabilities and name the calls that are built', async () => {
    running = await listen({ service: new AuthorityService() });
    const res = await fetch(`${running.url}/v1/authority/capabilities`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Capabilities;
    expect(body).toEqual(capabilities(new AuthorityService().calls));
    expect(body.calls).toEqual([
      'open',
      'materialise',
      'applyCommit',
      'restoreSteps',
      'diff',
      'attribution',
      'evaluateRules',
      'mapRanges',
    ]);
  });

  it('do not offer a feature whose call is not built', () => {
    const { features } = capabilities(new AuthorityService().calls);
    // Reader projection is not a call of 05 §10 and no service offers it (ADR 0019).
    for (const f of ['read-restrictions']) expect(features, f).not.toContain(f);
    // `applyCommit` (PRO-104) and `evaluateRules` (PRO-107) are built, so these are offered.
    for (const f of ['regions', 'suggest-enforced', 'fields', 'rules', 'history'])
      expect(features).toContain(f);
    // Features of the backend's own planes do not depend on the service.
    for (const f of ['presence', 'comments', 'workflow', 'leases'])
      expect(features, f).toContain(f);
  });

  it('is the limit of what a sidecar announces', () => {
    const { features } = capabilities();
    expect(sidecarProblems(features)).toEqual([]);
    fc.assert(
      fc.property(fc.subarray(ALL), (announced) => {
        const outside = announced.filter((f) => !features.includes(f)).sort();
        expect(
          sidecarProblems(announced)
            .map((p) => p.feature)
            .sort(),
        ).toEqual(outside);
      }),
    );
  });

  it('say what is missing in the refusal', () => {
    expect(sidecarProblems(['read-restrictions'])).toMatchObject([
      { code: 'needs_authority_service', feature: 'read-restrictions' },
    ]);
    expect(sidecarProblems(['read-restrictions'])[0]!.message).toContain('projection');
  });
});
