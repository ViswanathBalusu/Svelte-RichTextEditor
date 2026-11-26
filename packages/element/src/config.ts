import {
  ALL_FEATURES_ON,
  FEATURE_GROUPS,
  type FeatureGroup,
  type FeatureSwitches,
} from './feature-switches.ts';

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
   * The directory, ending in /, that the host serves KaTeX's .woff2 files from (FE-069 criterion 3).
   * The editor registers them under hash aliases. Absent by default: no KaTeX font is registered and
   * equations are drawn with the page's fallback fonts. The editor has no default location.
   */
  katexFontsUrl?: string;
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
  /**
   * `view="read"` shows the layout engine's own read-only pages instead of the typeset PDF (FE-095;
   * 02 section 7). Default off: the PDF read view stays the default (docs/adr/0435-w1-FE-095-read-view-renderer.md,
   * proposed). Where the browser cannot offer the page view, the PDF read view is shown as before.
   */
  readPages?: boolean;
  /**
   * Feature switches (PRO-081; owner decision 89). Each group is on unless its key is `false`: `comments`
   * (comments and suggestions), `export` (export and print), `history` and `assistant` (assistant and
   * proofing). A group that is off has no controls when the editor loads. It is not a permission.
   */
  features?: { [G in FeatureGroup]?: boolean };
}

export interface NormalConfig {
  styleNonce: string | null;
  graceMs: number;
  pdfViewerUrl: string | null;
  katexFontsUrl: string | null;
  selectionShim: 'instance' | 'library';
  footnoteModel: 'inline' | 'paragraph';
  deferRemoteWhileComposing: boolean;
  forceStyleFallback: boolean;
  /** Page guides in the web view (FE-068). Only the boolean `true` turns them on. */
  pageGuides: boolean;
  /** Painted read-only pages for `view="read"` (FE-095). Only the boolean `true` turns them on. */
  readPages: boolean;
  /** Which feature groups are on (every group by default). */
  features: FeatureSwitches;
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
    katexFontsUrl: text(v['katexFontsUrl']),
    selectionShim: v['selectionShim'] === 'library' ? 'library' : 'instance',
    // The CDM's footnote content is `paragraph+` (CDM-001); `inline` is the spike's option A.
    footnoteModel: v['footnoteModel'] === 'inline' ? 'inline' : 'paragraph',
    deferRemoteWhileComposing: flag(v['deferRemoteWhileComposing'], true),
    forceStyleFallback: flag(v['forceStyleFallback'], false),
    pageGuides: v['pageGuides'] === true,
    readPages: v['readPages'] === true,
    features: normaliseFeatures(v['features']),
  };
}

/** Reads the `features` switches: only the boolean `false` of a known group switches it off. */
function normaliseFeatures(value: unknown): FeatureSwitches {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return { ...ALL_FEATURES_ON };
  const own = value as Record<string, unknown>;
  const out = { ...ALL_FEATURES_ON };
  for (const group of FEATURE_GROUPS)
    if (Object.hasOwn(own, group) && own[group] === false) out[group] = false;
  return out;
}
