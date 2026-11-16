/**
 * The control of a form field on the body web view (FRW-004 criterion 1, lane w4): a native control
 * named by the field's label, marked `aria-invalid` with a message it is described by while its
 * entry is outside the limits, and reported by the core's `validateFields()`.
 *
 * Runs through `pnpm vitest run --project browser <this file>`; skipped in Node.js, which has no DOM.
 */
import { describe, expect, it } from 'vitest';
import { FIELD_IDS, fieldsDocument, participantAccess } from '../../test/frw-fields-fixture.ts';
import { EditorCore } from './web.ts';

const isBrowser = typeof document !== 'undefined';

function mounted(config: Partial<ConstructorParameters<typeof EditorCore>[0]> = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const core = new EditorCore({
    doc: fieldsDocument(),
    schedule: (run) => queueMicrotask(run),
    ...config,
  });
  const unmount = core.mountBody(host);
  const control = (id: string): HTMLInputElement => {
    const el = host.querySelector<HTMLInputElement>(`[data-field="${id}"] .de-form-field-control`);
    if (!el) throw new Error(`no control for the field ${id}`);
    return el;
  };
  /** Types `text` into a control: the `input` event of typing, then the `change` of leaving it. */
  const enter = (id: string, text: string, commit = true): HTMLInputElement => {
    const el = control(id);
    el.focus();
    el.value = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    if (commit) el.dispatchEvent(new Event('change', { bubbles: true }));
    return el;
  };
  /** The message a control is described by, or null. */
  const message = (el: HTMLElement): HTMLElement | null => {
    const id = el.getAttribute('aria-describedby');
    return id === null ? null : host.querySelector<HTMLElement>(`#${id}`);
  };
  return {
    core,
    host,
    control,
    enter,
    message,
    cleanup() {
      unmount();
      core.destroy();
      host.remove();
    },
  };
}

describe.skipIf(!isBrowser)(
  'the control of a number field with bounds (FRW-004 criterion 1)',
  () => {
    it('is a native control named by the label', () => {
      const m = mounted();
      try {
        const el = m.control(FIELD_IDS.amount);
        expect(el.tagName).toBe('INPUT');
        expect(el.getAttribute('aria-label')).toBe('Amount');
        expect(el.hasAttribute('aria-invalid')).toBe(false);
        expect(m.control(FIELD_IDS.email).getAttribute('aria-required')).toBe('true');
        expect(el.hasAttribute('aria-required')).toBe(false);
      } finally {
        m.cleanup();
      }
    });

    it.each([
      ['-1', 'enter 0 or more'],
      ['1000000.01', 'enter 1000000 or less'],
    ])('marks %s invalid, shows the message, and validateFields() reports it', (entry, text) => {
      const m = mounted();
      try {
        // While typing, before the entry is submitted.
        const el = m.enter(FIELD_IDS.amount, entry, false);
        expect(el.getAttribute('aria-invalid')).toBe('true');
        const shown = m.message(el);
        expect(shown?.textContent).toBe(text);
        expect(shown?.hidden).toBe(false);
        expect(shown?.getRootNode()).toBe(el.getRootNode());
        expect(shown?.getBoundingClientRect().width).toBeGreaterThan(0);

        // Once submitted: still invalid, the entry is kept, and the core reports the field.
        el.dispatchEvent(new Event('change', { bubbles: true }));
        expect(el.getAttribute('aria-invalid')).toBe('true');
        expect(el.value).toBe(entry);
        expect(m.message(el)?.textContent).toBe(text);
        expect(m.core.validateFields().map((r) => r.key)).toContain('tenant.amount');
      } finally {
        m.cleanup();
      }
    });

    it.each(['0', '1000000'])('takes %s as valid', (entry) => {
      const m = mounted();
      try {
        // An invalid entry first, so that the valid one has a mark to clear.
        m.enter(FIELD_IDS.amount, '-1');
        const el = m.enter(FIELD_IDS.amount, entry);
        expect(el.hasAttribute('aria-invalid')).toBe(false);
        expect(el.hasAttribute('aria-describedby')).toBe(false);
        expect(
          m.host.querySelector(`[data-field="${FIELD_IDS.amount}"] [role="alert"]`),
        ).toHaveProperty('hidden', true);
        expect(m.core.fieldEntry(FIELD_IDS.amount)?.stored).toBe(entry);
        expect(m.core.validateFields().map((r) => r.key)).not.toContain('tenant.amount');
      } finally {
        m.cleanup();
      }
    });

    it('a text field outside its length limits is marked the same way', () => {
      const m = mounted();
      try {
        const el = m.enter(FIELD_IDS.name, 'Bartholomew');
        expect(el.getAttribute('aria-invalid')).toBe('true');
        expect(m.message(el)?.textContent).toBe('enter at most 5 characters');
        expect(m.enter(FIELD_IDS.name, 'Ada').hasAttribute('aria-invalid')).toBe(false);
      } finally {
        m.cleanup();
      }
    });

    it('in the fill mode a participant types into their own field and not into another role’s', () => {
      const m = mounted({ access: participantAccess(['role_tenant']), mode: 'fill' });
      try {
        expect(m.control(FIELD_IDS.amount).readOnly).toBe(false);
        expect(m.control(FIELD_IDS.landlord).readOnly).toBe(true);
        m.enter(FIELD_IDS.amount, '12.50');
        expect(m.core.fieldEntry(FIELD_IDS.amount)?.stored).toBe('12.50');
        m.enter(FIELD_IDS.landlord, 'Grace');
        expect(m.core.fieldEntry(FIELD_IDS.landlord)?.stored).toBeNull();
        expect(m.control(FIELD_IDS.landlord).value).toBe('');
      } finally {
        m.cleanup();
      }
    });
  },
);
