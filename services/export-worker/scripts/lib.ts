/**
 * Shared helpers of the worker's scripts (spike S4).
 */
import type { FontManifest } from '@docedit/export-latex';
import { imageFontManifest } from '../src/fonts.ts';
import { IMAGE } from '../src/sandbox.ts';
import { sandboxReady } from '../src/sandbox-ready.ts';

/**
 * The font manifest baked into the image at build time (image/fonts.lua). The sandbox readiness
 * check runs first, so that the route that can start containers here is the one used.
 */
export async function fontManifestFromImage(image = IMAGE): Promise<FontManifest> {
  const ready = await sandboxReady();
  if (!ready.ok) throw new Error(`the sandbox is not ready: ${ready.reason}`);
  return imageFontManifest(image);
}
