/**
 * Style probes for spike S2 (02 §3): which ways of setting styles from script survive the page's
 * policy, in the document and in a shadow root. Each probe sets `outline-color` to a marker value
 * and reports whether the computed style shows it; the test reads the violations recorded by
 * spike-flags.ts around each probe.
 */

const MARK = 'rgb(9, 8, 7)';
const DECL = `outline-color: ${MARK}; outline-style: solid`;

function nonce(): string | null {
  return document.querySelector('meta[name="de-nonce"]')?.getAttribute('content') ?? null;
}

function target(where: 'document' | 'shadow'): { el: HTMLElement; root: Document | ShadowRoot } {
  const host = document.createElement('div');
  document.body.append(host);
  if (where === 'document') {
    const el = document.createElement('span');
    el.className = 'probe';
    host.append(el);
    return { el, root: document };
  }
  const root = host.attachShadow({ mode: 'open' });
  const el = document.createElement('span');
  el.className = 'probe';
  root.append(el);
  return { el, root };
}

const applied = (el: HTMLElement) => getComputedStyle(el).outlineColor === MARK;

type Probe = (where: 'document' | 'shadow') => boolean;

const probes: Record<string, Probe> = {
  styleProperty: (w) => {
    const { el } = target(w);
    el.style.outlineColor = MARK;
    el.style.outlineStyle = 'solid';
    return applied(el);
  },
  setProperty: (w) => {
    const { el } = target(w);
    el.style.setProperty('outline-color', MARK);
    el.style.setProperty('outline-style', 'solid');
    return applied(el);
  },
  cssText: (w) => {
    const { el } = target(w);
    el.style.cssText = DECL;
    return applied(el);
  },
  cssTextAppend: (w) => {
    const { el } = target(w);
    el.style.cssText += DECL;
    return applied(el);
  },
  setAttribute: (w) => {
    const { el } = target(w);
    el.setAttribute('style', DECL);
    return applied(el);
  },
  constructable: (w) => {
    const { el, root } = target(w);
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`.probe { ${DECL} }`);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    const ok = applied(el);
    root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== sheet);
    return ok;
  },
  styleWithNonce: (w) => {
    const { el, root } = target(w);
    const style = document.createElement('style');
    const n = nonce();
    if (n) style.nonce = n;
    style.textContent = `.probe { ${DECL} }`;
    (root === document ? document.head : (root as ShadowRoot)).append(style);
    const ok = applied(el);
    style.remove();
    return ok;
  },
  /** Not a style write: PDF.js sets the canvas filter; reports whether the value was taken. */
  canvasFilter: () => {
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.filter = 'grayscale(1)';
    const taken = ctx.filter === 'grayscale(1)';
    ctx.filter = 'none';
    return taken;
  },
  styleWithoutNonce: (w) => {
    const { el, root } = target(w);
    const style = document.createElement('style');
    style.textContent = `.probe { ${DECL} }`;
    (root === document ? document.head : (root as ShadowRoot)).append(style);
    const ok = applied(el);
    style.remove();
    return ok;
  },
};

Object.assign(globalThis, {
  __probe: {
    names: Object.keys(probes),
    run: (name: string, where: 'document' | 'shadow') => {
      const probe = probes[name];
      if (!probe) throw new Error(`no probe ${name}`);
      return probe(where);
    },
  },
});
