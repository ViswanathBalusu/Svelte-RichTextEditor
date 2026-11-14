/**
 * FE-141 criterion 1, the fixed-size half, in a browser (lane U-FE-129-141, round 8): the
 * `.de-hidden-region` rule of the element's stylesheet gives every placeholder one size, whatever
 * its title is, so a long hidden title neither grows the box nor pushes the text around it. The
 * rules are the shipped ones (read with `?raw`), in Chromium, Firefox and WebKit
 * (`pnpm vitest run --project browser <this file>`). The whole-only selection of a placeholder is
 * the view's and is not tested here, so criterion 1 stays unticked in the story.
 */
import { DOMSerializer, Fragment, type Node as PMNode } from 'prosemirror-model';
import { afterEach, describe, expect, it } from 'vitest';
import elementCss from '../../element/src/styles/element.css?raw';
import { PLACEHOLDER, editingSchema } from './schema.ts';

const inBrowser = typeof globalThis.document !== 'undefined';

const hosts: HTMLElement[] = [];
const styles: HTMLStyleElement[] = [];

/** Renders one placeholder into a host of `width` CSS pixels and returns the placeholder element. */
function place(title: string | null, width: number): HTMLElement {
  const schema = editingSchema();
  const node = schema.nodes[PLACEHOLDER]!.create({ id: 'hid0000000000003', title }) as PMNode;
  const fragment = DOMSerializer.fromSchema(schema).serializeFragment(Fragment.from(node), {
    document: globalThis.document,
  });
  const host = globalThis.document.createElement('div');
  host.style.width = `${width}px`;
  host.append(fragment);
  globalThis.document.body.append(host);
  hosts.push(host);
  const el = host.firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error('the placeholder did not render an element');
  return el;
}

afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
  for (const style of styles.splice(0)) style.remove();
});

describe.skipIf(!inBrowser)(
  'FE-141 criterion 1 in a browser: a placeholder has a fixed size',
  () => {
    it('gives a short title, a long title and no title the same height, from the shipped rule', () => {
      const style = globalThis.document.createElement('style');
      style.textContent = elementCss;
      globalThis.document.head.append(style);
      styles.push(style);

      const short = place('Clause 4', 300);
      const long = place(
        'A very long title that would otherwise wrap over several lines and grow the placeholder box',
        300,
      );
      const none = place(null, 300);

      const heights = [short, long, none].map((el) => el.getBoundingClientRect().height);
      expect(heights[0]).toBeGreaterThan(0);
      expect(heights[1]).toBe(heights[0]);
      expect(heights[2]).toBe(heights[0]);

      // The rule sets the block size to 2.5em with border-box sizing, so the height is that em value.
      const fontSize = parseFloat(getComputedStyle(short).fontSize);
      expect(heights[0]).toBeCloseTo(fontSize * 2.5, 1);

      // A long title is cut at the box edge rather than wrapped, and the box keeps its width.
      expect(getComputedStyle(long).overflow).toBe('hidden');
      expect(getComputedStyle(long).whiteSpace).toBe('nowrap');
      expect(long.getBoundingClientRect().width).toBe(short.getBoundingClientRect().width);
    });
  },
);
