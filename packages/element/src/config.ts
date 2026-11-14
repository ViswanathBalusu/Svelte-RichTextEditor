/**
 * The `config` property (05 §8.1; PRO-081). 05 names only its categories (feature switches, fonts,
 * shortcuts, limits, a style nonce); this release reads the keys below and ignores every other key
 * (PRO-005). The set and its JSON Schema are PRO-081's (phase 1b).
 */
export interface DocEditorConfig {
  /** Nonce for the `<style>` element the component creates when constructable stylesheets fail (02 §3). */
  styleNonce?: string;
  /** Grace period before a disconnected editor destroys itself, in milliseconds (02 §2.1; default 30,000). */
  graceMs?: number;
  /** URL of the PDF viewer's page (FE-071). Default: `viewer/pdf-viewer.html` next to the module. */
  pdfViewerUrl?: string;
  /**
   * Where the shadow root's `getSelection` comes from (02 §8; spike S1 §4.7). `instance` (default)
   * defines it on the editor's own root; `library` lets ProseMirror patch `ShadowRoot.prototype`.
   */
  selectionShim?: 'instance' | 'library';
  /** Experimental, for spike evidence only: the footnote content model (03 §13; CDM-001). */
  footnoteModel?: 'inline' | 'paragraph';
  /** Experimental, for spike evidence only: defer remote commits during composition (default true). */
  deferRemoteWhileComposing?: boolean;
  /** Experimental, for spike evidence only: use the nonce `<style>` even where adoption works. */
  forceStyleFallback?: boolean;
  /** Draws page guides in the web view where the last compile started a page (FE-068). Default off. */
  pageGuides?: boolean;
}

export interface NormalConfig {
  styleNonce: string | null;
  graceMs: number;
  pdfViewerUrl: string | null;
  selectionShim: 'instance' | 'library';
  footnoteModel: 'inline' | 'paragraph';
  deferRemoteWhileComposing: boolean;
  forceStyleFallback: boolean;
  /** Page guides in the web view (FE-068). Only the boolean `true` turns them on. */
  pageGuides: boolean;
}

/** 02 §2.1: "after a grace period (default 30 seconds)". */
export const DEFAULT_GRACE_MS = 30_000;

/** Reads the known keys with their types; anything else, or a value of the wrong type, is ignored. */
export function normaliseConfig(value: unknown): NormalConfig {
  const v = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const text = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? x : null);
  const flag = (x: unknown, otherwise: boolean): boolean =>
    typeof x === 'boolean' ? x : otherwise;
  const grace = v['graceMs'];
  return {
    styleNonce: text(v['styleNonce']),
    graceMs:
      typeof grace === 'number' && Number.isFinite(grace) && grace >= 0 ? grace : DEFAULT_GRACE_MS,
    pdfViewerUrl: text(v['pdfViewerUrl']),
    selectionShim: v['selectionShim'] === 'library' ? 'library' : 'instance',
    // The CDM's footnote content is `paragraph+` (CDM-001); `inline` is the spike's option A.
    footnoteModel: v['footnoteModel'] === 'inline' ? 'inline' : 'paragraph',
    deferRemoteWhileComposing: flag(v['deferRemoteWhileComposing'], true),
    forceStyleFallback: flag(v['forceStyleFallback'], false),
    pageGuides: v['pageGuides'] === true,
  };
}
