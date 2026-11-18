/**
 * Which URL a picture may be drawn from (FE-067 criterion 3; 10 §3.1; 02 §3).
 *
 * The `image` node holds an asset identifier, never data (03 §2). The web view asks the backend for
 * a signed URL (`POST /documents/{id}/assets/resolve`) and draws an `<img>` only when the answer is
 * safe: an `http` or `https` URL, and a raster content type. A `data:`, `blob:`, `javascript:` or
 * `file:` URL is never drawn, and an SVG asset is never drawn at all (an SVG is converted to PDF on
 * upload, 09 §4, and a live SVG can carry script), so the node keeps its placeholder.
 *
 * No DOM and no browser global is read here, so the headless core can carry the type.
 */

/** What the backend says about one asset: a signed URL and the type the service stored. */
export interface AssetImage {
  readonly url: string;
  readonly contentType: string;
}

/** Looks an asset up; `undefined` when it cannot be resolved. Read when a picture is drawn. */
export type AssetImageLookup = (assetId: string) => Promise<AssetImage | undefined>;

/** The content types a picture is drawn from. SVG and PDF are not in the list. */
export const RASTER_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** The URL to draw, or `undefined` when the answer is not one a picture may be drawn from. */
export function imageSource(answer: unknown): string | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined;
  const { url, contentType } = answer as { url?: unknown; contentType?: unknown };
  if (typeof url !== 'string' || typeof contentType !== 'string') return undefined;
  // The type may carry parameters ("image/png; charset=binary"); only the media type counts.
  const type = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  if (!RASTER_IMAGE_TYPES.has(type)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  // A URL with credentials is a phishing shape and never a signed asset URL.
  if (parsed.username !== '' || parsed.password !== '') return undefined;
  return parsed.href;
}
