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
    expect(body.calls).toEqual(['open', 'materialise', 'evaluateRules']);
  });

  it('do not offer a feature whose call is not built', () => {
    const { features } = capabilities(new AuthorityService().calls);
    // `applyCommit` (PRO-104) and the history calls (PRO-106) are not implemented here yet.
    for (const f of ['regions', 'suggest-enforced', 'fields', 'history', 'read-restrictions'])
      expect(features, f).not.toContain(f);
    // `evaluateRules` is built (PRO-107), so `rules` is offered.
    expect(features).toContain('rules');
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
    expect(sidecarProblems(['regions'])).toMatchObject([
      { code: 'needs_authority_service', feature: 'regions' },
    ]);
    expect(sidecarProblems(['regions'])[0]!.message).toContain('applyCommit');
  });
});
