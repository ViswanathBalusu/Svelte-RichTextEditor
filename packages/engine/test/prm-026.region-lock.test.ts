/**
 * Which regions the core marks as locked (PRM-026 criterion 1; PRM-006 criterion 5; lane w9): the
 * regions whose scope lacks `edit` under the access in force, and no other. The web view shades
 * exactly these and draws their lock indicators (`view/region-lock-view.ts`; the drawing is tested in
 * browsers by `src/view/prm-026-region-lock.universal.test.ts` and by the element's Playwright
 * suites). Here: the rule itself, the words, and that a new access gives a new answer at once.
 */
import type { Access } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { DEFAULT_REGION_LOCK_LABEL, regionLockSpecs } from '../src/region-lock.ts';
import { internals } from '../src/testing.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { join, microtask, newService, posOf, until } from './support.ts';

const OPEN = `region:${IDS.open}`;
const LOCKED = `region:${IDS.locked}`;
const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;
const READ = ['view', 'comment'] as const;

function access(scopes: Record<string, readonly string[]>, over: Partial<Access> = {}): Access {
  return {
    rev: 1,
    asOfSeq: 0,
    docRole: 'editor',
    caps: [...EDIT],
    scopes: { doc: ['view'], body: [...EDIT], defs: ['view'], ...scopes } as Access['scopes'],
    leases: {},
    fill: null,
    restrictions: [],
    ...over,
  };
}

function core(a: Access | null): DocumentCore {
  return new DocumentCore({
    doc: contractDocument(),
    schedule: microtask,
    ...(a ? { access: a } : {}),
  });
}

const ids = (c: DocumentCore): string[] => c.regionLocks().map((l) => l.id);

describe('the regions the user cannot edit (PRM-026 criterion 1)', () => {
  it('are the regions whose scope lacks edit, with the positions of their nodes', () => {
    const c = core(access({ [OPEN]: [...EDIT], [LOCKED]: [...READ] }));
    const doc = internals(c).state.doc;
    const at = posOf(doc, IDS.locked);
    expect(c.regionLocks()).toEqual([
      {
        id: IDS.locked,
        from: at,
        to: at + doc.nodeAt(at)!.nodeSize,
        unlisted: false,
        label: DEFAULT_REGION_LOCK_LABEL,
      },
    ]);
    expect(doc.nodeAt(at)!.type.name).toBe('region');
  });

  it('are none for a user who may edit every region, and none while there is no access', () => {
    expect(ids(core(access({ [OPEN]: [...EDIT], [LOCKED]: [...EDIT] })))).toEqual([]);
    // No backend has told the core anything: nothing is refused, so nothing is shaded.
    expect(ids(core(null))).toEqual([]);
  });

  it('are every region for a viewer, in document order', () => {
    const viewer = access(
      { body: ['view'], [OPEN]: ['view'], [LOCKED]: ['view'] },
      { docRole: 'viewer', caps: ['view'] },
    );
    expect(ids(core(viewer))).toEqual([IDS.open, IDS.locked]);
  });

  it('include a region where the user may only suggest, since edit is missing there', () => {
    const c = core(access({ [OPEN]: ['view', 'comment', 'suggest'], [LOCKED]: [...EDIT] }));
    expect(ids(c)).toEqual([IDS.open]);
  });

  it('include a region the access does not list yet, marked as unlisted (05 §5.5; PRM-006)', () => {
    const c = core(access({ [LOCKED]: [...EDIT] }));
    expect(c.regionLocks().map((l) => [l.id, l.unlisted])).toEqual([[IDS.open, true]]);
  });

  it('never include the body, a story or the definitions, whatever the access says', () => {
    const c = core(
      access(
        { body: ['view'], doc: ['view'], defs: ['view'], [OPEN]: [...EDIT], [LOCKED]: [...EDIT] },
        { docRole: 'viewer', caps: ['view'] },
      ),
    );
    expect(ids(c)).toEqual([]);
  });
});

