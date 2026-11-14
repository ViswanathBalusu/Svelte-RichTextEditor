/**
 * Styles, numbering definitions and settings as every reader resolves them (03 §4.1, §4.3, §6;
 * CDM-016, CDM-041):
 *
 * - a paragraph whose `style` is null has the style named by `settings.defaultParagraphStyle`;
 * - an attribute that is null on a style means "not set here; inherit" through `basedOn`;
 * - a paragraph is a heading when its style, through `basedOn`, has an `outlineLevel`.
 *
 * The functions read plain JSON (03 §1 principle 2), so they work on stored documents and on the
 * `attrs` of ProseMirror nodes alike. Chains are followed at most ten styles deep (I5) and never
 * loop, so they are safe on a document that has not been validated. `styleChain` reports a broken
 * chain as a typed error; the older `styleProperty` stops quietly where a chain breaks.
 */
import type { JsonValue } from '../definition/grammar.ts';
import { indexDefinition } from '../definition/index.ts';

export type Attrs = Readonly<Record<string, unknown>>;

/** A mark as plain JSON or as a ProseMirror mark's `type.name` and `attrs`. */
export interface MarkLike {
  type: string;
  attrs?: Attrs | undefined;
}

/** A node as plain JSON (03 §1 principle 2). */
export interface NodeLike {
  type: string;
  attrs?: Attrs | undefined;
  content?: readonly NodeLike[] | undefined;
  marks?: readonly MarkLike[] | undefined;
  text?: string | undefined;
}

/**
 * A node as plain JSON or as a ProseMirror node (`type.name`, `attrs`, and a `content` fragment
 * with `forEach`), so that the editor can compute labels without serialising its document. Nothing
 * here imports ProseMirror (03 §1 principle 2).
 */
export interface TreeNode {
  readonly type: string | { readonly name: string };
  readonly attrs?: Attrs | null | undefined;
  readonly content?:
    readonly TreeNode[] | { forEach(f: (child: TreeNode) => void): void } | null | undefined;
}

/** The type name of a JSON or ProseMirror node. */
export function typeOf(node: TreeNode): string {
  return typeof node.type === 'string' ? node.type : node.type.name;
}

/** The attributes of a JSON or ProseMirror node; an empty object when it has none. */
export function attrsOf(node: TreeNode): Attrs {
  return node.attrs ?? EMPTY;
}

const EMPTY: Attrs = Object.freeze({});

/** Calls `f` for each child of a JSON or ProseMirror node, in order. */
export function eachChild(node: TreeNode, f: (child: TreeNode) => void): void {
  const c = node.content;
  if (!c) return;
  if (Array.isArray(c)) for (const child of c as readonly TreeNode[]) f(child);
  else (c as { forEach(g: (child: TreeNode) => void): void }).forEach((child) => f(child));
}

export type FootnoteFormat =
  'decimal' | 'lowerRoman' | 'upperRoman' | 'lowerLetter' | 'upperLetter' | 'symbol';

/** The settings that the layout semantics read, with the definition's defaults filled in. */
export interface DocumentSettings {
  readonly lang: string | null;
  readonly dir: 'ltr' | 'rtl';
  /** Default tab interval in twips (CDM-044). */
  readonly defaultTabStop: number;
  readonly hyphenation: boolean;
  readonly defaultParagraphStyle: string;
  readonly footnoteFormat: FootnoteFormat;
  /** `perPageSection` restarts footnote numbers at every page section (ADR 0032). */
  readonly footnoteRestart: 'continuous' | 'perPageSection';
}

export interface StyleTable {
  defaultParagraphStyle: string;
  styles: ReadonlyMap<string, Attrs>;
  /** The `levels` of every numbering definition, by identifier (CDM-042). */
  numberings: ReadonlyMap<string, readonly Attrs[]>;
  settings: DocumentSettings;
}

/** I5: `basedOn` chains are at most ten styles deep. */
const MAX_CHAIN = 10;

let settingDefaults: DocumentSettings | undefined;

/** The defaults of `settings`, read from the definition so that there is one source (CDM-002). */
export function defaultSettings(): DocumentSettings {
  if (settingDefaults) return settingDefaults;
  const attrs = indexDefinition().nodes.get('settings')!.attrs;
  const d = (name: string): JsonValue => attrs[name]!.default;
  settingDefaults = Object.freeze({
    lang: d('lang') as string | null,
    dir: d('dir') as DocumentSettings['dir'],
    defaultTabStop: d('defaultTabStop') as number,
    hyphenation: d('hyphenation') as boolean,
    defaultParagraphStyle: d('defaultParagraphStyle') as string,
    footnoteFormat: d('footnoteFormat') as FootnoteFormat,
    footnoteRestart: d('footnoteRestart') as DocumentSettings['footnoteRestart'],
  });
  return settingDefaults;
}

