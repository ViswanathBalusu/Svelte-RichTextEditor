/**
 * FRW-018 criterion 4 on the body web view: the control of a text field whose entry does not match
 * the field's `validation.pattern` is `aria-invalid`, and the message beside it, which the control
 * is described by, is the one the author gave (`validation.message`; owner decision 187).
 *
 * Runs through `pnpm vitest run --project browser <this file>`; skipped in Node.js, which has no DOM.
 */
import { describe, expect, it } from 'vitest';
import { CODE, MESSAGE, PATTERN, PLAIN, patternDocument } from '../../test/frw-018-fixture.ts';
import { participantAccess } from '../../test/frw-fields-fixture.ts';
import { EditorCore } from './web.ts';

const isBrowser = typeof document !== 'undefined';

function mounted(
  validation?: Record<string, unknown>,
  config: Partial<ConstructorParameters<typeof EditorCore>[0]> = {},
) {
  const host = document.createElement('div');
  document.body.append(host);
  const core = new EditorCore({
    doc: patternDocument(validation),
    schedule: (run) => queueMicrotask(run),
    ...config,
  });
  const unmount = core.mountBody(host);
  const control = (): HTMLInputElement => {
    const el = host.querySelector<HTMLInputElement>(
      `[data-field="${CODE}"] .de-form-field-control`,
    );
    if (!el) throw new Error('no control for the field');
    return el;
  };
  /** Types `text` into the control: the `input` event of typing, then the `change` of leaving it. */
  const enter = (text: string, commit = true): HTMLInputElement => {
    const el = control();
    el.focus();
    el.value = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    if (commit) el.dispatchEvent(new Event('change', { bubbles: true }));
    return el;
  };
  const alert = (): HTMLElement => {
    const el = host.querySelector<HTMLElement>(`[data-field="${CODE}"] [role="alert"]`);
    if (!el) throw new Error('no message element for the field');
    return el;
  };
  return {
    core,
    control,
    enter,
    alert,
    cleanup() {
      unmount();
      core.destroy();
      host.remove();
    },
  };
}

describe.skipIf(!isBrowser)(
  'the control of a field with a pattern and a message (FRW-018 criterion 4)',
  () => {
    it('is invalid while the entry does not match, and says what the author wrote', () => {
      const m = mounted();
      try {
        // While typing, before the entry is submitted.
        const el = m.enter('ab12', false);
        expect(el.getAttribute('aria-invalid')).toBe('true');
        expect(m.alert().textContent).toBe(MESSAGE);
        expect(m.alert().hidden).toBe(false);
        expect(m.alert().getBoundingClientRect().width).toBeGreaterThan(0);
        // The control is described by the message: the description ends with its text.
        expect(el.getAttribute('aria-description')).toBe(`Text field for Tenant. ${MESSAGE}`);

        // Once submitted: still invalid, the entry is kept, and the core reports the field.
        el.dispatchEvent(new Event('change', { bubbles: true }));
        expect(el.getAttribute('aria-invalid')).toBe('true');
        expect(el.value).toBe('ab12');
        expect(m.alert().textContent).toBe(MESSAGE);
        expect(m.core.validateFields().find((r) => r.key === 'tenant.code')?.problems).toEqual([
          { code: 'pattern', message: MESSAGE, authored: true },
        ]);
      } finally {
        m.cleanup();
      }
    });

    it('is valid once the entry matches: no mark, no message', () => {
      const m = mounted();
      try {
        m.enter('ab12');
        const el = m.enter('AB1234');
        expect(el.hasAttribute('aria-invalid')).toBe(false);
        expect(el.getAttribute('aria-description')).toBe('Text field for Tenant');
        expect(m.alert().hidden).toBe(true);
        expect(m.alert().textContent).toBe('');
        expect(m.core.fieldEntry(CODE)?.stored).toBe('AB1234');
        expect(m.core.validateFields().map((r) => r.key)).not.toContain('tenant.code');
      } finally {
        m.cleanup();
      }
    });

    it('shows the wording of the rules package when the author gave no message', () => {
      const m = mounted({ pattern: PATTERN });
      try {
        const el = m.enter('ab12');
        expect(el.getAttribute('aria-invalid')).toBe('true');
        expect(m.alert().textContent).toBe(PLAIN);
      } finally {
        m.cleanup();
      }
    });

    it('shows the message to a participant who fills the field of their role', () => {
      const m = mounted(undefined, { access: participantAccess(['role_tenant']), mode: 'fill' });
      try {
        expect(m.control().readOnly).toBe(false);
        const el = m.enter('1234AB');
        expect(el.getAttribute('aria-invalid')).toBe('true');
        expect(m.alert().textContent).toBe(MESSAGE);
        // The value is stored as entered; the completion check judges it again (FRW-047).
        expect(m.core.fieldEntry(CODE)?.stored).toBe('1234AB');
        expect(m.enter('XY0001').hasAttribute('aria-invalid')).toBe(false);
      } finally {
        m.cleanup();
      }
    });

    it('follows the message when the author changes it', () => {
      const m = mounted({ pattern: PATTERN });
      try {
        m.enter('ab12');
        expect(m.alert().textContent).toBe(PLAIN);
        expect(
          m.core.editField(CODE, { validation: { pattern: PATTERN, message: MESSAGE } }),
        ).toEqual({ ok: true });
        expect(m.control().getAttribute('aria-invalid')).toBe('true');
        expect(m.alert().textContent).toBe(MESSAGE);
      } finally {
        m.cleanup();
      }
    });
  },
);
