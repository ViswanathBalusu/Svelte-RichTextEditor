/**
 * The font files the layout kernel is asked to hold (WASM-005; 02 §3, §6). The kernel loads exactly
 * the files the editor registers with the FontFace API and the LaTeX workers load: the manifest's
 * URL for each, under the alias the editor already derives from the file's hash. This module turns
 * the manifest's files into the kernel's requests. It reads no browser global.
 *
 * Loading is on demand: the caller names the aliases a document uses (`used`), so a CJK face that no
 * block uses is never fetched. Platform fonts and a tenant's own fonts come through the same
 * manifest; the owner says which they are.
 */
import type { FaceRequest } from '@docedit/layout-kernel';
import { fontAlias, type FontFileEntry } from './font-registration.ts';

/** The owner of the platform's own fonts. */
export const PLATFORM_FONTS = '';

/** The owner a tenant's own fonts are held for. A tenant's faces are never given to another owner. */
export function tenantFonts(tenantId: string): string {
  return `tenant:${tenantId}`;
}

/**
 * The kernel's requests for these manifest files, in the manifest's order. With `used`, only the
 * files whose alias is in it; a file listed twice is asked for once.
 */
export function kernelFaceRequests(
  files: readonly FontFileEntry[],
  used?: ReadonlySet<string>,
): FaceRequest[] {
  const seen = new Set<string>();
  const out: FaceRequest[] = [];
  for (const file of files) {
    const alias = fontAlias(file.hash);
    if (seen.has(alias) || (used !== undefined && !used.has(alias))) continue;
    seen.add(alias);
    out.push({ alias, url: file.url, hash: file.hash });
  }
  return out;
}
