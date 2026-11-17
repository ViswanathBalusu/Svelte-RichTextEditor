/**
 * UX-058 criteria 1, 4 and 5 for the rendering of a custom block whose extension is not available
 * (the editing schema's own `toDOM`, schema.ts): the fallback is shown with a notice that the
 * content comes from an unavailable extension, the fallback text is an ordinary paragraph, a fallback
 * picture takes the fallback text as its alternative text, and the payload never reaches the page.
 * The spec-level checks run in Node.js; the DOM checks run in Chromium, Firefox and WebKit
 * (`pnpm exec vitest run --project browser packages/engine/src/ux-058-extension-fallback.universal.test.ts`).
 */
import { DOMSerializer, Fragment, type Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { EXTENSION_NOTICE, editingSchema } from './schema.ts';

const inBrowser = typeof globalThis.document !== 'undefined';
const PAYLOAD_MARKER = 'UX058-PAYLOAD-MARKER';

const block = (attrs: Record<string, unknown>): PMNode =>
  editingSchema().nodes['extension_block']!.create({
    id: 'xBlock0000000001',
    extension: 'com.example.chart',
    payload: { secret: PAYLOAD_MARKER },
    fallbackAsset: null,
    fallbackText: null,
    ...attrs,
  });

type Spec = [string, Record<string, string>, ...Spec[]] | string;
const specOf = (node: PMNode): [string, Record<string, string>, ...Spec[]] =>
  node.type.spec.toDOM!(node) as never;

describe('UX-058: the fallback of an unavailable extension (rendering spec)', () => {
  it('shows the notice and the fallback text as an ordinary paragraph inside a named group', () => {
    const [tag, attrs, ...children] = specOf(block({ fallbackText: 'A chart of three values' }));
    expect(tag).toBe('div');
    expect(attrs).toMatchObject({
      role: 'group',
      'aria-label': 'Content from extension com.example.chart',
    });
    expect(children).toContainEqual(['p', { class: 'de-extension-notice' }, EXTENSION_NOTICE]);
    // The text carries no role, no aria-hidden and no aria-label: a screen reader reads it as text.
    expect(children).toContainEqual([
      'p',
      { class: 'de-extension-text' },
      'A chart of three values',
    ]);
    expect(EXTENSION_NOTICE).toMatch(/extension that is not available/);
  });

  it('draws a fallback picture with the fallback text as its alternative text', () => {
    const withBoth = specOf(
      block({ fallbackAsset: 'aFallback0000001', fallbackText: 'Sales by month' }),
    );
    const image = withBoth.slice(2).find((c) => Array.isArray(c) && c[0] === 'span') as Spec;
    expect(image).toEqual([
      'span',
      { class: 'de-image de-extension-image', role: 'img', 'aria-label': 'Sales by month' },
    ]);
  });

  it('leaves a picture with no fallback text without an alternative text, for the checker to flag', () => {
    const only = specOf(block({ fallbackAsset: 'aFallback0000001' }));
    const image = only.slice(2).find((c) => Array.isArray(c) && c[0] === 'span') as [
      string,
      Record<string, string>,
    ];
    expect(image[1]['aria-label']).toBe('');
  });

  it('never puts the payload in the rendering', () => {
    expect(JSON.stringify(specOf(block({ fallbackText: 'x' })))).not.toContain(PAYLOAD_MARKER);
  });
});

describe.skipIf(!inBrowser)('UX-058: the same rendering in a browser', () => {
  const render = (node: PMNode): HTMLElement => {
    const schema = editingSchema();
    const fragment = DOMSerializer.fromSchema(schema).serializeFragment(Fragment.from(node), {
      document: globalThis.document,
    });
    const host = globalThis.document.createElement('div');
    host.append(fragment);
    globalThis.document.body.append(host);
    return host.firstElementChild as HTMLElement;
  };

  it('has the notice, the text in an ordinary paragraph, a group name, and no payload', () => {
    const el = render(block({ fallbackText: 'A chart of three values' }));
    expect(el.getAttribute('role')).toBe('group');
    expect(el.getAttribute('aria-label')).toBe('Content from extension com.example.chart');
    expect(el.querySelector('.de-extension-notice')!.textContent).toBe(EXTENSION_NOTICE);
    const text = el.querySelector('.de-extension-text')!;
    expect(text.tagName).toBe('P');
    expect(text.textContent).toBe('A chart of three values');
    expect(text.closest('[aria-hidden="true"]')).toBeNull();
    expect(text.getAttribute('role')).toBeNull();
    expect(el.outerHTML).not.toContain(PAYLOAD_MARKER);
  });

  it('gives a fallback picture its alternative text', () => {
    const el = render(block({ fallbackAsset: 'aFallback0000001', fallbackText: 'Sales by month' }));
    const image = el.querySelector('[role="img"]')!;
    expect(image.getAttribute('aria-label')).toBe('Sales by month');
  });
});
