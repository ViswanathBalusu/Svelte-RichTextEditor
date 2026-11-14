/**
 * Extension panels and status-bar items (UX-052; 13 §3, §7.1). Criterion 1 is tested here in part:
 * a contributed panel is offered by the pane registry and its loader runs on the first open only.
 * Criterion 2 is tested on the status-bar registry: items come in their position's order, each with
 * a text alternative. Criterion 5 is a source check: the panel and status bar markup sit inside the
 * shell's `.de-shell` root, and the stylesheet declares the internal tokens there, so a panel
 * renders with the public `--de-` properties. Not claimed here: the pane host's focus and Ctrl+F6
 * (UX-023), the rendered status bar, and the axe run of the sample extension (no browser run).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import type { Component } from 'svelte';
import type { CoreApi } from '../src/core-api.ts';
import {
  ContributionError,
  StatusItemRegistry,
  contributePanel,
  type StatusItem,
} from '../src/extensions/contributions.ts';
import { BUILT_IN_PANES, PaneRegistry, type PaneComponent } from '../src/shell/panes.ts';

const fakeComponent = {} as Component<never> as PaneComponent;
const noCore = {} as CoreApi;

function freshRegistry(): PaneRegistry {
  return new PaneRegistry([...BUILT_IN_PANES]);
}

describe('contributed panels (UX-052 criterion 1, in part)', () => {
  it('records a panel without loading it, and offers it through the pane registry', () => {
    const registry = freshRegistry();
    const load = vi.fn(() => Promise.resolve(fakeComponent));
    const remove = contributePanel(registry, { id: 'sample-panel', label: 'Sample', load });
    expect(load).not.toHaveBeenCalled();
    expect(registry.offered('sample-panel', noCore, [])).toBe(true);
    expect(load).not.toHaveBeenCalled();
    remove();
    expect(registry.get('sample-panel')).toBeUndefined();
  });

  it('runs the loader on the first open only, and keeps the component for later opens', async () => {
    const registry = freshRegistry();
    const load = vi.fn(() => Promise.resolve(fakeComponent));
    contributePanel(registry, { id: 'sample-panel', label: 'Sample', load });
    const descriptor = registry.get('sample-panel');
    expect(descriptor?.load).toBeDefined();
    const first = await descriptor!.load!();
    const second = await descriptor!.load!();
    expect(first).toBe(fakeComponent);
    expect(second).toBe(fakeComponent);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('forgets a failed load so that the next open tries again', async () => {
    const registry = freshRegistry();
    let attempts = 0;
    contributePanel(registry, {
      id: 'flaky-panel',
      label: 'Flaky',
      load: () => {
        attempts++;
        return attempts === 1
          ? Promise.reject(new Error('chunk missing'))
          : Promise.resolve(fakeComponent);
      },
    });
    const descriptor = registry.get('flaky-panel')!;
    await expect(descriptor.load!()).rejects.toThrow('chunk missing');
    await expect(descriptor.load!()).resolves.toBe(fakeComponent);
    expect(attempts).toBe(2);
  });

  it('forgets a loader that throws synchronously, and reports it as a rejection', async () => {
    const registry = freshRegistry();
    contributePanel(registry, {
      id: 'broken-panel',
      label: 'Broken',
      load: () => {
        throw new Error('boom');
      },
    });
    await expect(registry.get('broken-panel')!.load!()).rejects.toThrow('boom');
  });

  it('refuses an identifier that a built-in pane already has, and leaves that pane as it was', () => {
    const registry = freshRegistry();
    const before = registry.get('outline');
    expect(() =>
      contributePanel(registry, {
        id: 'outline',
        label: 'Replacement',
        load: () => Promise.resolve(fakeComponent),
      }),
    ).toThrow(ContributionError);
    expect(registry.get('outline')).toBe(before);
  });

  it('refuses a bad identifier, a blank label and a missing loader', () => {
    const registry = freshRegistry();
    const load = () => Promise.resolve(fakeComponent);
    expect(() => contributePanel(registry, { id: 'Sample', label: 'x', load })).toThrow(
      ContributionError,
    );
    expect(() => contributePanel(registry, { id: 'sample', label: '   ', load })).toThrow(
      ContributionError,
    );
    expect(() =>
      contributePanel(registry, {
        id: 'sample',
        label: 'x',
        load: undefined as unknown as () => Promise<PaneComponent>,
      }),
    ).toThrow(ContributionError);
    expect(registry.get('sample')).toBeUndefined();
  });

  it('property: any lower-case identifier that is not taken is accepted once', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/), (id) => {
        const registry = new PaneRegistry([]);
        const remove = contributePanel(registry, {
          id,
          label: 'Panel',
          load: () => Promise.resolve(fakeComponent),
        });
        expect(registry.get(id)?.label).toBe('Panel');
        expect(() =>
          contributePanel(registry, {
            id,
            label: 'Again',
            load: () => Promise.resolve(fakeComponent),
          }),
        ).toThrow(ContributionError);
        remove();
        expect(registry.get(id)).toBeUndefined();
      }),
    );
  });
});

describe('contributed status-bar items (UX-052 criterion 2)', () => {
  const validItem = (id: string, position: 'start' | 'end'): StatusItem => ({
    id,
    position,
    text: 'Words: 12',
    label: 'Word count',
  });

  it('lists start items before end items, each in registration order (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('start' as const, 'end' as const), { maxLength: 12 }),
        (positions) => {
          const registry = new StatusItemRegistry();
          positions.forEach((position, index) =>
            registry.add(validItem(`area.item-${index}`, position)),
          );
          const expected = [
            ...positions.map((p, i) => ({ p, i })).filter((x) => x.p === 'start'),
            ...positions.map((p, i) => ({ p, i })).filter((x) => x.p === 'end'),
          ].map((x) => `area.item-${x.i}`);
          expect(registry.list().map((item) => item.id)).toEqual(expected);
        },
      ),
    );
  });

  it('refuses an item with no text alternative, no text, a bad position or a bad identifier', () => {
    const registry = new StatusItemRegistry();
    expect(() => registry.add({ ...validItem('area.a', 'start'), label: '' })).toThrow(
      ContributionError,
    );
    expect(() => registry.add({ ...validItem('area.a', 'start'), label: ' \t ' })).toThrow(
      ContributionError,
    );
    expect(() => registry.add({ ...validItem('area.a', 'start'), text: '' })).toThrow(
      ContributionError,
    );
    expect(() =>
      registry.add({ ...validItem('area.a', 'start'), position: 'middle' as unknown as 'start' }),
    ).toThrow(ContributionError);
    expect(() => registry.add(validItem('Area', 'start'))).toThrow(ContributionError);
    expect(registry.list()).toEqual([]);
  });

  it('property: every blank label is refused and nothing is listed afterwards', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[ \t\n]{0,6}$/), (blank) => {
        const registry = new StatusItemRegistry();
        expect(() => registry.add({ ...validItem('area.a', 'end'), label: blank })).toThrow(
          ContributionError,
        );
        expect(registry.list()).toEqual([]);
      }),
    );
  });

  it('refuses a duplicate identifier, keeps the first item, and removes an item on request', () => {
    const registry = new StatusItemRegistry();
    const remove = registry.add(validItem('area.a', 'start'));
    expect(() => registry.add({ ...validItem('area.a', 'end'), text: 'other' })).toThrow(
      ContributionError,
    );
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]?.position).toBe('start');
    const version = registry.view.get();
    remove();
    expect(registry.list()).toEqual([]);
    expect(registry.view.get()).toBeGreaterThan(version);
  });
});

describe('the shell styles reach a contributed panel (UX-052 criterion 5, source check)', () => {
  const app = readFileSync(fileURLToPath(new URL('../src/App.svelte', import.meta.url)), 'utf8');
  const css = readFileSync(
    fileURLToPath(new URL('../src/styles/shell.css', import.meta.url)),
    'utf8',
  );

  it('mounts the pane host and the status bar inside the shell root that reads the public tokens', () => {
    const root = app.indexOf('class="de-shell"');
    expect(root).toBeGreaterThan(-1);
    const pane = app.indexOf('class="de-pane"');
    const status = app.indexOf('<StatusBar');
    expect(pane).toBeGreaterThan(root);
    expect(status).toBeGreaterThan(root);
  });

  it('declares the internal tokens on the shell root, each read from a public --de- property', () => {
    const block = css.slice(css.indexOf('.de-shell {'));
    const declared = [...block.matchAll(/--_de-([a-z0-9-]+):\s*var\(--de-\1,/g)].map((m) => m[1]);
    expect(declared).toContain('text');
    expect(declared).toContain('focus');
    expect(declared.length).toBeGreaterThan(10);
  });
});
