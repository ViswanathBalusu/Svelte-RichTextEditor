/**
 * The controls of form fields under rules (FRW-023 criteria 1 to 4; lane w4), in a real browser: a
 * field a rule hides is not drawn and cannot take focus, and appears when the rule says so, without a
 * reload; a required field carries `aria-required` and a visible marker; a field a rule disables is
 * read-only; a failing `validate` makes the control `aria-invalid` with its message announced; and a
 * calculated field shows its value live and cannot be edited.
 *
 * Runs through `pnpm vitest run --project browser <this file>` in Chromium, Firefox and WebKit; the
 * suite is skipped in Node.js, which has no DOM. The core part is in `test/frw-023.rules-state.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { RULE_FIELD_IDS as ID, ruleDocument } from '../../test/frw-023-fixture.ts';
import { participantAccess } from '../../test/frw-fields-fixture.ts';
import { EditorCore } from './web.ts';

const isBrowser = typeof document !== 'undefined';

function mounted() {
  const host = document.createElement('div');
  document.body.append(host);
  const core = new EditorCore({
    doc: ruleDocument(),
    access: participantAccess(['role_tenant']),
    mode: 'fill',
    schedule: (run) => queueMicrotask(run),
  });
  const unmount = core.mountBody(host);
  const box = (id: string): HTMLElement => {
    const el = host.querySelector<HTMLElement>(`[data-field="${id}"]`);
    if (!el) throw new Error(`no field ${id}`);
    return el;
  };
  const control = (id: string): HTMLInputElement =>
    box(id).querySelector<HTMLInputElement>('.de-form-field-control')!;
  const focused = (id: string): boolean =>
    (control(id).getRootNode() as Document | ShadowRoot).activeElement === control(id);
  return {
    core,
    box,
    control,
    focused,
    cleanup() {
      unmount();
      core.destroy();
      host.remove();
    },
  };
}

const shown = (el: HTMLElement): boolean => getComputedStyle(el).display !== 'none';

describe.skipIf(!isBrowser)('a field a rule shows or hides (FRW-023 criterion 1)', () => {
  it('is not drawn and cannot take focus until the rule shows it, and goes again without a reload', () => {
    const m = mounted();
    try {
      expect(shown(m.box(ID.spouse))).toBe(false);
      expect(m.box(ID.spouse).getAttribute('data-hidden')).toBe('true');
      m.control(ID.spouse).focus({ preventScroll: true });
      expect(m.focused(ID.spouse)).toBe(false);

      m.core.enterFieldValue(ID.name, 'Ada');
      expect(shown(m.box(ID.spouse))).toBe(true);
      expect(m.box(ID.spouse).hasAttribute('data-hidden')).toBe(false);
      m.control(ID.spouse).focus({ preventScroll: true });
      expect(m.focused(ID.spouse)).toBe(true);

      m.core.enterFieldValue(ID.name, 'Bob');
      expect(shown(m.box(ID.spouse))).toBe(false);
    } finally {
      m.cleanup();
    }
  });
});

describe.skipIf(!isBrowser)('required and disabled fields (FRW-023 criterion 2)', () => {
  it('marks a field the rule requires with aria-required and a visible marker', () => {
    const m = mounted();
    try {
      const marker = (id: string) =>
        m.box(id).querySelector<HTMLElement>('.de-form-field-required')!;
      // The amount is not required; the e-mail is required by its own definition.
      expect(m.control(ID.amount).hasAttribute('aria-required')).toBe(false);
      expect(marker(ID.amount).hidden).toBe(true);
      expect(m.control(ID.email).getAttribute('aria-required')).toBe('true');
      expect(marker(ID.email).hidden).toBe(false);

      m.core.enterFieldValue(ID.name, 'Ada');
      expect(m.control(ID.spouse).getAttribute('aria-required')).toBe('true');
      expect(marker(ID.spouse).hidden).toBe(false);
      expect(marker(ID.spouse).getAttribute('aria-hidden')).toBe('true');
      m.core.enterFieldValue(ID.name, 'Bob');
      expect(m.control(ID.spouse).hasAttribute('aria-required')).toBe(false);
    } finally {
      m.cleanup();
    }
  });

  it('makes a field read-only while a rule disables it, and editable again after', () => {
    const m = mounted();
    try {
      expect(m.control(ID.email).readOnly).toBe(false);
      m.core.enterFieldValue(ID.amount, '99');
      expect(m.control(ID.email).readOnly).toBe(true);
      expect(m.control(ID.email).tabIndex).toBe(-1);
      m.core.enterFieldValue(ID.amount, '50');
      expect(m.control(ID.email).readOnly).toBe(false);
    } finally {
      m.cleanup();
    }
  });
});

describe.skipIf(!isBrowser)('a validate effect (FRW-023 criterion 3)', () => {
  it('makes the control aria-invalid and announces and describes the message while it fails', () => {
    const m = mounted();
    try {
      const message = () => m.box(ID.amount).querySelector<HTMLElement>('.de-form-field-message')!;
      m.core.enterFieldValue(ID.amount, '5');
      const c = m.control(ID.amount);
      expect(c.getAttribute('aria-invalid')).toBe('true');
      expect(message().textContent).toBe('Enter at least 10.');
      expect(message().hidden).toBe(false);
      expect(message().getAttribute('role')).toBe('alert');
      expect(c.getAttribute('aria-description')).toContain('Enter at least 10.');

      m.core.enterFieldValue(ID.amount, '20');
      expect(c.hasAttribute('aria-invalid')).toBe(false);
      expect(message().hidden).toBe(true);
    } finally {
      m.cleanup();
    }
  });
});

describe.skipIf(!isBrowser)('a calculated field (FRW-023 criterion 4)', () => {
  it('shows the computed value as the amount changes, read-only, and writes no stored value', () => {
    const m = mounted();
    try {
      const c = m.control(ID.total);
      expect(c.readOnly).toBe(true);
      expect(c.value).toBe('');
      m.core.enterFieldValue(ID.amount, '12.50');
      expect(c.value).toBe('25');
      m.core.enterFieldValue(ID.amount, '20');
      expect(c.value).toBe('40');
      expect(c.readOnly).toBe(true);
      expect(m.core.fieldEntry(ID.total)?.stored).toBeNull();
    } finally {
      m.cleanup();
    }
  });
});
