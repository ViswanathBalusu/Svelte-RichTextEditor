/**
 * FE-020 criterion 3 (owner decision 252): overlays are placed by Floating UI, in script. These
 * Node.js tests cover the parts that need no layout: the point reference, the placement order for
 * both reading directions, and that the shell uses the Floating UI module and no longer carries its
 * own clamp. The near-edge behaviour is run in four browsers by
 * `packages/element/e2e/fe-020-near-edge.spec.ts`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OVERLAY_EDGE_PADDING,
  placementsFor,
  pointReference,
} from '../src/shell/overlay-position.ts';

const here = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('FE-020 criterion 3: Floating UI places the overlays', () => {
  it('the point reference is a rectangle of no size at the point', () => {
    const rect = pointReference({ x: 30, y: 40 }).getBoundingClientRect();
    expect(rect).toEqual({
      x: 30,
      y: 40,
      width: 0,
      height: 0,
      top: 40,
      left: 30,
      right: 30,
      bottom: 40,
    });
  });

  it('opens below the point at the inline start and tries the other sides in turn', () => {
    expect(placementsFor(false)).toEqual({
      first: 'bottom-start',
      fallbacks: ['top-start', 'bottom-end', 'top-end'],
    });
    expect(placementsFor(true)).toEqual({
      first: 'bottom-end',
      fallbacks: ['top-end', 'bottom-start', 'top-start'],
    });
    expect(OVERLAY_EDGE_PADDING).toBeGreaterThan(0);
  });

  it('the position module uses Floating UI, flip and shift, with fixed positioning', () => {
    const source = here('../src/shell/overlay-position.ts');
    expect(source).toMatch(/from '@floating-ui\/dom'/);
    expect(source).toMatch(/flip\(/);
    expect(source).toMatch(/shift\(/);
    expect(source).toMatch(/strategy: 'fixed'/);
  });

  it('the context menu is placed by that module and the shell has no clamp of its own', () => {
    const menu = here('../src/components/ContextMenu.svelte');
    expect(menu).toMatch(/placeOverlay/);
    expect(menu).not.toMatch(/placeMenu/);
    expect(here('../src/shell/toolbar-groups.ts')).not.toMatch(/placeMenu/);
  });

  it('@floating-ui/dom is a dependency of the shell at an exact version', () => {
    const manifest = JSON.parse(here('../package.json')) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies['@floating-ui/dom']).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
