/**
 * PRM-030 criterion 2, the part the engine has a command for (lane PRM-015-028, round 4): a user who
 * may edit only inside regions is told by `queryCommand` that `setPageSetup` is not enabled, and why,
 * and a run changes nothing. A user with `structure` and `edit` on the definitions is enabled.
 *
 * Not covered here: style definitions, numbering definitions and header or footer content have no
 * command in the engine yet (PRM-030 Notes), so the criterion stays open.
 */
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { ownerAccess, regionOnlyAccess, spikeDocument } from './fixtures.ts';
import { microtask } from './support.ts';

const PAGE_SETUP = { pageSetup: { id: 'ps1', changes: { paperSize: 'Letter' as const } } };

function core(access = regionOnlyAccess()): DocumentCore {
  return new DocumentCore({ doc: spikeDocument(), access, schedule: microtask });
}

describe('a region-only editor cannot change page setup (PRM-030 criterion 2, page setup)', () => {
  it('reports setPageSetup as not enabled, with a reason, and leaves the document unchanged', () => {
    const c = core();
    const before = internals(c).state.doc;
    const state = c.queryCommand('setPageSetup', PAGE_SETUP);

    expect(state.enabled).toBe(false);
    expect(state.reason).toBeDefined();
    expect(c.run('setPageSetup', PAGE_SETUP)).toBe(false);
    expect(internals(c).state.doc).toBe(before);
  });

  it('reports the same command as enabled for an owner, so the refusal comes from the access', () => {
    const c = core(ownerAccess());
    expect(c.queryCommand('setPageSetup', PAGE_SETUP)).toMatchObject({ enabled: true });
  });
});
