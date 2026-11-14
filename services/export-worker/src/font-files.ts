/**
 * The font files of a job, checked against the font manifest (09 §5; EXP-047 criterion 2). Every
 * face the manifest names must be a file in the font directory, and its bytes must hash to the name
 * the manifest gives it. A missing file or a file that does not match is a problem: the job must
 * fail with a diagnostic that names the family, and no other font may be put in its place.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FontManifest } from '@docedit/export-latex';

export interface FontFileProblem {
  /** `font_file_missing`: no file of that name; `font_file_mismatch`: the bytes hash to another value. */
  code: 'font_file_missing' | 'font_file_mismatch';
  /** The family the face belongs to (the math face and fallback faces use their own name). */
  family: string;
  /** The face within the family: `regular`, `bold`, `italic`, `boldItalic`, `math` or `fallback`. */
  face: string;
  file: string;
  expectedSha256: string;
}

export interface FontFileCheck {
  ok: boolean;
  problems: FontFileProblem[];
}

interface Face {
  family: string;
  face: string;
  file: string;
  sha256: string;
}

/** Every face the manifest names, each file once, in manifest order. */
export function manifestFaces(manifest: FontManifest): Face[] {
  const out: Face[] = [];
  for (const f of manifest.families) {
    const faces: [string, { file: string; sha256: string }][] = [
      ['regular', f.regular],
      ['bold', f.bold],
      ['italic', f.italic],
      ['boldItalic', f.boldItalic],
    ];
    for (const [face, v] of faces)
      out.push({ family: f.name, face, file: v.file, sha256: v.sha256 });
  }
  out.push({
    family: manifest.math.name,
    face: 'math',
    file: manifest.math.file,
    sha256: manifest.math.sha256,
  });
  for (const fb of manifest.fallback ?? []) {
    out.push({ family: fb.name, face: 'fallback', file: fb.file, sha256: fb.sha256 });
  }
  const seen = new Set<string>();
  return out.filter((f) => {
    if (seen.has(f.file)) return false;
    seen.add(f.file);
    return true;
  });
}

/**
 * Check the faces of `manifest` against the files in `dir`. Reads each file once. Returns every
 * problem; `ok` is true only when there are none. Pure apart from the reads.
 */
export async function checkFontFiles(manifest: FontManifest, dir: string): Promise<FontFileCheck> {
  const problems: FontFileProblem[] = [];
  for (const f of manifestFaces(manifest)) {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(dir, f.file));
    } catch {
      problems.push({
        code: 'font_file_missing',
        family: f.family,
        face: f.face,
        file: f.file,
        expectedSha256: f.sha256,
      });
      continue;
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== f.sha256) {
      problems.push({
        code: 'font_file_mismatch',
        family: f.family,
        face: f.face,
        file: f.file,
        expectedSha256: f.sha256,
      });
    }
  }
  return { ok: problems.length === 0, problems };
}
