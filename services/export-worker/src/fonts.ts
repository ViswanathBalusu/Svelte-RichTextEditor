/**
 * The font manifest of the worker image (09 §5; S4 §2): `fonts.json`, written at build time by
 * image/fonts.lua next to the hash-named font files the sandbox reads. The converter needs it to
 * name font files by hash, so the worker reads it once from the image it compiles with.
 */
import type { FontManifest } from '@docedit/export-latex';
import { podman } from './container.ts';
import { IMAGE } from './sandbox.ts';

const manifests = new Map<string, Promise<FontManifest>>();

function parse(text: string): FontManifest {
  const j = JSON.parse(text) as FontManifest;
  const face = (f: unknown) =>
    !!f &&
    typeof f === 'object' &&
    /^[0-9a-f]{64}\.(ttf|otf|ttc|otc)$/.test(String((f as { file?: unknown }).file)) &&
    /^[0-9a-f]{64}$/.test(String((f as { sha256?: unknown }).sha256));
  if (
    j?.version !== 1 ||
    !Array.isArray(j.families) ||
    j.families.length === 0 ||
    !j.families.every(
      (f) => face(f.regular) && face(f.bold) && face(f.italic) && face(f.boldItalic),
    ) ||
    !face(j.math)
  )
    throw new Error('the image has no valid font manifest');
  return j;
}

/** The font manifest baked into `image` (cached per process). */
export function imageFontManifest(image = IMAGE): Promise<FontManifest> {
  let p = manifests.get(image);
  if (!p) {
    p = (async () => {
      const r = await podman(
        [
          'run',
          '--rm',
          '--network=none',
          '--read-only',
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          '--user=10001:10001',
          '--entrypoint=cat',
          image,
          '/opt/docedit/fonts/fonts.json',
        ],
        // 180 s: on a loaded Podman machine a `podman run` took 80 to 100 s (sandbox-ready.ts).
        { timeoutMs: 180_000, maxStdoutBytes: 1024 * 1024 },
      );
      if (r.code !== 0)
        throw new Error(`cannot read the font manifest of ${image}: ${r.stderr.slice(0, 500)}`);
      return parse(new TextDecoder().decode(r.stdout));
    })();
    manifests.set(image, p);
    p.catch(() => manifests.delete(image));
  }
  return p;
}
