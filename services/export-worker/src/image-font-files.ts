/**
 * The font files of a job, checked where the sandbox reads them: in the worker image, at
 * /opt/docedit/fonts (09 §5; S4 §2; EXP-047 criterion 2). font-files.ts checks a directory on the
 * host; the worker has none, because the files are baked into the image next to `fonts.json`.
 * This check runs `sha256sum` inside the image over every face the manifest names, with the
 * sandbox's read-only, no-network, no-capability flags, and reports each face whose file is absent
 * (`font_file_missing`) or whose bytes hash to another value (`font_file_mismatch`). The job then
 * fails before conversion and no other font is put in its place (job.ts).
 *
 * The image is immutable while the worker runs (its manifest is read once, fonts.ts), so the result
 * is kept per image and set of faces; a failed Podman call is not kept.
 */
import type { FontManifest } from '@docedit/export-latex';
import { podman } from './container.ts';
import { manifestFaces, type FontFileCheck, type FontFileProblem } from './font-files.ts';
import { IMAGE } from './sandbox.ts';

/** Where the image keeps its hash-named font files (Containerfile; image/fonts.lua). */
export const IMAGE_FONT_DIR = '/opt/docedit/fonts';

/** A face file is a hash name with a font extension; nothing else is passed to the container. */
const FONT_FILE = /^[0-9a-f]{64}\.(ttf|otf|ttc|otc)$/;

const checks = new Map<string, Promise<FontFileCheck>>();

async function runCheck(manifest: FontManifest, image: string): Promise<FontFileCheck> {
  const faces = manifestFaces(manifest);
  const problems: FontFileProblem[] = [];
  const problem = (code: FontFileProblem['code'], f: (typeof faces)[number]): FontFileProblem => ({
    code,
    family: f.family,
    face: f.face,
    file: f.file,
    expectedSha256: f.sha256,
  });
  const named = faces.filter((f) => FONT_FILE.test(f.file));
  // A face whose file is not a hash name cannot be a file of the image's font directory.
  for (const f of faces)
    if (!FONT_FILE.test(f.file)) problems.push(problem('font_file_missing', f));
  if (named.length > 0) {
    const r = await podman(
      [
        'run',
        '--rm',
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--user=10001:10001',
        '--entrypoint=sha256sum',
        image,
        ...named.map((f) => `${IMAGE_FONT_DIR}/${f.file}`),
      ],
      { timeoutMs: 180_000, maxStdoutBytes: 1024 * 1024 },
    );
    // sha256sum exits 1 when a file cannot be read and still prints the others; any other exit
    // (125 to 127 are Podman's own) means the check did not run, which is not a font diagnostic.
    if (r.timedOut || r.stdoutOverflow || (r.code !== 0 && r.code !== 1))
      throw new Error(
        `cannot check the font files of ${image}: exit ${r.code}${r.timedOut ? ', timed out' : ''}: ${r.stderr.slice(0, 500)}`,
      );
    const actual = new Map<string, string>();
    for (const line of new TextDecoder().decode(r.stdout).split('\n')) {
      const m = /^([0-9a-f]{64}) [ *]\S*\/([^/\s]+)$/.exec(line.trim());
      if (m) actual.set(m[2] ?? '', m[1] ?? '');
    }
    if (r.code === 0 && actual.size < new Set(named.map((f) => f.file)).size)
      throw new Error(`cannot check the font files of ${image}: sha256sum gave too few lines`);
    for (const f of named) {
      const sum = actual.get(f.file);
      if (sum === undefined) problems.push(problem('font_file_missing', f));
      else if (sum !== f.sha256) problems.push(problem('font_file_mismatch', f));
    }
  }
  // Manifest order, as checkFontFiles reports them.
  const order = new Map(faces.map((f, i) => [f.file, i]));
  problems.sort((a, b) => (order.get(a.file) ?? 0) - (order.get(b.file) ?? 0));
  return { ok: problems.length === 0, problems };
}

/** Checks the manifest's faces against the font files inside `image` (cached per process). */
export function checkImageFontFiles(manifest: FontManifest, image = IMAGE): Promise<FontFileCheck> {
  const key = `${image}\n${manifestFaces(manifest)
    .map((f) => `${f.file}:${f.sha256}`)
    .join('\n')}`;
  let p = checks.get(key);
  if (!p) {
    p = runCheck(manifest, image);
    checks.set(key, p);
    p.catch(() => checks.delete(key));
  }
  return p;
}

/** The job's font check for the worker process (main.ts): the image's own font files. */
export function imageFontCheck(image = IMAGE): (manifest: FontManifest) => Promise<FontFileCheck> {
  return (manifest) => checkImageFontFiles(manifest, image);
}
