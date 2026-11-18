/**
 * EXP-110 criterion 5: an input that makes the importer crash or hang is added to the corpus. The
 * fuzz test (`fuzz.test.ts`) saves such an input here before it reports the failure, and
 * `exp-110-regressions.test.ts` imports every file of this folder on every run, so the failure
 * stays fixed once it is fixed. The folder is under version control: commit the saved file with the
 * fix. A file is named by its family and the first eight hex digits of its SHA-256, so the same
 * input is saved once.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REGRESSIONS_DIR = fileURLToPath(new URL('./regressions/', import.meta.url));

/** Saves `bytes` as `<family>-<hash>.docx` in `dir`; returns the path. */
export function saveRegression(
  bytes: Uint8Array,
  family: string,
  dir: string = REGRESSIONS_DIR,
): string {
  mkdirSync(dir, { recursive: true });
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8);
  const path = join(dir, `${family.replace(/[^a-z0-9-]/gi, '-')}-${hash}.docx`);
  writeFileSync(path, bytes);
  return path;
}

/** The saved inputs of `dir`, by name. */
export function regressionFiles(dir: string = REGRESSIONS_DIR): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.docx'))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Runs `check` on an input. If it throws (a crash, or a slow import that the check reports), the
 * input is saved with `saveRegression` and the error is thrown again with the saved path named.
 */
export async function savingFailures<T>(
  bytes: Uint8Array,
  family: string,
  check: () => Promise<T>,
  dir: string = REGRESSIONS_DIR,
): Promise<T> {
  try {
    return await check();
  } catch (e) {
    const path = saveRegression(bytes, family, dir);
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`${message} (the input is saved as ${path}; commit it with the fix)`, {
      cause: e,
    });
  }
}
