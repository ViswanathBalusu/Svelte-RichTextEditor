/**
 * The clipboard form of a CDM fragment (FE-050, FE-051, FE-052; 03 §4.1, §9). Copying writes
 * `text/html` that carries the fragment as JSON inside a `data-` attribute, and `text/plain`. No
 * custom clipboard format is used: browsers of one family accept only the standard types (review F15).
 *
 * - A pasted fragment is used in preference to HTML and plain text (FE-051 criterion 1).
 * - HTML that carries no fragment is not parsed here: the plain text is used instead (FE-052
 *   criterion 3, before FE-054 adds HTML paste).
 * - The HTML a copy writes shows the text and its basic structure (paragraphs, headings from the
 *   style's outline level, bold and italic). Every text node is escaped, and the HTML has no script
 *   and no attribute other than the fragment's (FE-050 criterion 5).
 *
 * This module is plain TypeScript with no DOM: the fragment is read back with a pattern match on
 * the encoded attribute, so it runs under Node.js (FE-121).
 */
import { UUID7_PATTERN } from '@docedit/model';
import { CDM1, isRedactionMarker, type JsonValue } from '@docedit/model/definition';
import type { CdmFragment, CdmJsonNode } from './cdm-fragment.ts';
import type { PastedImage } from './image-paste.ts';

/** The attribute that carries the fragment in the copied HTML. Its value is `encodeURIComponent` of the JSON. */
export const FRAGMENT_ATTRIBUTE = 'data-docedit-fragment';

/** What a copy writes: the two standard types and nothing else. */
export interface ClipboardPayload {
  readonly 'text/html': string;
  readonly 'text/plain': string;
}

/** The outcome of a cut: what was written to the clipboard, and whether the selection was deleted. */
export interface CutResult {
  readonly payload: ClipboardPayload | null;
  readonly deleted: boolean;
}

/** What a paste receives from the clipboard (the web view reads these from the browser event). */
export interface ClipboardInput {
  readonly html?: string | undefined;
  readonly text?: string | undefined;
  /** Picture files on the clipboard, read into bytes (FE-053). Other files are not passed. */
  readonly files?: readonly PastedImage[] | undefined;
  /**
   * The fragment the view read from the HTML through the whitelist (FE-054), or null when the HTML
   * holds nothing the editor takes. Absent when the caller passes no HTML view (the HTML is then
   * ignored, as before FE-054).
   */
  readonly foreign?: CdmFragment | null | undefined;
  /**
   * The `data:` URI pictures the view read from the same HTML (FE-054 criterion 6). Absent when the
   * caller passes no HTML view, as `foreign`.
   */
  readonly htmlPictures?: readonly PastedImage[] | undefined;
}

/**
 * The paste that applies: a fragment (with the pictures that came with it, if any), plain text,
 * pictures, or nothing this editor takes.
 */
export type PasteChoice =
  | {
      readonly kind: 'fragment';
      readonly fragment: CdmFragment;
      readonly pictures?: readonly PastedImage[];
    }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'images'; readonly images: readonly PastedImage[] }
  | { readonly kind: 'none' };

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text for HTML element content. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** Node types that sit inside a block's line of text rather than being blocks themselves. */
const INLINE_TYPES = new Set([
  'text',
  'anchor',
  'citation',
  'form_field',
  'extension_inline',
  'preserved_inline',
  'field',
  'hard_break',
]);

/** Whether a CDM node is a block (not inline content). */
function isBlock(node: CdmJsonNode): boolean {
  return !INLINE_TYPES.has(node.type);
}

/** The plain text of a fragment: one line per block, the text of its inline content. */
export function plainTextOf(content: readonly CdmJsonNode[]): string {
  const lines: string[] = [];
  const inline = (node: CdmJsonNode): string => {
    if (node.type === 'text') return node.text ?? '';
    if (node.content) return node.content.map(inline).join('');
    const fallback = node.attrs?.['fallbackText'];
    return typeof fallback === 'string' ? fallback : '';
  };
  const block = (node: CdmJsonNode): void => {
    const hasBlockChildren = (node.content ?? []).some(isBlock);
    if (!hasBlockChildren) lines.push(inline(node));
    else for (const child of node.content ?? []) block(child);
  };
  for (const node of content) block(node);
  return lines.join('\n');
}

