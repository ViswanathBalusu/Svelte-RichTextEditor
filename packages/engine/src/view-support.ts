/**
 * Pieces of the web view that touch the DOM (02 §3, §8).
 *
 * - Mark views that apply style values through the CSSOM, after checking each value against its
 *   grammar (I11; FE-067). The schema's toDOM never writes a `style` attribute, because that is an
 *   inline style under a content security policy.
 * - The shadow-root selection shim: ProseMirror reads the selection through `root.getSelection()`.
 *   Where `ShadowRoot.prototype.getSelection` does not exist (Firefox, and WebKit), ProseMirror
 *   assigns one to the prototype, which every shadow root on the host page then inherits (02 §8).
 *   Defining the method on this one shadow root instead keeps the side effect inside the component.
 */
import type { MarkViewConstructor } from 'prosemirror-view';

const COLOUR = /^#[0-9A-F]{6}$/;
const FONT_FAMILY = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,63}$/;

function styledSpan(apply: (style: CSSStyleDeclaration) => void): { dom: HTMLElement } {
  const dom = document.createElement('span');
  apply(dom.style);
  return { dom };
}

/**
 * The CSS value of a colour mark, or `undefined` when the value does not match the grammar (I11;
 * FE-067 criterion 4). `undefined` means the mark view sets nothing and the default applies.
 */
export function colourValue(v: unknown): string | undefined {
  return typeof v === 'string' && COLOUR.test(v) ? v : undefined;
}

/**
 * The CSS value of a size mark, in points, from twentieths of a point (03 §2), or `undefined` when
 * the value is not an integer from 20 to 32760 (I11; FE-067 criterion 4).
 */
export function fontSizeValue(v: unknown): string | undefined {
  return Number.isInteger(v) && (v as number) >= 20 && (v as number) <= 32760
    ? `${(v as number) / 20}pt`
    : undefined;
}

/**
 * The CSS value of a family mark: the quoted family name, or `undefined` when the name does not
 * match the grammar (I11; FE-067 criterion 4). The alias mapping of FE-062 replaces the name later.
 */
export function fontFamilyValue(v: unknown): string | undefined {
  return typeof v === 'string' && FONT_FAMILY.test(v) ? `"${v}"` : undefined;
}

/**
 * The font alias a family renders with (FE-062 criterion 1): the hash alias of the manifest file
 * that serves the family, or `undefined` when the manifest has no face for it. The document keeps
 * the family name; only the CSS value changes. The lookup is read each time a mark is drawn.
 */
export type FontAliasLookup = (family: string) => string | undefined;

export function cssomMarkViews(fontAlias?: FontAliasLookup): Record<string, MarkViewConstructor> {
  return {
    color: (mark) =>
      styledSpan((s) => {
        const value = colourValue(mark.attrs['value']);
        if (value !== undefined) s.color = value;
      }),
    fontSize: (mark) =>
      styledSpan((s) => {
        const value = fontSizeValue(mark.attrs['value']);
        if (value !== undefined) s.fontSize = value;
      }),
    fontFamily: (mark) =>
      styledSpan((s) => {
        const raw = mark.attrs['value'];
        const value = fontFamilyValue(raw);
        if (value === undefined) return;
        const alias = typeof raw === 'string' && fontAlias ? fontAlias(raw) : undefined;
        // Without an alias the family name is used, as before FE-062.
        s.fontFamily = alias !== undefined ? `"${alias}"` : value;
      }),
  };
}

export type SelectionShim = 'instance' | 'library';

/**
 * Gives a shadow root its own `getSelection` when the platform has none, so that ProseMirror does
 * not patch `ShadowRoot.prototype` (02 §8). Returns what was done, for the spike's records.
 */
export function shimShadowSelection(
  root: Node,
  mode: SelectionShim,
): 'native' | 'instance' | 'none' {
  if (typeof ShadowRoot === 'undefined' || !(root instanceof ShadowRoot)) return 'none';
  if (typeof (root as ShadowRoot & { getSelection?: unknown }).getSelection === 'function')
    return 'native';
  if (mode === 'library') return 'none';
  const doc = root.ownerDocument;
  Object.defineProperty(root, 'getSelection', {
    configurable: true,
    value: () => doc.getSelection(),
  });
  return 'instance';
}
