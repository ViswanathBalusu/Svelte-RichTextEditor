/**
 * The assets port the editing core uses for pasted pictures (FE-053; 05 §6.2; 10 §3.1), built on the
 * backend's `assets` port. The core hands over the picture's name, type and bytes; this adapter
 * uploads them to quarantine through `upload` (create, transfer, complete, wait for `asset.ready`)
 * and answers with the asset identifier and the display size in twips.
 *
 * - The display size is the picture's own size in pixels at 96 pixels to the inch (15 twips to the
 *   pixel), scaled down to fit the `image` node's limit of 31,680 twips a side (I7) with its aspect
 *   kept. The size is read from the file's header (PNG, GIF, JPEG, WebP). The asset service reports
 *   no size (`AssetUpload`, `asset.ready`), and the editor does not decode the picture itself, since
 *   the asset worker validates and re-encodes it (10 §3.1). A picture whose size cannot be read is
 *   refused before anything is uploaded, with a message the shell can show.
 * - A rejection by the asset service (`asset.failed`) or a failed transfer is returned as a message,
 *   never thrown, so the core inserts nothing and says why.
 *
 * Which picture types the service accepts is its own rule; this module does not filter by type.
 */
import type { AssetsPort as BackendAssetsPort, QuotaKind } from '@docedit/protocol';
import { quotaOf } from './errors.ts';
import type {
  AssetImage,
  AssetImageLookup,
  AssetsPort,
  PastedImage,
  UploadOutcome,
} from '@docedit/engine';

/** Twips per CSS pixel at 96 pixels to the inch. */
export const TWIPS_PER_PIXEL = 15;
/** The largest side of an `image` node, in twips (I7). */
export const IMAGE_SIDE_MAX_TWIPS = 31680;

/** The width and height in pixels of a PNG, GIF, JPEG or WebP file, or null. */
export function pixelSize(bytes: Uint8Array): { width: number; height: number } | null {
  const at = (i: number): number => bytes[i] ?? -1;
  const be16 = (i: number): number => (at(i) << 8) | at(i + 1);
  const le16 = (i: number): number => at(i) | (at(i + 1) << 8);
  const be32 = (i: number): number => ((at(i) << 24) >>> 0) + (at(i + 1) << 16) + be16(i + 2);
  const ascii = (i: number, n: number): string =>
    String.fromCharCode(...Array.from(bytes.subarray(i, i + n)));
  const ok = (width: number, height: number) =>
    width > 0 && height > 0 ? { width, height } : null;

  if (bytes.length >= 24 && at(0) === 0x89 && ascii(1, 3) === 'PNG' && ascii(12, 4) === 'IHDR')
    return ok(be32(16), be32(20));
  if (bytes.length >= 10 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a'))
    return ok(le16(6), le16(8));
  if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8 ') return ok(le16(26) & 0x3fff, le16(28) & 0x3fff);
    if (chunk === 'VP8L') {
      const b = (i: number) => at(21 + i);
      return ok(
        1 + (((b(1) & 0x3f) << 8) | b(0)),
        1 + (((b(3) & 0xf) << 10) | (b(2) << 2) | ((b(1) & 0xc0) >> 6)),
      );
    }
    if (chunk === 'VP8X') {
      const le24 = (i: number) => at(i) | (at(i + 1) << 8) | (at(i + 2) << 16);
      return ok(1 + le24(24), 1 + le24(27));
    }
    return null;
  }
  if (bytes.length >= 4 && at(0) === 0xff && at(1) === 0xd8) {
    // JPEG: walk the markers to the first start-of-frame (SOF0 to SOF15, not DHT, JPG or DAC).
    let i = 2;
    while (i + 9 < bytes.length) {
      if (at(i) !== 0xff) return null;
      const marker = at(i + 1);
      if (marker === 0xff) {
        i++;
        continue;
      }
      const length = be16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return ok(be16(i + 7), be16(i + 5));
      if (length < 2) return null;
      i += 2 + length;
    }
  }
  return null;
}

/** The display size in twips of a picture of `width` by `height` pixels (see the module comment). */
export function displayTwips(
  width: number,
  height: number,
): { widthTwips: number; heightTwips: number } {
  const w = width * TWIPS_PER_PIXEL;
  const h = height * TWIPS_PER_PIXEL;
  const scale = Math.min(1, IMAGE_SIDE_MAX_TWIPS / w, IMAGE_SIDE_MAX_TWIPS / h);
  return {
    widthTwips: Math.max(1, Math.min(IMAGE_SIDE_MAX_TWIPS, Math.round(w * scale))),
    heightTwips: Math.max(1, Math.min(IMAGE_SIDE_MAX_TWIPS, Math.round(h * scale))),
  };
}

/**
 * The lookup the web view draws pictures with (FE-067 criterion 3): the signed URL and content type
 * of an asset, from `POST /documents/{id}/assets/resolve`. Each asset is asked once while its URL
 * is valid; a refusal or a failure answers `undefined` and is asked again at the next draw. The URL
 * is checked by the view (`imageSource` in the engine), not here.
 */
export function assetImageLookup(
  port: BackendAssetsPort,
  docId: string,
  now: () => number = Date.now,
): AssetImageLookup {
  const cache = new Map<string, { until: number; answer: Promise<AssetImage | undefined> }>();
  return (assetId) => {
    const hit = cache.get(assetId);
    if (hit && hit.until > now()) return hit.answer;
    const answer = port
      .resolve(docId, [assetId])
      .then((body) => {
        const found = body.assets.find((a) => a.asset === assetId);
        if (!found) return undefined;
        // Keep the answer until a minute before the URL expires; an unreadable date is not kept.
        const expires = Date.parse(found.expiresAt);
        cache.set(assetId, { until: Number.isNaN(expires) ? 0 : expires - 60_000, answer });
        return { url: found.url, contentType: found.contentType };
      })
      .catch(() => undefined);
    return answer;
  };
}

/** The kinds of quota the service names (05 §5.8; owner decision 110). */
const QUOTA_KINDS: readonly QuotaKind[] = [
  'connections',
  'openDocuments',
  'commitRate',
  'roomCpuBudget',
  'storage',
  'exportConcurrency',
  'exportMinutes',
  'bulkSendRows',
];

/** The engine's assets port over the backend's, for the document `docId`. */
export function pictureAssets(port: BackendAssetsPort, docId: string): AssetsPort {
  return {
    async upload(image: PastedImage): Promise<UploadOutcome> {
      const size = pixelSize(image.bytes);
      if (size === null)
        return { ok: false, message: 'The size of the picture could not be read.' };
      const bytes = image.bytes;
      const source = {
        size: bytes.byteLength,
        type: image.mime,
        arrayBuffer: () =>
          Promise.resolve(
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer,
          ),
      };
      try {
        const { asset } = await port.upload(docId, { filename: image.name, source });
        return { ok: true, image: { asset, ...displayTwips(size.width, size.height) } };
      } catch (e) {
        const message =
          e instanceof Error && e.message ? e.message : 'The picture was not accepted.';
        const named = quotaOf(e);
        const quota = QUOTA_KINDS.find((k) => k === named);
        return { ok: false, message, ...(quota === undefined ? {} : { quota }) };
      }
    },
  };
}
