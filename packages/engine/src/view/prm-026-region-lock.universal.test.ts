/**
 * The drawing of the regions the user cannot edit in the body view (PRM-026 criteria 1 and 4;
 * PRM-006 criterion 5; lane w9). A locked region's element takes the class the stylesheet shades and
 * is described by its lock indicator; the indicator is a note at the start of the region with an
 * icon, a short text label and the sentence that says who can edit the region. A region the user may
 * edit has neither. A new access, and new words, are drawn at once in the same view: the region's
 * element is not replaced, the selection does not move and the document does not change.
 *
 * Runs in real browser engines through `pnpm vitest run --project browser <this file>` (Chromium,
 * Firefox and WebKit); in Node.js there is no DOM, so the suite is skipped there. The colours are the
 * element stylesheet's and are tested with it (packages/element/e2e/prm-026-lock-indicator.spec.ts).
 */
import type { Access } from '@docedit/protocol';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it, vi } from 'vitest';
import { IDS, contractDocument } from '../../test/fixtures.ts';
import { internals } from '../testing.ts';
import { REGION_LOCKED_CLASS, REGION_LOCK_CLASS, regionLockElementId } from './region-lock-view.ts';
import { EditorCore } from './web.ts';

const isBrowser = typeof document !== 'undefined';

const OPEN = `region:${IDS.open}`;
const LOCKED = `region:${IDS.locked}`;
const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;
const READ = ['view', 'comment'] as const;

function access(scopes: Record<string, readonly string[]>, rev = 1): Access {
  return {
    rev,
    asOfSeq: 0,
    docRole: 'editor',
    caps: [...EDIT],
    scopes: { doc: ['view'], body: [...EDIT], defs: ['view'], ...scopes } as Access['scopes'],
    leases: {},
    fill: null,
    restrictions: [],
  };
}

/** The element of the region with `title`, by its accessible name. */
function region(surface: HTMLElement, title: string): HTMLElement {
  const el = surface.querySelector<HTMLElement>(`.de-region[data-title="${title}"]`);
  if (!el) throw new Error(`no region ${title}`);
  return el;
}

