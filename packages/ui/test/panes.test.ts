/**
 * The pane registry (UX-019 criteria 1 and 4): the panes the editor knows at start, the panes a host
 * or an extension adds and removes, and the offer, which needs a loader, an announced feature, the
 * capability the pane needs and its data. The loaders are not called by the registry itself, so a
 * pane's code is not requested by reading the registry (criterion 2 is the host's opening code and
 * stays open).
 */
import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import type { AccessSummary, CoreApi } from '../src/core-api.ts';
import { BUILT_IN_PANES, PaneRegistry, type PaneDescriptor } from '../src/shell/panes.ts';

/** A core with only the views a test sets; the registry reads nothing else. */
function coreWith(parts: { access?: AccessSummary; regions?: boolean }): CoreApi {
  const core: Record<string, unknown> = {};
  if (parts.access) core['access'] = { get: () => parts.access, subscribe: () => () => undefined };
  if (parts.regions) core['regions'] = { get: () => [], subscribe: () => () => undefined };
  return core as unknown as CoreApi;
}

const loader = () => Promise.resolve({ default: {} } as never);

function pane(overrides: Partial<PaneDescriptor> & { id: string }): PaneDescriptor {
  return { label: `pane.${overrides.id}`, load: loader, ...overrides };
}

describe('the registry knows the panes of 13 section 3 at start (UX-019, criterion 1)', () => {
  it('lists navigation (the outline), styles, comments, review, history, permissions, fields, checker, assistant, PDF and recovered edits', () => {
    const known = new PaneRegistry().known();
    for (const id of [
      'outline',
      'styles',
      'comments',
      'review',
      'history',
      'permissions',
      'fields',
      'checker',
      'assistant',
      'pdf',
      'recovered',
    ])
      expect(known).toContain(id);
  });

  it('knows a pane an extension adds at run time, and forgets it when it is removed', () => {
    const registry = new PaneRegistry([]);
    const seen: number[] = [];
    registry.view.subscribe(() => seen.push(registry.known().length));
    const remove = registry.register(pane({ id: 'contributed' }));
    expect(registry.known()).toEqual(['contributed']);
    remove();
    expect(registry.known()).toEqual([]);
    expect(seen).toEqual([1, 0]);
  });

  it('refuses an identifier that is not lower case, so no pane is registered under a name the shell cannot use', () => {
    expect(() => new PaneRegistry([]).register(pane({ id: 'Bad Name' }))).toThrow(/lower case/);
  });

  it('gives the built-in panes with content a loader, and leaves the rest to the host', () => {
    const registry = new PaneRegistry();
    expect(registry.get('outline')?.load).toBeTypeOf('function');
    // The PDF preview is built in (EXP-001); see its offer below.
    expect(registry.get('pdf')?.load).toBeTypeOf('function');
    // The review pane is built in (UX-037): it shows what `suggestionItems` of the core lists.
    expect(registry.get('review')?.load).toBeTypeOf('function');
    // The assistant pane is built in (UX-045); it is offered only while a port is attached.
    expect(registry.get('assistant')?.load).toBeTypeOf('function');
    for (const d of BUILT_IN_PANES) if (d.load) expect(typeof d.load).toBe('function');
  });
});

describe('a pane is offered only when its feature, capability and data are there (UX-019, criterion 4)', () => {
  it('is not offered without a loader, however the rest is set', () => {
    const registry = new PaneRegistry([{ id: 'review', label: 'pane.review' }]);
    expect(registry.offered('review', coreWith({}), ['everything'], ['manage'])).toBe(false);
  });

  it('is not offered while its backend feature is not announced, and is once it is', () => {
    const registry = new PaneRegistry([pane({ id: 'history', feature: 'history' })]);
    expect(registry.offered('history', coreWith({}), [])).toBe(false);
    expect(registry.offered('history', coreWith({}), ['history'])).toBe(true);
  });

  it('is not offered when the user lacks the capability it needs, at the selection by default', () => {
    const registry = new PaneRegistry([pane({ id: 'fill', capability: 'fill' })]);
    const atBody: AccessSummary = { scope: 'body', caps: ['view', 'edit'] };
    const asParticipant: AccessSummary = { scope: 'field:f1', caps: ['view', 'fill'] };
    expect(registry.offered('fill', coreWith({ access: atBody }), [])).toBe(false);
    expect(registry.offered('fill', coreWith({ access: asParticipant }), [])).toBe(true);
  });

  it('uses the capabilities the caller passes when it has them, and refuses with none (no access view)', () => {
    const registry = new PaneRegistry([pane({ id: 'fill', capability: 'fill' })]);
    expect(registry.offered('fill', coreWith({}), [], ['fill'])).toBe(true);
    expect(registry.offered('fill', coreWith({}), [])).toBe(false);
  });

  it('is not offered while its data is missing (the permissions pane needs the regions view)', () => {
    const registry = new PaneRegistry();
    expect(registry.offered('permissions', coreWith({}), [])).toBe(false);
    expect(registry.offered('permissions', coreWith({ regions: true }), [])).toBe(true);
  });

  it('offers the PDF preview only with the exports feature, a viewer and a core that follows the newest PDF (EXP-001)', () => {
    const registry = new PaneRegistry();
    const view = { get: () => null, subscribe: () => () => undefined };
    const viewer = { open: () => Promise.reject(new Error('not used')) };
    const core = (parts: Record<string, unknown>) => parts as unknown as CoreApi;
    const full = core({ pdf: viewer, exports: { latestPdf: view } });
    expect(registry.offered('pdf', full, ['exports'])).toBe(true);
    expect(registry.offered('pdf', full, [])).toBe(false);
    expect(registry.offered('pdf', core({ exports: { latestPdf: view } }), ['exports'])).toBe(
      false,
    );
    expect(registry.offered('pdf', core({ pdf: viewer, exports: {} }), ['exports'])).toBe(false);
    expect(registry.offered('pdf', core({ pdf: viewer }), ['exports'])).toBe(false);
  });

  it('is not offered when the pane is not known at all', () => {
    expect(new PaneRegistry([]).offered('nothing', coreWith({}), [])).toBe(false);
  });

  it('is offered exactly when both the feature and the capability are there (property)', () => {
    const registry = new PaneRegistry([
      pane({ id: 'gated', feature: 'history', capability: 'manage' }),
    ]);
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (hasFeature, hasCap) => {
        const offered = registry.offered(
          'gated',
          coreWith({}),
          hasFeature ? ['history'] : [],
          hasCap ? ['manage'] : [],
        );
        expect(offered).toBe(hasFeature && hasCap);
      }),
    );
  });

  it('does not run a loader to answer the offer', () => {
    const spy = vi.fn(loader);
    const registry = new PaneRegistry([pane({ id: 'lazy', load: spy })]);
    registry.offered('lazy', coreWith({}), []);
    expect(spy).not.toHaveBeenCalled();
  });
});
