/**
 * EXP-078 criterion 1: a TeX Live upgrade is handled as a class version change (09 §9.4).
 *
 * The base image of the worker is pinned by digest in the `FROM` line of the Containerfile.
 * `image/engine-releases.json` is an append-only ledger of the base images, each tied to the class
 * release that first shipped with it. `checkEngineLedger` reports what is wrong when the
 * Containerfile and the ledger disagree, so a changed base image cannot be merged without a new
 * class release (and so a new cache key, EXP-015 criterion 4) and a new ledger entry. Pure
 * functions: the caller reads the files.
 */

export interface EngineEntry {
  classVersion: string;
  texlive: string;
  baseImage: string;
}

export interface EngineLedger {
  engines: EngineEntry[];
}

/** `major.minor.patch` as numbers, or null when the text is not such a version. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative when `a` is the earlier version, zero when equal, positive when later. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** The image of the (last) `FROM` line of a Containerfile, or null when there is none. */
export function baseImageOf(containerfile: string): string | null {
  const froms = [...containerfile.matchAll(/^FROM\s+(?:--\S+\s+)*(\S+)/gm)];
  return froms.at(-1)?.[1] ?? null;
}

/** The TeX Live year the Containerfile installs under, from `/usr/local/texlive/<year>/`. */
export function texliveOf(containerfile: string): string | null {
  return /\/usr\/local\/texlive\/(\d{4})\//.exec(containerfile)?.[1] ?? null;
}

/**
 * The problems of the ledger against the Containerfile and the class releases. An empty list means a
 * TeX Live change, if there was one, came with a class release.
 */
export function checkEngineLedger(input: {
  ledger: EngineLedger;
  containerfile: string;
  /** The class versions of `packages/export-latex/class/releases.json`. */
  releasedClassVersions: readonly string[];
  /** The class version of this build (`CLASS_VERSION`). */
  classVersion: string;
}): string[] {
  const problems: string[] = [];
  const { engines } = input.ledger;
  if (engines.length === 0) return ['the ledger has no entry'];
  let previous: EngineEntry | undefined;
  for (const e of engines) {
    if (parseVersion(e.classVersion) === null) {
      problems.push(`entry ${e.classVersion}: not a version`);
      continue;
    }
    if (!input.releasedClassVersions.includes(e.classVersion))
      problems.push(`entry ${e.classVersion}: not a released class version`);
    if (compareVersions(e.classVersion, input.classVersion) > 0)
      problems.push(`entry ${e.classVersion}: later than the class of this build`);
    if (previous) {
      if (compareVersions(e.classVersion, previous.classVersion) <= 0)
        problems.push(
          `entry ${e.classVersion}: not later than the entry before it (${previous.classVersion})`,
        );
      if (e.baseImage === previous.baseImage)
        problems.push(`entry ${e.classVersion}: the base image is the one of the entry before it`);
    }
    if (!/@sha256:[0-9a-f]{64}$/.test(e.baseImage))
      problems.push(`entry ${e.classVersion}: the base image is not pinned by digest`);
    previous = e;
  }
  const last = engines.at(-1)!;
  const from = baseImageOf(input.containerfile);
  if (from !== last.baseImage)
    problems.push(
      `the Containerfile builds on ${from ?? 'no image'}, the last entry (${last.classVersion}) on ${last.baseImage}: a new base image needs a new class release and a new entry`,
    );
  const year = texliveOf(input.containerfile);
  if (year !== last.texlive)
    problems.push(
      `the Containerfile installs under TeX Live ${year ?? 'none'}, the last entry says ${last.texlive}`,
    );
  return problems;
}