/** The HTML that shows a fragment's text and structure, with every text node escaped. */
export function structureHtml(fragment: CdmFragment): string {
  const outline = new Map<string, number>();
  for (const def of fragment.defs) {
    const id = def.attrs?.['id'];
    const level = def.attrs?.['outlineLevel'];
    if (typeof id === 'string' && typeof level === 'number' && level >= 1 && level <= 6)
      outline.set(id, level);
  }
  const inline = (node: CdmJsonNode): string => {
    if (node.type === 'text') {
      let out = escapeHtml(node.text ?? '');
      for (const mark of node.marks ?? []) {
        if (mark.type === 'bold') out = `<strong>${out}</strong>`;
        else if (mark.type === 'italic') out = `<em>${out}</em>`;
      }
      return out;
    }
    if (node.content) return node.content.map(inline).join('');
    const fallback = node.attrs?.['fallbackText'];
    return typeof fallback === 'string' ? escapeHtml(fallback) : '';
  };
  const block = (node: CdmJsonNode): string => {
    const hasBlockChildren = (node.content ?? []).some(isBlock);
    if (hasBlockChildren) return (node.content ?? []).map(block).join('');
    if (node.type !== 'paragraph') return `<p>${inline(node)}</p>`;
    const style = node.attrs?.['style'];
    const level = typeof style === 'string' ? outline.get(style) : undefined;
    const tag = level === undefined ? 'p' : `h${level}`;
    return `<${tag}>${inline(node)}</${tag}>`;
  };
  return fragment.content.map(block).join('');
}

/** The clipboard payload of a fragment: `text/html` with the fragment inside, and `text/plain`. */
export function clipboardPayload(fragment: CdmFragment): ClipboardPayload {
  const json = encodeURIComponent(JSON.stringify(fragment));
  return {
    'text/html': `<div ${FRAGMENT_ATTRIBUTE}="${json}">${structureHtml(fragment)}</div>`,
    'text/plain': plainTextOf(fragment.content),
  };
}

/** The shape a pasted fragment must have before any of its content is looked at. */
function isFragmentShape(value: unknown): value is CdmFragment {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['cdm'] === 'number' &&
    Array.isArray(v['requires']) &&
    v['requires'].every((r) => typeof r === 'string') &&
    Array.isArray(v['defs']) &&
    Array.isArray(v['content']) &&
    typeof v['openStart'] === 'number' &&
    typeof v['openEnd'] === 'number'
  );
}

/** Reads the fragment back from copied HTML, or null when the HTML carries none this editor can read. */
export function fragmentFromHtml(html: string): CdmFragment | null {
  const match = new RegExp(`${FRAGMENT_ATTRIBUTE}="([^"]*)"`).exec(html);
  if (!match) return null;
  let value: unknown;
  try {
    value = JSON.parse(decodeURIComponent(match[1] ?? ''));
  } catch {
    return null;
  }
  return isFragmentShape(value) ? value : null;
}

/**
 * The paste that applies to clipboard data (FE-051 criterion 1, FE-052 criteria 1 and 3, FE-053):
 * an embedded fragment first, then the HTML the view read through the whitelist (FE-054), then plain
 * text, then picture files. HTML the view did not read is ignored, so its text is used and its
 * pictures, `data:` URIs included, are never taken in.
 *
 * Text comes before pictures because a word processor puts a picture of the copied text on the
 * clipboard beside the text itself; a picture copied on its own comes with no plain text.
 */
