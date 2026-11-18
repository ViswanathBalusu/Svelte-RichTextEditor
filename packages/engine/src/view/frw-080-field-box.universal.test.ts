/**
 * The box of a form field on the body web view (FRW-080 criteria 1 to 4; lane w4): the field is as
 * wide as its `width`, or as the default width of its kind, whatever the control holds; entering a
 * value, however long, moves no field and no line around it; a text field with a `maxLength` refuses
 * characters beyond it, and a paste that is too long is cut at the limit and announced.
 *
 * Runs through `pnpm vitest run --project browser <this file>` in Chromium, Firefox and WebKit; the
 * suite is skipped in Node.js, which has no DOM. `vitest/browser` throws outside Browser Mode, so
 * `userEvent` is loaded only when a DOM exists.
 */
import { FIELD_DEFAULT_WIDTH } from '@docedit/model/definition';
import type { userEvent as BrowserUserEvent } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { KIND_IDS, kindsDocument } from '../../test/frw-079-fixture.ts';
import { EditorCore } from './web.ts';

const isBrowser = typeof document !== 'undefined';
const userEvent: typeof BrowserUserEvent | undefined = isBrowser
  ? (await import('vitest/browser')).userEvent
  : undefined;

/** CSS pixels in one twip: a twip is 1/20 pt and a point is 96/72 CSS pixels. */
const PX_PER_TWIP = 96 / 72 / 20;

type J = Record<string, unknown>;

/** The kinds document, with the `width` of the fields in `widths` (twips) set. */
function documentWith(widths: Readonly<Record<string, number>>): ReturnType<typeof kindsDocument> {
  const doc = kindsDocument();
  const walk = (n: unknown): void => {
    if (typeof n !== 'object' || n === null) return;
    const node = n as J;
    const attrs = node['attrs'] as J | undefined;
    if (node['type'] === 'form_field' && attrs && typeof attrs['id'] === 'string') {
      const width = widths[attrs['id']];
      if (width !== undefined) attrs['width'] = width;
    }
    for (const child of (node['content'] as unknown[] | undefined) ?? []) walk(child);
  };
  walk((doc as unknown as J)['doc']);
  return doc;
}

function mounted(widths: Readonly<Record<string, number>> = {}, hostWidth = 340) {
  const host = document.createElement('div');
  // Narrow, so that the fields wrap onto several lines and a change of width would move one.
  host.style.width = `${hostWidth}px`;
  document.body.append(host);
  const core = new EditorCore({
    doc: documentWith(widths),
    schedule: (run) => queueMicrotask(run),
  });
  const unmount = core.mountBody(host);
  const control = <T extends HTMLElement = HTMLInputElement>(id: string): T => {
    const el = host.querySelector<T>(`[data-field="${id}"] .de-form-field-control`);
    if (!el) throw new Error(`no control for the field ${id}`);
    return el;
  };
  const box = (id: string): HTMLElement => {
    const el = host.querySelector<HTMLElement>(`[data-field="${id}"]`);
    if (!el) throw new Error(`no field ${id}`);
    return el;
  };
  /** Where every field is, and how tall the paragraph that holds them is. */
  const geometry = () => {
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    return {
      fields: [...host.querySelectorAll('.de-form-field')].map(rect),
      paragraph: rect(host.querySelector('.de-form-field')!.closest('p')!),
    };
  };
  return {
    core,
    host,
    control,
    box,
    geometry,
    user: userEvent!,
    stored: (id: string) => core.fieldEntry(id)?.stored,
    cleanup() {
      unmount();
      core.destroy();
      host.remove();
    },
  };
}

/** A paste event carrying `text`, as the browser sends it when a person pastes into a control. */
function paste(el: HTMLElement, text: string): ClipboardEvent {
  const data = new DataTransfer();
  data.setData('text/plain', text);
  const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
  // Firefox ignores `clipboardData` in the constructor of an event a page makes, so it is set here.
  Object.defineProperty(event, 'clipboardData', { value: data });
  el.dispatchEvent(event);
  return event;
}

const LONG = 'Mrs Alexandria Tenant-Hyphenated Longname, of the Lower Mill, Upper Lane'.repeat(2);

