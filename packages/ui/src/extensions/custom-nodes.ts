/**
 * Custom blocks and inline content (UX-056, UX-057; 03 sections 4, 5 and 10; 13 section 7.3) and the
 * fallback a reader sees when the extension is not available (UX-058).
 *
 * - `checkBlockInsert` and `checkInlineInsert` decide, before a node is sent, whether a draft may be
 *   inserted. They create nothing: the core builds the node. The authority checks the envelope again
 *   under I12, so this check is the first gate and not the only one.
 * - The block payload limit is 16 KiB (03 section 4). It is measured as the UTF-8 bytes of the JSON
 *   text. The canonical form of 03 section 11 is not used, because this package does not depend on
 *   `@docedit/model`; the core must measure the canonical form before it sends (ADR 0136).
 * - No limit is applied to an inline payload: 13 section 7.3 says "a size limit" and gives no number
 *   (ADR 0136).
 * - A fallback is present when its text, or its asset identifier, is not empty after trimming. An
 *   empty text is treated as no fallback (ADR 0136, proposed).
 * - `resolveExtensionNode` decides what a reader sees for a node. It does not change the node, and
 *   the view it returns has no field for the payload, so the raw payload is never shown from a view.
 *   The node has no version attribute in 03, so availability is decided by the extension identifier
 *   alone (ADR 0136).
 */

/** The most bytes of JSON a block payload may hold (03 section 4; I12). */
export const BLOCK_PAYLOAD_LIMIT_BYTES = 16 * 1024;

export interface BlockDraft {
  /** The extension identifier the block belongs to. */
  readonly extension: string;
  /** The payload, which the editor never interprets. */
  readonly payload: unknown;
  /** The fallback picture's asset identifier, or null. */
  readonly fallbackAsset: string | null;
  /** The fallback text, or null. */
  readonly fallbackText: string | null;
}

export interface InlineDraft {
  readonly extension: string;
  readonly payload: unknown;
  /** Mandatory for inline content (03 section 5). */
  readonly fallbackText: string | null;
}

export type InsertRefusal =
  'no-extension' | 'payload-not-json' | 'payload-too-large' | 'no-fallback' | 'no-fallback-text';

/** `payloadBytes` is null when the payload is not JSON, and the measured size otherwise. */
export type InsertCheck =
  | { readonly ok: true; readonly payloadBytes: number | null }
  | { readonly ok: false; readonly reason: InsertRefusal; readonly payloadBytes: number | null };

/** The UTF-8 size of a payload's JSON text, or null when it has no JSON form. */
export function payloadBytes(payload: unknown): number | null {
  let json: string | undefined;
  try {
    json = JSON.stringify(payload);
  } catch {
    return null;
  }
  if (json === undefined) return null;
  return new TextEncoder().encode(json).byteLength;
}

function hasText(value: string | null): boolean {
  return value !== null && value.trim() !== '';
}

function hasExtension(extension: string): boolean {
  return extension.trim() !== '';
}

/** Decides whether a block may be inserted and sent (UX-056, criteria 1 and 2, the editor's part). */
export function checkBlockInsert(draft: BlockDraft): InsertCheck {
  if (!hasExtension(draft.extension))
    return { ok: false, reason: 'no-extension', payloadBytes: null };
  const bytes = payloadBytes(draft.payload);
  if (bytes === null) return { ok: false, reason: 'payload-not-json', payloadBytes: null };
  if (!hasText(draft.fallbackAsset) && !hasText(draft.fallbackText))
    return { ok: false, reason: 'no-fallback', payloadBytes: bytes };
  if (bytes > BLOCK_PAYLOAD_LIMIT_BYTES)
    return { ok: false, reason: 'payload-too-large', payloadBytes: bytes };
  return { ok: true, payloadBytes: bytes };
}

/** Decides whether inline content may be inserted and sent (UX-057, criterion 1, the editor's part). */
export function checkInlineInsert(draft: InlineDraft): InsertCheck {
  if (!hasExtension(draft.extension))
    return { ok: false, reason: 'no-extension', payloadBytes: null };
  const bytes = payloadBytes(draft.payload);
  if (bytes === null) return { ok: false, reason: 'payload-not-json', payloadBytes: null };
  if (!hasText(draft.fallbackText))
    return { ok: false, reason: 'no-fallback-text', payloadBytes: bytes };
  return { ok: true, payloadBytes: bytes };
}

/** A node of an extension as it is stored; inline nodes have no fallback asset. */
export interface ExtensionNode {
  readonly type: 'extension_block' | 'extension_inline';
  readonly extension: string;
  readonly payload: unknown;
  readonly fallbackAsset: string | null;
  readonly fallbackText: string | null;
}

/**
 * What a reader sees for a node. The `extension` view is the node drawn by its extension. The
 * `fallback` view is what is drawn when the extension is not available here; it carries no payload.
 */
export type NodeView =
  | { readonly kind: 'extension'; readonly extension: string }
  | {
      readonly kind: 'fallback';
      readonly reason: 'not-available';
      readonly extension: string;
      readonly asset: string | null;
      readonly text: string | null;
    };

/**
 * Resolves a node against the identifiers of the extensions available to this reader (UX-058). The
 * node is read and never changed.
 */
export function resolveExtensionNode(
  node: ExtensionNode,
  available: ReadonlySet<string>,
): NodeView {
  if (available.has(node.extension)) return { kind: 'extension', extension: node.extension };
  return {
    kind: 'fallback',
    reason: 'not-available',
    extension: node.extension,
    asset: node.fallbackAsset,
    text: node.fallbackText,
  };
}
