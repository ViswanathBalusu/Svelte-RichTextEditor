/**
 * FE-069, criteria 1, 2, 4 and 6 in a browser (`*.universal.test.ts`, Chromium, Firefox and WebKit):
 * KaTeX draws a valid source with trust off and strict mode; the output is built by DOM calls and
 * not by an `innerHTML` assignment; a source KaTeX rejects shows a placeholder with the source and
 * throws nothing; the drawn equation carries its source as the text alternative.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EQUATION_PLACEHOLDER_CLASS, EQUATION_OPTIONS, drawEquation } from './math-display.ts';

const isBrowser = typeof document !== 'undefined' && typeof Element === 'function';

describe.skipIf(!isBrowser)('KaTeX equation display (FE-069)', () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
  });

  afterEach(() => {
    host.remove();
  });

  it('draws valid LaTeX inline with KaTeX and no placeholder (criterion 1)', () => {
    expect(EQUATION_OPTIONS).toMatchObject({ trust: false, strict: 'error', throwOnError: true });
    const out = drawEquation(host, '\\frac{a}{b}', false);
    expect(out).toEqual({ status: 'drawn' });
    expect(host.querySelector('.katex')).not.toBeNull();
    expect(host.querySelector(`.${EQUATION_PLACEHOLDER_CLASS}`)).toBeNull();
  });

  it('draws a display equation in display mode', () => {
    drawEquation(host, 'x^2', true);
    expect(host.querySelector('.katex-display')).not.toBeNull();
  });

  it('builds the output without assigning an HTML string (criterion 2)', () => {
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    expect(desc?.set).toBeTypeOf('function');
    let assignments = 0;
    Object.defineProperty(Element.prototype, 'innerHTML', {
      ...desc!,
      set(this: Element, value: string) {
        assignments += 1;
        desc!.set!.call(this, value);
      },
    });
    try {
      drawEquation(host, '\\sum_{i=1}^{n} i', true);
      drawEquation(host, '\\notacommand', false);
    } finally {
      Object.defineProperty(Element.prototype, 'innerHTML', desc!);
    }
    expect(assignments).toBe(0);
    expect(host.querySelector('.katex')).toBeNull();
  });

  it('draws \\href with trust off as its body only, with no link element or href (criterion 1)', () => {
    const out = drawEquation(host, '\\href{https://example.com}{x}', false);
    expect(out).toEqual({ status: 'drawn' });
    expect(host.querySelector('a')).toBeNull();
    expect(host.querySelector('[href]')).toBeNull();
    expect(host.querySelector('.katex')).not.toBeNull();
  });

  it('shows a visible placeholder with the source for a rejected source, and throws nothing (criterion 4)', () => {
    const source = '\\notacommand{x}';
    let out: ReturnType<typeof drawEquation> | null = null;
    expect(() => {
      out = drawEquation(host, source, false);
    }).not.toThrow();
    expect(out).toMatchObject({ status: 'placeholder' });
    const placeholder = host.querySelector(`.${EQUATION_PLACEHOLDER_CLASS}`);
    expect(placeholder?.textContent).toBe(source);
    expect(host.querySelector('.katex')).toBeNull();
  });

  it('replaces the previous equation when drawn again (no stacking)', () => {
    drawEquation(host, 'a', false);
    drawEquation(host, 'b', false);
    expect(host.querySelectorAll('.katex')).toHaveLength(1);
  });

  it('exposes the source as the text alternative in the MathML annotation (criterion 6)', () => {
    drawEquation(host, 'x^2+y^2', false);
    const annotation = host.querySelector('annotation[encoding="application/x-tex"]');
    expect(annotation?.textContent).toBe('x^2+y^2');
  });
});