describe('the words of the lock indicators (PRM-026 criterion 2)', () => {
  it('are the shell’s for the regions it names, and the defaults for the others', () => {
    const c = core(access({ [LOCKED]: [...READ] }));
    const named = { indicator: 'Read-only', description: 'It can be edited by Ada Lovelace.' };
    const unlisted = { indicator: 'Read-only', description: 'Not arrived yet.' };
    const locked = { indicator: 'Nur lesen', description: '' };
    c.setRegionLabels({ [IDS.locked]: named }, { locked, unlisted });
    expect(c.regionLocks().map((l) => [l.id, l.label])).toEqual([
      [IDS.open, unlisted],
      [IDS.locked, named],
    ]);
    // Without words of its own, a listed region takes the default for locked regions.
    c.setRegionLabels({}, { locked, unlisted });
    expect(c.regionLocks().map((l) => l.label)).toEqual([unlisted, locked]);
    // With no defaults at all, the core's English words are used.
    c.setRegionLabels({});
    expect(c.regionLocks().map((l) => l.label)).toEqual([
      DEFAULT_REGION_LOCK_LABEL,
      DEFAULT_REGION_LOCK_LABEL,
    ]);
  });

  it('never decide which regions are locked: words for a region the user may edit are unused', () => {
    const c = core(access({ [OPEN]: [...EDIT], [LOCKED]: [...READ] }));
    c.setRegionLabels({
      [IDS.open]: { indicator: 'Read-only', description: 'stale words' },
      [IDS.locked]: { indicator: 'Read-only', description: 'It can be edited by owners.' },
    });
    expect(ids(c)).toEqual([IDS.locked]);
  });

  it('are read as own properties only, so an identifier never picks up an inherited member', () => {
    const doc = internals(core(null)).state.doc;
    const a = access({ [OPEN]: [...READ], [LOCKED]: [...READ] });
    const inherited = Object.create({
      [IDS.open]: { indicator: 'inherited', description: 'inherited' },
    }) as Record<string, { indicator: string; description: string }>;
    expect(regionLockSpecs(doc, a, inherited).map((l) => l.label)).toEqual([
      DEFAULT_REGION_LOCK_LABEL,
      DEFAULT_REGION_LOCK_LABEL,
    ]);
  });
});

describe('a new access gives a new answer without a reload (PRM-006 criterion 5)', () => {
  it('follows setAccess on the same core, and keeps the words that were set', () => {
    const c = core(access({ [OPEN]: [...EDIT], [LOCKED]: [...READ] }));
    const words = { indicator: 'Read-only', description: 'It can be edited by document owners.' };
    c.setRegionLabels({ [IDS.locked]: words, [IDS.open]: words });
    const doc = internals(c).state.doc;
    expect(ids(c)).toEqual([IDS.locked]);
    c.setAccess(access({ [OPEN]: [...READ], [LOCKED]: [...EDIT] }, { rev: 2 }));
    expect(c.regionLocks().map((l) => [l.id, l.label])).toEqual([[IDS.open, words]]);
    c.setAccess(access({ [OPEN]: [...EDIT], [LOCKED]: [...EDIT] }, { rev: 3 }));
    expect(ids(c)).toEqual([]);
    // The document was not replaced by any of this.
    expect(internals(c).state.doc).toBe(doc);
  });

  it('follows perm.changed from the service: a grant unlocks the region, its removal locks it', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument(), { grants: [] });
    const bob = await join(service, docId, 'bob', 'editor', {}, { groups: ['legal'] });
    await until(() => bob.core.permissions.get() !== null, 'the first access');
    const doc = internals(bob.core).state.doc;
    // An editor may edit the open region by role; the restricted one needs a grant (07 §4).
    expect(ids(bob.core)).toEqual([IDS.locked]);

    service.setGrants(docId, [LEGAL_GRANT_FOR_TESTS]);
    await until(
      () => bob.core.permissions.get()?.scopes[LOCKED]?.includes('edit') === true,
      'the granted access',
    );
    expect(ids(bob.core)).toEqual([]);

    service.setGrants(docId, []);
    await until(
      () => bob.core.permissions.get()?.scopes[LOCKED]?.includes('edit') !== true,
      'the revoked access',
    );
    expect(ids(bob.core)).toEqual([IDS.locked]);
    // The same core and the same document throughout: nothing was reloaded.
    expect(internals(bob.core).state.doc).toBe(doc);

    bob.detach();
    await service.dispose();
  });
});
