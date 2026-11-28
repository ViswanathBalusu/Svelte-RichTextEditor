/**
 * The ribbon's own style sheet (`styles/ribbon.css`; ADR 0490). The rules of its toolbar are not in
 * `shell.css`, which the first load carries whole (the build keeps all CSS in the first chunk), so the
 * ribbon adopts them into the shadow root it is in when it loads, as the element does for the maths
 * display. A constructable sheet needs no `style-src` entry; where the browser or the policy refuses
 * it, a `<style>` element takes the nonce of the one the element made for its own rules, and without
 * a nonce nothing is added. A root that has the sheet is left as it is.
 */
const adopted = new WeakSet<Node>();
let shared: CSSStyleSheet | null | undefined;

function sheetOf(css: string): CSSStyleSheet | null {
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

/** Adds the ribbon's rules to the root, once; true when they are there. */
export function adoptRibbonStyles(root: ParentNode & Node, css: string): boolean {
  if (adopted.has(root)) return true;
  const target = root as Partial<DocumentOrShadowRoot> & ParentNode & Node;
  const sheet = sheetOf(css);
  if (sheet && target.adoptedStyleSheets) {
    try {
      target.adoptedStyleSheets = [...target.adoptedStyleSheets, sheet];
      adopted.add(root);
      return true;
    } catch {
      // Fall through to the nonce path.
    }
  }
  const nonce = root.querySelector<HTMLStyleElement>('style[data-de-styles]')?.nonce;
  if (!nonce) return false;
  const style = document.createElement('style');
  style.nonce = nonce;
  style.textContent = css;
  root.appendChild(style);
  adopted.add(root);
  return true;
}