describe.skipIf(!isBrowser)('the box of a form field (FRW-080 criteria 1 to 3)', () => {
  it('is exactly the field’s width, whatever the control holds', async () => {
    const twips = { [KIND_IDS.number]: 1500, [KIND_IDS.text]: 2200 };
    const m = mounted(twips);
    try {
      for (const [id, width] of Object.entries(twips))
        expect(m.box(id).getBoundingClientRect().width).toBeCloseTo(width * PX_PER_TWIP, 0);
      // The control fills the box and does not stick out of it.
      const number = m.control(KIND_IDS.number);
      expect(number.getBoundingClientRect().width).toBeCloseTo(
        m.box(KIND_IDS.number).getBoundingClientRect().width,
        0,
      );
      await m.user.click(number);
      await m.user.keyboard('1234567890123456789012345678901234567890');
      expect(m.box(KIND_IDS.number).getBoundingClientRect().width).toBeCloseTo(
        1500 * PX_PER_TWIP,
        0,
      );
    } finally {
      m.cleanup();
    }
  });

  it('keeps every field and line where it is when a long value is entered (criterion 2)', async () => {
    const m = mounted({ [KIND_IDS.number]: 1500 });
    try {
      const before = m.geometry();
      // A line of text with no wrapping point, and a problem message: neither may move anything.
      await m.user.click(m.control(KIND_IDS.number));
      await m.user.keyboard(LONG.replaceAll(' ', ''));
      expect(m.control(KIND_IDS.number).getAttribute('aria-invalid')).toBe('true');
      expect(m.geometry()).toEqual(before);
      await m.user.tab();
      expect(m.geometry()).toEqual(before);
      // The choice field takes a value too.
      await m.user.selectOptions(m.control<HTMLSelectElement>(KIND_IDS.choice), 'opt_married');
      expect(m.geometry()).toEqual(before);
    } finally {
      m.cleanup();
    }
  });

  it('gives a field with no width the default width of its kind (criterion 3)', () => {
    const m = mounted();
    try {
      const kinds: Array<[string, keyof typeof FIELD_DEFAULT_WIDTH]> = [
        [KIND_IDS.text, 'text'],
        [KIND_IDS.number, 'number'],
        [KIND_IDS.date, 'date'],
        [KIND_IDS.checkbox, 'checkbox'],
        [KIND_IDS.choice, 'choice'],
      ];
      for (const [id, kind] of kinds)
        expect(m.box(id).getBoundingClientRect().width, kind).toBeCloseTo(
          FIELD_DEFAULT_WIDTH[kind] * PX_PER_TWIP,
          0,
        );
    } finally {
      m.cleanup();
    }
  });

  it('is sensitive to the width, so the comparison above would see a box that moved things (control)', () => {
    const narrow = mounted({ [KIND_IDS.number]: 720 });
    const wide = mounted({ [KIND_IDS.number]: 5400 });
    try {
      expect(wide.geometry()).not.toEqual(narrow.geometry());
    } finally {
      narrow.cleanup();
      wide.cleanup();
    }
  });
});

describe.skipIf(!isBrowser)('the length limit of a text field (FRW-080 criterion 4)', () => {
  it('refuses typed characters beyond the limit', async () => {
    const m = mounted();
    try {
      const el = m.control(KIND_IDS.text);
      await m.user.click(el);
      await m.user.keyboard('Bartholomew');
      expect(el.value).toBe('Bartholo');
    } finally {
      m.cleanup();
    }
  });

  it('cuts a paste that is too long at the limit, and announces it', async () => {
    const m = mounted();
    try {
      const el = m.control(KIND_IDS.text);
      const notice = el.parentElement!.querySelector<HTMLElement>('[role="status"]')!;
      expect(notice.hidden).toBe(true);
      await m.user.click(el);
      const event = paste(el, 'Bartholomew Longname');
      expect(event.defaultPrevented).toBe(true);
      expect(el.value).toBe('Bartholo');
      expect(notice.hidden).toBe(false);
      expect(notice.textContent).toBe('The pasted text was cut at 8 characters.');
      // The notice goes when the person goes on typing, and does not come back.
      await m.user.keyboard('{Backspace}');
      expect(notice.hidden).toBe(true);
      await m.user.tab();
      expect(m.stored(KIND_IDS.text)).toBe('Bartholo'.slice(0, 7));
    } finally {
      m.cleanup();
    }
  });

  it('counts the limit in code points, and replaces a selection', async () => {
    const m = mounted();
    try {
      const el = m.control(KIND_IDS.text);
      await m.user.click(el);
      paste(el, '😀'.repeat(12));
      expect([...el.value]).toHaveLength(8);
      expect(el.parentElement!.querySelector<HTMLElement>('[role="status"]')!.hidden).toBe(false);

      // A selection that is replaced makes room for the paste.
      el.value = 'abcdefgh';
      el.setSelectionRange(2, 6);
      paste(el, 'WXYZ');
      expect(el.value).toBe('abWXYZgh');
    } finally {
      m.cleanup();
    }
  });

  it('keeps a paste that fits, with no notice', async () => {
    const m = mounted();
    try {
      const el = m.control(KIND_IDS.text);
      await m.user.click(el);
      paste(el, 'Ada');
      expect(el.value).toBe('Ada');
      expect(el.parentElement!.querySelector<HTMLElement>('[role="status"]')!.hidden).toBe(true);
      await m.user.tab();
      expect(m.stored(KIND_IDS.text)).toBe('Ada');
    } finally {
      m.cleanup();
    }
  });

  it('does not touch a paste into a field with no limit (control)', async () => {
    const m = mounted();
    try {
      const el = m.control(KIND_IDS.number);
      await m.user.click(el);
      const event = paste(el, '123');
      // The browser's own paste handles it: the event is not cancelled by the view.
      expect(event.defaultPrevented).toBe(false);
    } finally {
      m.cleanup();
    }
  });
});
