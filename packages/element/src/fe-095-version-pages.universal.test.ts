/* eslint-disable no-restricted-syntax -- the events here are the browser's own pointer, key and input events, made to check that the read-only pages ignore them; none is a component event (FE-022) */
/**
 * FE-095 criterion 2 (an old version painted read-only) and the read-only mode of the page view
 * behind criterion 1: the version of a given `seq` is drawn as the layout engine's pages, with no
 * input bridge, no caret and no way to change it. Runs in Chromium, Firefox and WebKit through
 * `pnpm test:browsers`; skipped in Node.js, which has no canvas.
 */
import { VersionView, type VersionInput } from '@docedit/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { pagedHistoryVersion } from './page-view/version-pages.ts';

const hasDom = typeof document !== 'undefined' && typeof HTMLCanvasElement !== 'undefined';

function envelope(texts: string[]): VersionInput['content'] {
  return {
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            {
              type: 'settings',
              attrs: { lang: 'en-GB', defaultTabStop: 720, defaultParagraphStyle: 'Normal' },
            },
            {
              type: 'style_def',
              attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
            },
            {
              type: 'page_setup',
              attrs: {
                id: 'ps1',
                width: 11906,
                height: 16838,
                marginTop: 1440,
                marginRight: 1440,
                marginBottom: 1440,
                marginLeft: 1440,
              },
            },
          ],
        },
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: texts.map((text, i) => ({
            type: 'paragraph',
            attrs: { id: `p${String(i).padStart(7, '0')}`, style: 'Normal' },
            content: [{ type: 'text', text }],
          })),
        },
      ],
    },
  } as never;
}

const SEVEN = ['Seven: the first paragraph of the old text.', 'Seven: the second paragraph.'];
const NINE = ['Nine: a later wording of the first paragraph.', 'Nine: the second paragraph.'];

let parent: HTMLElement | null = null;
afterEach(() => {
  parent?.remove();
  parent = null;
});

function open(seq: number, texts: string[]) {
  const version = VersionView.open({
    seq,
    content: envelope(texts),
    time: '2026-11-01T10:00:00Z',
    name: `Version ${seq}`,
  });
  parent = document.createElement('div');
  parent.style.cssText = 'width:900px;height:600px;position:relative;';
  document.body.append(parent);
  const errors: unknown[] = [];
  const paged = pagedHistoryVersion(version, {
    label: `Version ${seq}`,
    frame: (run) => run(),
    onError: (e) => errors.push(e),
  });
  const unmount = paged.mount(parent);
  return { version, paged, unmount, errors, target: parent };
}

describe.skipIf(!hasDom)('an old version painted as read-only pages (FE-095)', () => {
  it('paints the text of the version at the seq it was asked for, and not another', () => {
    const seven = open(7, SEVEN);
    expect(seven.paged.seq).toBe(7);
    expect(seven.target.querySelectorAll('.de-page').length).toBeGreaterThan(0);
    const text = seven.target.textContent ?? '';
    expect(text).toContain('Seven: the first paragraph of the old text.');
    expect(text).not.toContain('Nine');
    seven.paged.close();
    seven.target.replaceChildren();
    const nine = open(9, NINE);
    expect(nine.target.textContent).toContain('Nine: a later wording');
    expect(nine.target.textContent).not.toContain('Seven');
    nine.paged.close();
  });

  it('has no input bridge, no editable element, no caret, and says it is read-only', () => {
    const s = open(7, SEVEN);
    const root = s.target.querySelector<HTMLElement>('.de-page-view')!;
    expect(root.dataset['readonly']).toBe('true');
    expect(root.getAttribute('role')).toBe('document');
    expect(s.target.querySelector('textarea, input, [contenteditable]')).toBeNull();
    expect(s.target.querySelector('.de-page-bridge')).toBeNull();
    expect(s.target.querySelector('.de-caret')).toBeNull();
    expect(s.errors).toEqual([]);
    s.paged.close();
  });

  it('takes no key and no pointer: the version is the same after both', () => {
    const s = open(7, SEVEN);
    const before = JSON.stringify(s.version.content());
    const line = s.target.querySelector<HTMLElement>('.de-line')!;
    for (const type of ['pointerdown', 'pointerup'])
      line.dispatchEvent(
        new PointerEvent(type, { bubbles: true, button: 0, clientX: 120, clientY: 120 }),
      );
    for (const key of ['a', 'Backspace', 'Enter'])
      line.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    line.dispatchEvent(
      new InputEvent('beforeinput', { data: 'x', inputType: 'insertText', bubbles: true }),
    );
    expect(JSON.stringify(s.version.content())).toBe(before);
    expect(s.target.querySelector('.de-caret, .de-selection')).toBeNull();
    s.paged.close();
  });

  it('lets the browser select painted text across lines, in document order', () => {
    const s = open(7, SEVEN);
    const lines = [...s.target.querySelectorAll<HTMLElement>('.de-line')];
    expect(lines.length).toBeGreaterThan(1);
    const first = lines[0]!.firstChild!;
    const last = lines[lines.length - 1]!;
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEndAfter(last);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const selected = selection.toString().replace(/\s+/g, ' ');
    expect(selected.indexOf('Seven: the first')).toBeGreaterThanOrEqual(0);
    expect(selected.indexOf('Seven: the first')).toBeLessThan(
      selected.indexOf('the second paragraph'),
    );
    selection.removeAllRanges();
    s.paged.close();
  });

  it('removes the pages when the pane unmounts it', () => {
    const s = open(7, SEVEN);
    s.unmount();
    expect(s.target.querySelector('.de-page-view')).toBeNull();
    s.paged.close();
  });
});