export function chooseClipboard(data: ClipboardInput): PasteChoice {
  const fragment = data.html ? fragmentFromHtml(data.html) : null;
  if (fragment) return { kind: 'fragment', fragment };
  const htmlPictures = data.htmlPictures ?? [];
  if (data.foreign)
    return {
      kind: 'fragment',
      fragment: data.foreign,
      ...(htmlPictures.length > 0 ? { pictures: htmlPictures } : {}),
    };
  // HTML with pictures and no text (a picture copied from a page): the pictures are the paste.
  if (htmlPictures.length > 0 && !data.text) return { kind: 'images', images: htmlPictures };
  if (data.text) return { kind: 'text', text: data.text };
  const images = (data.files ?? []).filter((f) => f.mime.startsWith('image/'));
  if (images.length > 0) return { kind: 'images', images };
  return { kind: 'none' };
}

/** The CDM attributes that name an asset, by node type: never embedded data (03 §4.4; 10 §3.1). */
const ASSET_ATTRIBUTES: ReadonlyMap<string, readonly string[]> = (() => {
  const out = new Map<string, string[]>();
  for (const node of CDM1.nodes) {
    for (const [name, def] of Object.entries(node.attrs)) {
      const g = def.grammar;
      if (g.kind === 'ref' && g.to === 'asset')
        out.set(node.name, [...(out.get(node.name) ?? []), name]);
    }
  }
  return out;
})();

const ASSET_ID = new RegExp(UUID7_PATTERN);

/**
 * The content of a pasted fragment without the nodes whose asset attribute holds anything but an
 * asset identifier (FE-053 criterion 2; 10 §3.1: images are never embedded as data). A fragment made
 * by hand, or by another program, could carry a `data:` URI there; such a node is dropped whole (a
 * figure's caption cannot stand without its figure). A null value stays where the CDM allows it.
 */
export function withoutEmbeddedData(content: readonly CdmJsonNode[]): CdmJsonNode[] {
  const out: CdmJsonNode[] = [];
  for (const node of content) {
    const names = ASSET_ATTRIBUTES.get(node.type) ?? [];
    const embedded = names.some((name) => {
      const value = node.attrs?.[name];
      return (
        value !== undefined &&
        value !== null &&
        !(typeof value === 'string' && ASSET_ID.test(value))
      );
    });
    if (embedded) continue;
    const copy: CdmJsonNode = { ...node };
    if (node.content) copy.content = withoutEmbeddedData(node.content);
    out.push(copy);
  }
  return out;
}

/**
 * The content of a pasted fragment without the node types a foreign source may not bring in (FE-051
 * criteria 2 and 5), at any depth. A dropped node that has content (a region) is replaced by its
 * children, so its text stays; a dropped atom (a bookmark) leaves nothing. Identifiers are replaced
 * by the insertion itself (03 §9).
 */
export function withoutNodeTypes(
  content: readonly CdmJsonNode[],
  types: ReadonlySet<string>,
): CdmJsonNode[] {
  const out: CdmJsonNode[] = [];
  for (const node of content) {
    const kept = node.content ? withoutNodeTypes(node.content, types) : undefined;
    if (types.has(node.type)) {
      out.push(...(kept ?? []));
      continue;
    }
    const copy: CdmJsonNode = { ...node };
    if (kept) copy.content = kept;
    out.push(copy);
  }
  return out;
}

/**
 * What stops a copy of content (FE-141 criterion 3; ADR 0019, "What a reader may not send"): a
 * placeholder of a hidden region, or a redacted value, at any depth. The copy is refused as a whole
 * and nothing is written in its place, so neither is copied.
 */
export function copyRefusal(content: readonly CdmJsonNode[]): 'placeholder' | 'redacted' | null {
  for (const node of content) {
    if (node.type === 'hidden_region') return 'placeholder';
    for (const value of Object.values(node.attrs ?? {})) {
      if (isRedactionMarker(value as JsonValue | undefined)) return 'redacted';
    }
    if (node.content) {
      const inner = copyRefusal(node.content);
      if (inner) return inner;
    }
  }
  return null;
}
