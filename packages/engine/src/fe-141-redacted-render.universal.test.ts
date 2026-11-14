/**
 * FE-141 criterion 2 in a browser (lane U-FE-129-141): a redacted field value renders as redacted,
 * distinct from an empty value, and carries the accessible name that a screen reader announces. The
 * rendering is the editing schema's own `toDOM` (schema.ts), serialised into a live document in
 * Chromium, Firefox and WebKit (`pnpm vitest run --project browser <this file>`). In the node
 * project the suite is skipped.
 */
import { DOMSerializer, Fragment, type Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { editingSchema } from './schema.ts';

/** The redaction marker of ADR 0019 (`REDACTION_MARKER` in model's projection.ts, not exported from the root). */
const redactionMarker = (): { redacted: true } => ({ redacted: true });

const inBrowser = typeof globalThis.document !== 'undefined';

/** Serialises one form field with the given value into a live host element in the page. */
function renderField(value: unknown): HTMLElement {
  const schema = editingSchema();
  const field = schema.nodes['form_field']!.create({ key: 'applicant_name', value }) as PMNode;
  const fragment = DOMSerializer.fromSchema(schema).serializeFragment(Fragment.from(field), {
    document: globalThis.document,
  });
  const host = globalThis.document.createElement('div');
  host.append(fragment);
  globalThis.document.body.append(host);
  const el = host.firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error('the form field did not render an element');
  return el;
}

describe.skipIf(!inBrowser)('FE-141 criterion 2 in a browser: redacted field values', () => {
  it('renders a redacted value as redacted text, with an accessible name a screen reader announces', () => {
    const el = renderField(redactionMarker());
    expect(el.getAttribute('data-redacted')).toBe('true');
    expect(el.classList.contains('de-redacted')).toBe(true);
    expect(el.textContent).toBe('[redacted]');
    expect(el.getAttribute('role')).toBe('img');
    expect(el.getAttribute('aria-label')).toBe('Redacted value');
    el.parentElement?.remove();
  });

  it('renders a redacted value distinct from an empty value, which is not announced as redacted', () => {
    const redacted = renderField(redactionMarker());
    const empty = renderField(null);
    expect(empty.hasAttribute('data-redacted')).toBe(false);
    expect(empty.hasAttribute('aria-label')).toBe(false);
    expect(empty.textContent).not.toBe(redacted.textContent);
    expect(empty.textContent).not.toBe('');
    redacted.parentElement?.remove();
    empty.parentElement?.remove();
  });
});
