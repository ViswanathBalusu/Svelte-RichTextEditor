// The style path of a shadow root (FE-014, FE-015): the shared constructable sheet when it works,
// and otherwise one `<style>` element the component creates, carrying the same CSS and the nonce
// from `config`. Node.js has no DOM, so the root, the element and the sheet are small stand-ins;
// each case loads the module afresh, because the shared sheet is cached per module instance.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeStyle {
  nonce = '';
  textContent = '';
  readonly attributes = new Map<string, string>();
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
}

class FakeRoot {
  /** When true, assigning `adoptedStyleSheets` throws, as a policy or old browser may do. */
  refuseAdoption = false;
  #sheets: unknown[] = [];
  readonly children: FakeStyle[] = [];

  get adoptedStyleSheets(): unknown[] {
    return this.#sheets;
  }

  set adoptedStyleSheets(value: unknown[]) {
    if (this.refuseAdoption) throw new Error('NotAllowedError: adoption refused');
    this.#sheets = value;
  }

  prepend(node: FakeStyle): void {
    this.children.unshift(node);
  }

  querySelector(selector: string): FakeStyle | null {
    if (selector !== 'style[data-de-styles]') throw new Error(`unexpected selector ${selector}`);
    return this.children.find((c) => c.hasAttribute('data-de-styles')) ?? null;
  }
}

class FakeSheet {
  text = '';
  replaceSync(text: string): void {
    this.text = text;
  }
}

type Globals = { CSSStyleSheet?: unknown; document?: unknown };
const saved: Globals = {};

function setGlobal(name: keyof Globals, value: unknown): void {
  (globalThis as Record<string, unknown>)[name] = value;
}

beforeEach(() => {
  saved.CSSStyleSheet = (globalThis as Record<string, unknown>)['CSSStyleSheet'];
  saved.document = (globalThis as Record<string, unknown>)['document'];
  setGlobal('document', { createElement: () => new FakeStyle() });
  setGlobal('CSSStyleSheet', FakeSheet);
  vi.resetModules();
});

afterEach(() => {
  setGlobal('CSSStyleSheet', saved.CSSStyleSheet);
  setGlobal('document', saved.document);
  vi.resetModules();
});

async function loadStyles() {
  return import('../src/styles.ts');
}

describe('FE-015: the nonce style element is the fallback', () => {
  it('creates its own style element with the CSS and the config nonce when constructable sheets are unavailable', async () => {
    setGlobal('CSSStyleSheet', undefined);
    const styles = await loadStyles();
    const root = new FakeRoot();
    const path = styles.attachStyles(root as unknown as ShadowRoot, { nonce: 'n-123' });
    expect(path).toBe('nonce-style');
    expect(root.children).toHaveLength(1);
    const [style] = root.children as [FakeStyle];
    expect(style!.nonce).toBe('n-123');
    expect(style!.hasAttribute('data-de-styles')).toBe(true);
    expect(styles.COMPONENT_CSS.length).toBeGreaterThan(0);
    expect(style!.textContent).toBe(styles.COMPONENT_CSS);
    expect(root.adoptedStyleSheets).toHaveLength(0);
  });

  it('takes the same path when adopting the sheet throws', async () => {
    const styles = await loadStyles();
    const root = new FakeRoot();
    root.refuseAdoption = true;
    const path = styles.attachStyles(root as unknown as ShadowRoot, { nonce: 'n-456' });
    expect(path).toBe('nonce-style');
    expect(root.children.map((c) => c.nonce)).toEqual(['n-456']);
    expect(root.children[0]!.textContent).toBe(styles.COMPONENT_CSS);
  });

  it('takes the same path when the fallback is forced for evidence (config flag)', async () => {
    const styles = await loadStyles();
    const root = new FakeRoot();
    const path = styles.attachStyles(root as unknown as ShadowRoot, {
      nonce: 'n-789',
      forceFallback: true,
    });
    expect(path).toBe('nonce-style');
    expect(root.children.map((c) => c.nonce)).toEqual(['n-789']);
  });

  it('adds nothing when a fallback is needed but no nonce was given (reported as none)', async () => {
    setGlobal('CSSStyleSheet', undefined);
    const styles = await loadStyles();
    const root = new FakeRoot();
    expect(styles.attachStyles(root as unknown as ShadowRoot, { nonce: null })).toBe('none');
    expect(root.children).toHaveLength(0);
  });

  it('does not add a second fallback element when the same root is attached again', async () => {
    setGlobal('CSSStyleSheet', undefined);
    const styles = await loadStyles();
    const root = new FakeRoot();
    styles.attachStyles(root as unknown as ShadowRoot, { nonce: 'n' });
    expect(styles.attachStyles(root as unknown as ShadowRoot, { nonce: 'n' })).toBe('nonce-style');
    expect(root.children).toHaveLength(1);
  });
});

describe('FE-015: the normal path has no style element', () => {
  it('adopts one shared sheet, creates no <style> and does not repeat the adoption', async () => {
    const styles = await loadStyles();
    const a = new FakeRoot();
    const b = new FakeRoot();
    expect(styles.attachStyles(a as unknown as ShadowRoot, { nonce: 'n' })).toBe('adopted');
    expect(styles.attachStyles(b as unknown as ShadowRoot, { nonce: 'n' })).toBe('adopted');
    expect(styles.attachStyles(a as unknown as ShadowRoot, { nonce: 'n' })).toBe('adopted');
    expect(a.adoptedStyleSheets).toHaveLength(1);
    expect(a.adoptedStyleSheets[0]).toBe(b.adoptedStyleSheets[0]);
    expect(a.children).toHaveLength(0);
    expect(b.children).toHaveLength(0);
  });
});