describe.skipIf(!isBrowser)('locked regions in the body view (PRM-026)', () => {
  it('shades a region without edit and gives it a lock indicator; an editable one has neither', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const core = new EditorCore({
      doc: contractDocument(),
      access: access({ [OPEN]: [...EDIT], [LOCKED]: [...READ] }),
      schedule: (run) => queueMicrotask(run),
    });
    const stored = JSON.stringify(core.getContent().doc);
    core.setRegionLabels({
      [IDS.locked]: { indicator: 'Read-only', description: 'It can be edited by Ada Lovelace.' },
    });
    const unmount = core.mountBody(host);
    try {
      const surface = host.querySelector<HTMLElement>('.de-editing-surface') ?? host;
      const locked = region(surface, 'Locked');
      const open = region(surface, 'Open');

      expect(locked.classList.contains(REGION_LOCKED_CLASS)).toBe(true);
      expect(locked.getAttribute('data-locked')).toBe('true');
      const note = locked.querySelector<HTMLElement>(`.${REGION_LOCK_CLASS}`);
      if (!note) throw new Error('the locked region has no lock indicator');
      // The indicator: a note that is not editable, with an icon hidden from assistive technology,
      // a text label and the sentence that says who can edit the region.
      expect(note.getAttribute('role')).toBe('note');
      expect(note.getAttribute('contenteditable')).toBe('false');
      expect(note.dataset['region']).toBe(IDS.locked);
      const icon = note.querySelector('.de-region-lock-icon');
      expect(icon?.getAttribute('aria-hidden')).toBe('true');
      expect(icon?.textContent).toBe('');
      expect(note.querySelector('.de-region-lock-label')?.textContent).toBe('Read-only');
      expect(note.querySelector('.de-region-lock-description')?.textContent).toBe(
        'It can be edited by Ada Lovelace.',
      );
      expect(note.textContent).toBe('Read-only It can be edited by Ada Lovelace.');
      // No picture and no drawing element: the icon is the stylesheet's (FE-067).
      expect(note.querySelector('svg, img')).toBeNull();
      // The region is described by its indicator, which lies inside it, before its first block.
      expect(note.id).toBe(regionLockElementId(IDS.locked));
      expect(locked.getAttribute('aria-describedby')).toBe(note.id);
      expect(note.nextElementSibling?.textContent).toBe('Restricted text');
      expect(note.closest('p')).toBeNull();

      // A region the user may edit shows neither the class nor an indicator.
      expect(open.classList.contains(REGION_LOCKED_CLASS)).toBe(false);
      expect(open.hasAttribute('data-locked')).toBe(false);
      expect(open.hasAttribute('aria-describedby')).toBe(false);
      expect(open.querySelector(`.${REGION_LOCK_CLASS}`)).toBeNull();
      expect(surface.querySelectorAll(`.${REGION_LOCK_CLASS}`)).toHaveLength(1);

      // The indicator is not document content: the document is as it was, and holds no such words.
      expect(JSON.stringify(core.getContent().doc)).toBe(stored);
      expect(stored).not.toContain('Ada Lovelace');
    } finally {
      unmount();
      core.destroy();
      host.remove();
    }
  });

  it('follows a new access and new words in the same view, without moving the selection', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const core = new EditorCore({
      doc: contractDocument(),
      access: access({ [OPEN]: [...EDIT], [LOCKED]: [...READ] }),
      schedule: (run) => queueMicrotask(run),
    });
    const unmount = core.mountBody(host);
    try {
      const surface = host.querySelector<HTMLElement>('.de-editing-surface') ?? host;
      const i = internals(core);
      // A selection inside the open region, which is about to be locked.
      let openPara = -1;
      i.state.doc.descendants((node, pos) => {
        if (node.attrs['id'] === IDS.openPara) openPara = pos;
        return openPara < 0;
      });
      i.dispatch(
        i.state.tr.setSelection(TextSelection.create(i.state.doc, openPara + 2, openPara + 5)),
      );
      const selection = { anchor: i.state.selection.anchor, head: i.state.selection.head };
      const doc = i.state.doc;
      const lockedEl = region(surface, 'Locked');
      const openEl = region(surface, 'Open');
      expect(surface.querySelectorAll(`.${REGION_LOCK_CLASS}`)).toHaveLength(1);
      // Before the shell has set its words, the indicator carries the core's own.
      expect(lockedEl.querySelector('.de-region-lock-label')?.textContent).toBe('Read-only');
      expect(lockedEl.querySelector('.de-region-lock-description')).toBeNull();

      // perm.changed: the grant moves from one region to the other.
      core.setAccess(access({ [OPEN]: [...READ], [LOCKED]: [...EDIT] }, 2));
      await vi.waitFor(() => {
        expect(region(surface, 'Open').classList.contains(REGION_LOCKED_CLASS)).toBe(true);
        expect(region(surface, 'Locked').classList.contains(REGION_LOCKED_CLASS)).toBe(false);
      });
      expect(region(surface, 'Locked').querySelector(`.${REGION_LOCK_CLASS}`)).toBeNull();
      expect(region(surface, 'Open').querySelector(`.${REGION_LOCK_CLASS}`)).not.toBeNull();
      // The same elements, the same document and the same selection: nothing was reloaded.
      expect(region(surface, 'Locked')).toBe(lockedEl);
      expect(region(surface, 'Open')).toBe(openEl);
      expect(internals(core).state.doc).toBe(doc);
      expect({
        anchor: internals(core).state.selection.anchor,
        head: internals(core).state.selection.head,
      }).toEqual(selection);

      // The shell's words arrive after the access: the indicator is drawn again with them.
      core.setRegionLabels({
        [IDS.open]: { indicator: 'Read-only', description: 'Grace Hopper is editing it.' },
      });
      await vi.waitFor(() =>
        expect(
          region(surface, 'Open').querySelector('.de-region-lock-description')?.textContent,
        ).toBe('Grace Hopper is editing it.'),
      );
      expect(region(surface, 'Open')).toBe(openEl);
      expect({
        anchor: internals(core).state.selection.anchor,
        head: internals(core).state.selection.head,
      }).toEqual(selection);

      // An access that lets the user edit every region removes every indicator.
      core.setAccess(access({ [OPEN]: [...EDIT], [LOCKED]: [...EDIT] }, 3));
      await vi.waitFor(() =>
        expect(surface.querySelectorAll(`.${REGION_LOCK_CLASS}`)).toHaveLength(0),
      );
      expect(surface.querySelectorAll(`.${REGION_LOCKED_CLASS}`)).toHaveLength(0);
      expect(region(surface, 'Open').hasAttribute('aria-describedby')).toBe(false);
    } finally {
      unmount();
      core.destroy();
      host.remove();
    }
  });

  it('marks a region the access does not list yet, with the words for it', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const core = new EditorCore({
      doc: contractDocument(),
      access: access({ [LOCKED]: [...EDIT] }),
      schedule: (run) => queueMicrotask(run),
    });
    core.setRegionLabels(
      {},
      {
        locked: { indicator: 'Read-only', description: '' },
        unlisted: { indicator: 'Read-only', description: 'Its permissions have not arrived.' },
      },
    );
    const unmount = core.mountBody(host);
    try {
      const surface = host.querySelector<HTMLElement>('.de-editing-surface') ?? host;
      const open = region(surface, 'Open');
      expect(open.getAttribute('data-locked')).toBe('unlisted');
      const note = open.querySelector<HTMLElement>(`.${REGION_LOCK_CLASS}`);
      expect(note?.dataset['unlisted']).toBe('true');
      expect(note?.querySelector('.de-region-lock-description')?.textContent).toBe(
        'Its permissions have not arrived.',
      );
    } finally {
      unmount();
      core.destroy();
      host.remove();
    }
  });
});
