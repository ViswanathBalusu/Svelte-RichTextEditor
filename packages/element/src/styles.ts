/**
 * Styles for the shadow root (02 §3; ADR 0002; FE-014, FE-015, FE-018).
 *
 * Normal path: the compiled CSS is loaded once into one constructable `CSSStyleSheet`, which every
 * instance adopts, so two editors on a page hold the same sheet object and a policy without
 * `unsafe-inline` styles allows it. Fallback, for browsers or policies where that fails: a `<style>`
 * element the component creates itself, carrying the nonce from `config.styleNonce`. Svelte's
 * injected-style mode is never used, because it sets no nonce; the components have no style block.
 *
 * The CSS reaches the bundle as a string (`?inline`), which is the path spike S2 verified under a
 * strict policy: no request, so no `connect-src` or `style-src` entry for it (ADR 0039). The sheet
 * holds the element's rules first and the shell's after them (`@docedit/ui/styles/shell.css`).
 */
import shellCss from '@docedit/ui/styles/shell.css?inline';
import elementCss from './styles/element.css?inline';
import reflowCss from './styles/reflow.css?inline';

const css = `${elementCss}\n${reflowCss}\n${shellCss}`;

export const COMPONENT_CSS: string = css;

let shared: CSSStyleSheet | null | undefined;

/** The shared sheet, or null where constructable stylesheets are unavailable. */
export function sharedSheet(): CSSStyleSheet | null {
  if (shared !== undefined) return shared;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    shared = sheet;
  } catch {
    shared = null;
  }
  return shared;
}

export type StylePath = 'adopted' | 'nonce-style' | 'none';

export interface StyleOptions {
  /** Nonce for the fallback `<style>` element. */
  nonce?: string | null | undefined;
  /** Spike evidence: force the fallback even where adoption works. */
  forceFallback?: boolean | undefined;
}

const FALLBACK = 'data-de-styles';

/**
 * Attaches the component's styles to a shadow root, once, and reports the path used. Calling it
 * again on the same root (a document change remounts the shell) adds nothing.
 */
export function attachStyles(root: ShadowRoot, options: StyleOptions = {}): StylePath {
  const sheet = options.forceFallback ? null : sharedSheet();
  if (sheet) {
    if (root.adoptedStyleSheets.includes(sheet)) return 'adopted';
    try {
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      return 'adopted';
    } catch {
      // Fall through to the nonce path.
    }
  }
  if (root.querySelector(`style[${FALLBACK}]`)) return 'nonce-style';
  if (!options.nonce) return 'none';
  const style = document.createElement('style');
  style.nonce = options.nonce;
  style.setAttribute(FALLBACK, '');
  style.textContent = css;
  root.prepend(style);
  return 'nonce-style';
}

/** Adds one more constructable sheet (for a lazily loaded feature such as math display). */
export function adoptExtraSheet(root: ShadowRoot, text: string, nonce?: string | null): StylePath {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    return 'adopted';
  } catch {
    if (!nonce) return 'none';
    const style = document.createElement('style');
    style.nonce = nonce;
    style.textContent = text;
    root.append(style);
    return 'nonce-style';
  }
}
