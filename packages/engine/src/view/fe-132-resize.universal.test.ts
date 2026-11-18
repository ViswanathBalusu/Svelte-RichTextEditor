/**
 * FE-132 criterion 2 in a real browser: a figure and an inline image take their stored size, and a
 * resize handle changes it. The handle's drag keeps the aspect ratio unless Shift is held, the keys
 * do the same in steps of 10 pixels, and the stored `width` and `height` are twips (15 per CSS
 * pixel). A view that is not editable changes nothing.
 *
 * Run with `pnpm vitest run --project browser <this file>`. Skipped in Node.js (no DOM). The real
 * mouse is exercised by packages/element/e2e/fe-132-resize.spec.ts.
 */
import type { Node as PmNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { ownerAccess } from '../../test/fixtures.ts';
import { spikeDocument } from '../spike-document.ts';
import { EditorCore, viewsOf } from './web.ts';

const isBrowser = typeof document !== 'undefined' && typeof DataTransfer !== 'undefined';
const ASSET = 'a'.repeat(32);

interface Rig {
  readonly host: HTMLElement;
  readonly core: EditorCore;
  node(kind: 'figure' | 'image'): PmNode;
  attrs(kind: 'figure' | 'image'): { width: number; height: number };
  done(): void;
}

/** A body with one figure (1500 by 750 twips) and one inline image (1500 by 1500 twips). */
function rig(readOnly = false): Rig {
  const host = document.createElement('div');
  document.body.append(host);
  const core = new EditorCore({
    doc: spikeDocument(),
    access: ownerAccess(),
    schedule: (run) => queueMicrotask(run),
  });
  const unmount = core.mountBody(host);
  const view = viewsOf(core).view!;
  const { schema } = view.state;
  let at = -1;
  view.state.doc.descendants((n, pos) => {
    if (at < 0 && n.isText && n.text?.includes('Alpha')) at = pos;
    return at < 0;
  });
  const image = schema.nodes['image']!.create({
    asset: ASSET,
    width: 1500,
    height: 1500,
    alt: 'i',
  });
  view.dispatch(view.state.tr.insert(at, image));
  let end = -1;
  view.state.doc.forEach((child, offset) => {
    if (child.type.name === 'body') end = offset + child.nodeSize - 1;
  });
  const figure = schema.nodes['figure']!.create({
    id: null,
    asset: ASSET,
    width: 1500,
    height: 750,
    alt: 'A chart',
    align: null,
    placement: 'here',
  });
  view.dispatch(view.state.tr.insert(end, figure));
  // The view mode locks the document (mode.ts); the content above was inserted while it was open.
  if (readOnly) core.setMode('view');
  const find = (kind: string): PmNode => {
    let found: PmNode | null = null;
    view.state.doc.descendants((n) => {
      if (!found && n.type.name === kind) found = n;
      return !found;
    });
    return found!;
  };
  return {
    host,
    core,
    node: (kind) => find(kind),
    attrs: (kind) => {
      const n = find(kind);
      return { width: n.attrs['width'] as number, height: n.attrs['height'] as number };
    },
    done: () => {
      unmount();
      core.destroy();
      host.remove();
    },
  };
}

const handleOf = (host: HTMLElement, selector: string): HTMLElement =>
  host.querySelector<HTMLElement>(`${selector} .de-resize-handle`)!;

function pointer(el: HTMLElement, type: string, x: number, y: number, shiftKey = false): void {
  el.dispatchEvent(
    new PointerEvent(type, {
      pointerId: 7,
      button: 0,
      clientX: x,
      clientY: y,
      shiftKey,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function press(el: HTMLElement, key: string, shiftKey = false): void {
  el.dispatchEvent(
    new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }),
  );
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

describe.skipIf(!isBrowser)('pictures resize with a handle (FE-132 criterion 2)', () => {
  it('draws the stored size in CSS pixels and a slider handle on a figure and an image', async () => {
    const r = rig();
    try {
      await settle();
      const box = r.host.querySelector<HTMLElement>('.de-figure-image')!;
      expect(box.style.inlineSize).toBe('100px'); // 1500 twips
      expect(box.style.blockSize).toBe('50px'); // 750 twips
      const img = r.host.querySelector<HTMLElement>('.de-image')!;
      expect(img.style.inlineSize).toBe('100px');
      expect(img.style.blockSize).toBe('100px');
      for (const selector of ['.de-figure-image', '.de-image']) {
        const handle = handleOf(r.host, selector);
        expect(handle.getAttribute('role')).toBe('slider');
        expect(handle.tabIndex).toBe(0);
        expect(handle.getAttribute('aria-valuenow')).toBe('1500');
      }
    } finally {
      r.done();
    }
  });

  it('a drag stores the width in twips and keeps the aspect ratio', async () => {
    const r = rig();
    try {
      await settle();
      const handle = handleOf(r.host, '.de-figure-image');
      pointer(handle, 'pointerdown', 100, 100);
      pointer(handle, 'pointermove', 140, 100); // 40 pixels right: 600 twips
      const box = r.host.querySelector<HTMLElement>('.de-figure-image')!;
      expect(box.style.inlineSize).toBe('140px'); // a preview, not yet stored
      expect(r.attrs('figure')).toEqual({ width: 1500, height: 750 });
      pointer(handle, 'pointerup', 140, 100);
      expect(r.attrs('figure')).toEqual({ width: 2100, height: 1050 });
      await settle();
      expect(r.host.querySelector<HTMLElement>('.de-figure-image')!.style.inlineSize).toBe('140px');
      expect(r.host.querySelector<HTMLElement>('.de-figure-image')!.style.blockSize).toBe('70px');
    } finally {
      r.done();
    }
  });

  it('a drag released with Shift held unlocks the aspect ratio', async () => {
    const r = rig();
    try {
      await settle();
      const handle = handleOf(r.host, '.de-figure-image');
      pointer(handle, 'pointerdown', 100, 100);
      pointer(handle, 'pointermove', 120, 90, true); // 20 right, 10 up
      pointer(handle, 'pointerup', 120, 90, true);
      expect(r.attrs('figure')).toEqual({ width: 1800, height: 600 });
    } finally {
      r.done();
    }
  });

  it('a drag that the command refuses leaves the size as it was and redraws it', async () => {
    const r = rig();
    try {
      await settle();
      const handle = handleOf(r.host, '.de-figure-image');
      pointer(handle, 'pointerdown', 0, 0);
      pointer(handle, 'pointermove', 5000, 0); // far beyond 31680 twips
      pointer(handle, 'pointerup', 5000, 0);
      expect(r.attrs('figure')).toEqual({ width: 1500, height: 750 });
      expect(r.host.querySelector<HTMLElement>('.de-figure-image')!.style.inlineSize).toBe('100px');
    } finally {
      r.done();
    }
  });

  it('a cancelled drag stores nothing', async () => {
    const r = rig();
    try {
      await settle();
      const handle = handleOf(r.host, '.de-figure-image');
      pointer(handle, 'pointerdown', 100, 100);
      pointer(handle, 'pointermove', 160, 100);
      pointer(handle, 'pointercancel', 160, 100);
      expect(r.attrs('figure')).toEqual({ width: 1500, height: 750 });
      expect(r.host.querySelector<HTMLElement>('.de-figure-image')!.style.inlineSize).toBe('100px');
    } finally {
      r.done();
    }
  });

  it('the arrow keys change the size in steps of 10 pixels, and Shift unlocks the ratio', async () => {
    const r = rig();
    try {
      await settle();
      let handle = handleOf(r.host, '.de-figure-image');
      press(handle, 'ArrowRight');
      expect(r.attrs('figure')).toEqual({ width: 1650, height: 825 });
      await settle();
      handle = handleOf(r.host, '.de-figure-image');
      press(handle, 'ArrowLeft', true); // the width alone
      expect(r.attrs('figure')).toEqual({ width: 1500, height: 825 });
      await settle();
      handle = handleOf(r.host, '.de-figure-image');
      press(handle, 'ArrowUp', true); // the height alone
      expect(r.attrs('figure')).toEqual({ width: 1500, height: 975 });
      expect(handle.getAttribute('aria-valuenow')).toBe('1500');
    } finally {
      r.done();
    }
  });

  it('an inline image resizes the same way', async () => {
    const r = rig();
    try {
      await settle();
      const handle = handleOf(r.host, '.de-image');
      pointer(handle, 'pointerdown', 10, 10);
      pointer(handle, 'pointermove', 30, 10); // 20 pixels: 300 twips
      pointer(handle, 'pointerup', 30, 10);
      expect(r.attrs('image')).toEqual({ width: 1800, height: 1800 });
    } finally {
      r.done();
    }
  });

  it('a view that is not editable changes nothing', async () => {
    const r = rig(true);
    try {
      await settle();
      const handle = handleOf(r.host, '.de-figure-image');
      pointer(handle, 'pointerdown', 100, 100);
      pointer(handle, 'pointermove', 140, 100);
      pointer(handle, 'pointerup', 140, 100);
      press(handle, 'ArrowRight');
      expect(r.attrs('figure')).toEqual({ width: 1500, height: 750 });
    } finally {
      r.done();
    }
  });
});
