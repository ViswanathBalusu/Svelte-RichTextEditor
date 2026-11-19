/**
 * An old version drawn in a real browser (HIS-010 criteria 1 and 3): the view is read-only (not
 * editable, and a change dispatched to it is refused), it draws the pictures the old content
 * references through the lookup of the live editor, asking for the asset identifiers the version
 * holds (content-addressed objects that never change), and it is independent of the live view.
 *
 * Skipped in Node.js (no DOM).
 */
import { describe, expect, it } from 'vitest';
import { ownerAccess } from '../../test/fixtures.ts';
import { COMMENT_RANGE_CLASS } from '../comment-decorations.ts';
import type { AssetImageLookup } from '../image-source.ts';
import { spikeDocument } from '../spike-document.ts';
import { VersionView } from './version-web.ts';
import { EditorCore, viewsOf } from './web.ts';

const isBrowser = typeof document !== 'undefined' && typeof DataTransfer !== 'undefined';
const tick = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The document with one picture of `asset` in it, made by the live editor. */
function withPicture(asset: string) {
  const core = new EditorCore({
    doc: spikeDocument(),
    access: ownerAccess(),
    schedule: (run) => queueMicrotask(run),
  });
  const host = document.createElement('div');
  document.body.append(host);
  const unmount = core.mountBody(host);
  try {
    const view = viewsOf(core).view;
    if (!view) throw new Error('the body view is not mounted');
    const type = view.state.schema.nodes['image'];
    if (!type) throw new Error('the schema has no image node');
    let at = -1;
    view.state.doc.descendants((n, pos) => {
      if (at >= 0) return false;
      if (n.isText && n.text?.includes('Alpha')) {
        at = pos;
        return false;
      }
      return true;
    });
    if (at < 0) throw new Error('no body text found');
    view.dispatch(
      view.state.tr.insert(at, type.create({ asset, width: 100, height: 100, alt: 'Chart' })),
    );
    return core.getContent();
  } finally {
    unmount();
    core.destroy();
    host.remove();
  }
}

describe.skipIf(!isBrowser)('an old version in the web view (HIS-010)', () => {
  it('is not editable and refuses a change dispatched to it (criterion 1)', async () => {
    const view = VersionView.open(
      { seq: 3, content: spikeDocument(), time: '2026-11-01T10:00:00Z' },
      { schedule: (run) => queueMicrotask(run) },
    );
    const host = document.createElement('div');
    document.body.append(host);
    const unmount = view.mount(host);
    try {
      const body = host.querySelector<HTMLElement>('[contenteditable]');
      expect(body?.getAttribute('contenteditable')).toBe('false');
      const before = JSON.stringify(view.content());
      expect(view.run('bold')).toBe(false);
      expect(JSON.stringify(view.content())).toBe(before);
      expect(view.connection()).toBe('detached');
      expect(view.unsent()).toBe(0);
    } finally {
      unmount();
      view.destroy();
      host.remove();
    }
  });

  it('draws the picture the old content references, by the asset identifier it holds (criterion 3)', async () => {
    const asked: string[] = [];
    const lookup: AssetImageLookup = (asset) => {
      asked.push(asset);
      return Promise.resolve({
        url: `https://assets.example/${asset}.png`,
        contentType: 'image/png',
      });
    };
    const old = withPicture('sha256-old');
    const view = VersionView.open(
      { seq: 2, content: old, time: '2026-11-01T10:00:00Z' },
      { schedule: (run) => queueMicrotask(run), assetImage: lookup },
    );
    const host = document.createElement('div');
    document.body.append(host);
    const unmount = view.mount(host);
    try {
      await tick();
      const imgs = Array.from(host.querySelectorAll<HTMLImageElement>('.de-image img'));
      expect(imgs.map((i) => i.src)).toEqual(['https://assets.example/sha256-old.png']);
      expect(asked).toEqual(['sha256-old']);

      // The live editor now holds another picture; the old version still shows its own.
      const live = withPicture('sha256-new');
      expect(JSON.stringify(live)).toContain('sha256-new');
      expect(JSON.stringify(view.content())).toContain('sha256-old');
      expect(JSON.stringify(view.content())).not.toContain('sha256-new');
    } finally {
      unmount();
      view.destroy();
      host.remove();
    }
  });

  it('draws the comment ranges of the version in their positions of that time (HIS-010 criterion 4)', async () => {
    // The position of the text in the document, found with a state of its own.
    const probe = new EditorCore({
      doc: spikeDocument(),
      access: ownerAccess(),
      schedule: (run) => queueMicrotask(run),
    });
    const probeHost = document.createElement('div');
    document.body.append(probeHost);
    const unmountProbe = probe.mountBody(probeHost);
    let from = -1;
    try {
      viewsOf(probe).view!.state.doc.descendants((n, pos) => {
        if (from < 0 && n.isText && n.text?.includes('Alpha')) from = pos;
        return from < 0;
      });
    } finally {
      unmountProbe();
      probe.destroy();
      probeHost.remove();
    }
    expect(from).toBeGreaterThan(0);
    const view = VersionView.open(
      {
        seq: 4,
        content: spikeDocument(),
        time: '2026-11-01T10:00:00Z',
        comments: [{ id: 'thread-then', from, to: from + 5 }],
      },
      { schedule: (run) => queueMicrotask(run) },
    );
    const host = document.createElement('div');
    document.body.append(host);
    const unmount = view.mount(host);
    try {
      await tick();
      const marked = Array.from(host.querySelectorAll(`.${COMMENT_RANGE_CLASS}`));
      expect(marked).toHaveLength(1);
      expect(marked[0]!.textContent).toBe('Alpha');
      // Still read-only, and still no channel.
      expect(host.querySelector('[contenteditable]')?.getAttribute('contenteditable')).toBe(
        'false',
      );
      expect(view.connection()).toBe('detached');
    } finally {
      unmount();
      view.destroy();
      host.remove();
    }
  });
  it('reports the blocks the user selected, for "who wrote this" (HIS-015)', async () => {
    const view = VersionView.open(
      { seq: 2, content: spikeDocument(), time: '2026-11-01T10:00:00Z' },
      { schedule: (run) => queueMicrotask(run) },
    );
    const host = document.createElement('div');
    document.body.append(host);
    const unmount = view.mount(host);
    try {
      expect(view.selectedBlocks()).toEqual([]);
      // A real selection over the text of the first body paragraph, as a reader makes it.
      const p = [...host.querySelectorAll('p')].find((el) => el.textContent?.includes('Alpha'));
      expect(p).toBeTruthy();
      const text = p!.firstChild!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 3);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await tick(100);
      const ids = view.selectedBlocks();
      expect(ids.length).toBe(1);
      expect(typeof ids[0]).toBe('string');
    } finally {
      unmount();
      view.destroy();
      host.remove();
    }
  });
});