function settingsOf(attrs: Attrs | undefined): DocumentSettings {
  const base = defaultSettings();
  if (!attrs) return base;
  const pick = <K extends keyof DocumentSettings>(name: K, type: string): DocumentSettings[K] => {
    const value = attrs[name];
    return (typeof value === type ? value : base[name]) as DocumentSettings[K];
  };
  return {
    lang: pick('lang', 'string'),
    dir: pick('dir', 'string'),
    defaultTabStop: pick('defaultTabStop', 'number'),
    hyphenation: pick('hyphenation', 'boolean'),
    defaultParagraphStyle: pick('defaultParagraphStyle', 'string'),
    footnoteFormat: pick('footnoteFormat', 'string'),
    footnoteRestart: pick('footnoteRestart', 'string'),
  };
}

/** Collects the styles, numbering definitions and settings of a document's `defs`. */
export function styleTable(doc: NodeLike | TreeNode): StyleTable {
  const styles = new Map<string, Attrs>();
  const numberings = new Map<string, readonly Attrs[]>();
  let settings = defaultSettings();
  eachChild(doc as TreeNode, (top) => {
    if (typeOf(top) !== 'defs') return;
    eachChild(top, (d) => {
      const type = typeOf(d);
      const attrs = attrsOf(d);
      const id = attrs['id'];
      if (type === 'style_def' && typeof id === 'string') styles.set(id, attrs);
      else if (type === 'numbering_def' && typeof id === 'string') {
        const levels = attrs['levels'];
        numberings.set(id, Array.isArray(levels) ? (levels as Attrs[]) : []);
      } else if (type === 'settings') settings = settingsOf(attrs);
    });
  });
  return { defaultParagraphStyle: settings.defaultParagraphStyle, styles, numberings, settings };
}

/** The style a paragraph has: its own, or the default paragraph style when `style` is null. */
export function paragraphStyleOf(table: StyleTable, paragraphAttrs: Attrs | undefined): string {
  const style = paragraphAttrs?.['style'];
  return typeof style === 'string' ? style : table.defaultParagraphStyle;
}

/** The value of a style property, inherited through `basedOn`; null when no style in the chain sets it. */
export function styleProperty(table: StyleTable, styleId: string, name: string): JsonValue {
  const seen = new Set<string>();
  for (let id: string | null = styleId; id !== null && !seen.has(id) && seen.size < MAX_CHAIN;) {
    seen.add(id);
    const style = table.styles.get(id);
    if (!style) return null;
    const value = style[name];
    if (value !== null && value !== undefined) return value as JsonValue;
    const parent = style['basedOn'];
    id = typeof parent === 'string' ? parent : null;
  }
  return null;
}

/** The outline level of a paragraph (1 to 9), or null when it is not a heading. */
export function outlineLevelOf(
  table: StyleTable,
  paragraphAttrs: Attrs | undefined,
): number | null {
  const level = styleProperty(table, paragraphStyleOf(table, paragraphAttrs), 'outlineLevel');
  return typeof level === 'number' ? level : null;
}

// ---------------------------------------------------------------------------------------------
// Chains with typed errors (CDM-041).

export type CascadeErrorCode = 'style_missing' | 'style_cycle' | 'style_chain_too_long';

/** Why a style could not be resolved. Invariants I4 and I5 normally prevent all three. */
export interface CascadeError {
  readonly code: CascadeErrorCode;
  /** The style whose chain is broken. */
  readonly styleId: string;
  /** The styles followed before the break, from the style towards its root. */
  readonly chain: readonly string[];
  readonly message: string;
}

export type StyleChainResult =
  | { readonly ok: true; readonly chain: readonly string[] }
  | { readonly ok: false; readonly error: CascadeError };

const chains = new WeakMap<StyleTable, Map<string, StyleChainResult>>();

/**
 * The `basedOn` chain of a style, from the root of the chain to the style itself (03 §6, layer 4).
 * A missing style, a cycle or a chain longer than ten styles is a typed error; the walk always ends.
 */
export function styleChain(table: StyleTable, styleId: string): StyleChainResult {
  let byId = chains.get(table);
  if (!byId) {
    byId = new Map();
    chains.set(table, byId);
  }
  const known = byId.get(styleId);
  if (known) return known;
  const path: string[] = [];
  const seen = new Set<string>();
  let result: StyleChainResult | undefined;
  for (let id: string | null = styleId; id !== null;) {
    if (seen.has(id)) {
      result = fail(
        'style_cycle',
        styleId,
        path,
        `the basedOn chain of "${styleId}" loops at "${id}"`,
      );
      break;
    }
    if (path.length === MAX_CHAIN) {
      result = fail(
        'style_chain_too_long',
        styleId,
        path,
        `the basedOn chain of "${styleId}" is longer than ${MAX_CHAIN} styles`,
      );
      break;
    }
    const style = table.styles.get(id);
    if (!style) {
      result = fail('style_missing', styleId, path, `style "${id}" does not exist`);
      break;
    }
    seen.add(id);
    path.push(id);
    const parent = style['basedOn'];
    id = typeof parent === 'string' ? parent : null;
  }
  result ??= { ok: true, chain: Object.freeze(path.slice().reverse()) };
  byId.set(styleId, result);
  return result;
}

function fail(
  code: CascadeErrorCode,
  styleId: string,
  chain: readonly string[],
  message: string,
): StyleChainResult {
  return { ok: false, error: Object.freeze({ code, styleId, chain: [...chain], message }) };
}
