/**
 * UX-057 criterion 3 for the rendering of inline custom content whose extension is not registered
 * (the editing schema's own `toDOM`, schema.ts): the fallback text is shown inside the line as
 * ordinary text, and the payload never reaches the page. The DOM checks run in Chromium, Firefox
 * and WebKit (`pnpm exec vitest run --project browser packages/engine/src/ux-057-extension-inline.universal.test.ts`).
 */
import { DOMSerializer, Fragment, type Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { editingSchema } from './schema.ts';

const inBrowser = typeof globalThis.document !== 'undefined';
const PAYLOAD_MARKER = 'UX057-PAYLOAD-MARKER';

const inline = (fallbackText: string | null): PMNode =>
  editingSchema().nodes['extension_inline']!.create({
    extension: 'com.example.mention',
    payload: { secret: PAYLOAD_MARKER },
    fallbackText,
  });

describe('UX-057: the fallback text of an unavailable extension (rendering spec)', () => {
  it('is one span with the fallback text and no role, so it reads as ordinary text', () => {
    const node = inline('@Ada Lovelace');
    const spec = node.type.spec.toDOM!(node) as unknown as [string, Record<string, string>, string];
    expect(spec[0]).toBe('span');
    expect(spec[1]).not.toHaveProperty('role');
    expect(spec[1]).not.toHaveProperty('aria-hidden');
    expect(spec[2]).toBe('@Ada Lovelace');
    expect(JSON.stringify(spec)).not.toContain(PAYLOAD_MARKER);
  });
});

describe.skipIf(!inBrowser)('UX-057: the same rendering in a browser', () => {
  const render = (node: PMNode): HTMLElement => {
    const fragment = DOMSerializer.fromSchema(editingSchema()).serializeFragment(
      Fragment.from(node),
      { document: globalThis.document },
    );
    const host = globalThis.document.createElement('div');
    host.append(fragment);
    return host;
  };

  it('shows the fallback text in the line, inside nothing hidden, and not the payload', () => {
    const host = render(inline('@Ada Lovelace'));
    const span = host.querySelector('span.de-extension-inline') as HTMLElement;
    expect(span.textContent).toBe('@Ada Lovelace');
    expect(span.getAttribute('data-extension')).toBe('com.example.mention');
    expect(span.closest('[aria-hidden]')).toBeNull();
    expect(host.innerHTML).not.toContain(PAYLOAD_MARKER);
  });
});
