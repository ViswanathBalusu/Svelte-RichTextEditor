/**
 * Supply-chain checks for the Rust kernel that the licence gate does not make (WASM-013; ADR 0016,
 * decision 5):
 *
 * - Data review. A crate that carries Unicode data, or hyphenation patterns, ships that data inside
 *   the module under its own licence. Each such crate needs an explicit, unexpired review in
 *   `licences/kernel-data.json`, naming the data, its licence and what was decided. A hyphenation
 *   crate also lists the licence of every pattern file it compiles in.
 * - Lock review. The lock file of the kernel's workspace is pinned by hash in
 *   `licences/cargo-lock-review.json`. A change to the lock, which is what a dependency update is,
 *   fails the check until the record is changed in the same commit, so an update is always a
 *   change somebody has to read.
 *
 * Universal in spirit, but run by Node.js (it is a script, not product code).
 */
import { createHash } from 'node:crypto';

export interface KernelCrate {
  name: string;
  version: string;
  licence: string | null;
}

export interface DataReview {
  crate: string;
  /** Exact version: an update of the crate is reviewed again. */
  version: string;
  /** What the crate carries: the tables or files that end up in the module. */
  data: string;
  /** The licence of that data, as an SPDX identifier or expression. */
  dataLicence: string;
  /** What the review found and what it decided. */
  finding: string;
  /** The decision record, with its date. */
  decision: string;
  /** YYYY-MM-DD; after it the gate fails again. */
  expires: string;
  /** For a hyphenation crate: every pattern file compiled in, with its licence and the option taken. */
  patterns?: Array<{ file: string; licence: string; option: string }>;
}

/** Crates that are known to carry Unicode or hyphenation data, by name. */
const DATA_CRATES =
  /^(hypher|hyphenation|hyphenopoly|unicode-(linebreak|segmentation|width|bidi|normalization|script|properties)|icu(_.*)?)$/;
const HYPHENATION = /^(hypher|hyphenation|hyphenopoly)$/;

/** Whether the crate ships data that needs its own licence review. */
export function needsDataReview(crate: KernelCrate): boolean {
  return DATA_CRATES.test(crate.name) || /Unicode-/.test(crate.licence ?? '');
}

/** The problems of a set of crates against the reviews. Empty when every data crate is reviewed. */
export function dataReviewProblems(
  crates: readonly KernelCrate[],
  reviews: readonly DataReview[],
  today: string,
): string[] {
  const problems: string[] = [];
  for (const crate of crates) {
    if (!needsDataReview(crate)) continue;
    const id = `${crate.name}@${crate.version}`;
    const review = reviews.find((r) => r.crate === crate.name && r.version === crate.version);
    if (!review) {
      problems.push(
        `${id} carries Unicode or hyphenation data and has no review in licences/kernel-data.json (one per version)`,
      );
      continue;
    }
    if (!review.data || !review.dataLicence || !review.finding || !review.decision)
      problems.push(`${id}: the data review needs data, dataLicence, finding and decision`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(review.expires ?? '')) {
      problems.push(`${id}: the data review needs an expiry date`);
    } else if (review.expires < today) {
      problems.push(`${id}: the data review expired on ${review.expires}`);
    }
    if (HYPHENATION.test(crate.name)) {
      const patterns = review.patterns ?? [];
      if (patterns.length === 0)
        problems.push(`${id}: a hyphenation crate needs the licence of each pattern file listed`);
      for (const p of patterns)
        if (!p.file || !p.licence || !p.option)
          problems.push(`${id}: every pattern file needs file, licence and option taken`);
    }
  }
  return problems;
}

export interface LockPackage {
  name: string;
  version: string;
  source: string | null;
  checksum: string | null;
}

/** The packages of a Cargo.lock (version 3 or 4), in file order. */
export function parseCargoLock(text: string): LockPackage[] {
  const out: LockPackage[] = [];
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const field = (key: string) => new RegExp(`^${key} = "([^"]*)"`, 'm').exec(block)?.[1] ?? null;
    const name = field('name');
    const version = field('version');
    if (name && version)
      out.push({ name, version, source: field('source'), checksum: field('checksum') });
  }
  return out;
}

export interface LockReview {
  /** SHA-256 of the lock file as reviewed, lower-case hex. */
  sha256: string;
  /** Who reviewed it and when, as a decision record. */
  reviewed: string;
}

export const sha256Of = (text: string | Uint8Array): string =>
  createHash('sha256').update(text).digest('hex');

/** Empty when the lock is the one that was reviewed. */
export function lockReviewProblems(
  label: string,
  lockText: string,
  review: LockReview | undefined,
): string[] {
  if (!review)
    return [
      `${label} has no review record in licences/cargo-lock-review.json (ADR 0016, decision 5)`,
    ];
  if (!review.reviewed) return [`the review record of ${label} says nobody reviewed it`];
  // Line endings differ between checkouts; the review is of the text.
  const actual = sha256Of(lockText.replaceAll('\r\n', '\n'));
  if (actual !== review.sha256)
    return [
      `${label} changed since it was reviewed (sha256 ${actual}, reviewed ${review.sha256}): read the change, then update licences/cargo-lock-review.json in the same commit`,
    ];
  return [];
}

/**
 * The crates a `cargo tree --edges normal,no-proc-macro --prefix none --format "{p}|{l}"` run lists,
 * without the workspace's own members (they have a path in parentheses). These are the crates
 * compiled into the module: proc-macro crates run at build time and are not in it.
 */
export function parseCargoTree(output: string): KernelCrate[] {
  const seen = new Map<string, KernelCrate>();
  for (const line of output.split(/\r?\n/)) {
    const m = /^(\S+) v(\S+)(?: \(([^)]*)\))?\|(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, name, version, where, licence] = m;
    // A path in parentheses is a member of the workspace; `(*)` marks a repeated subtree.
    if (where && where !== '*') continue;
    seen.set(`${name}@${version}`, {
      name: name!,
      version: version!,
      licence: licence!.replace(/ \(\*\)$/, '').trim() || null,
    });
  }
  return [...seen.values()].sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
  );
}
