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

export interface AdvisoryException {
  /** The advisory, as RustSec names it: `RUSTSEC-YYYY-NNNN`. */
  id: string;
  /** The crate and version range the advisory is about. */
  crate: string;
  /** Why the advisory does not apply, or why it is accepted for now. */
  reason: string;
  /** The decision record, with its date. */
  decision: string;
  /** YYYY-MM-DD; after it the gate fails again. */
  expires: string;
}

/** Text between `key = [` and the matching `]` of one `[table]` section of a TOML file. */
function tomlSection(text: string, table: string): string {
  const header = new RegExp(String.raw`^\[${table}\]\s*$`, 'm').exec(text);
  if (!header) return '';
  const rest = text.slice(header.index + header[0].length);
  const next = /^\[[^\]]+\]\s*$/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** The TOML text with its comments removed (a `#` outside a string; strings here hold none). */
const withoutComments = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s*#.*$/, ''))
    .join('\n');

/** The array after `key =` in a section, as its text, or null when the key is absent. */
function tomlArray(section: string, key: string): string | null {
  const m = new RegExp(String.raw`^${key}\s*=\s*\[`, 'm').exec(section);
  if (!m) return null;
  let depth = 0;
  const start = m.index + m[0].length - 1;
  for (let i = start; i < section.length; i++) {
    if (section[i] === '[') depth++;
    else if (section[i] === ']' && --depth === 0) return section.slice(start + 1, i);
  }
  return null;
}

/** The licences `crates/deny.toml` allows. */
export function denyAllowedLicences(denyText: string): string[] {
  const body = tomlArray(tomlSection(withoutComments(denyText), 'licenses'), 'allow') ?? '';
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

/** The advisories `crates/deny.toml` ignores. */
export function denyIgnoredAdvisories(denyText: string): string[] {
  const body = tomlArray(tomlSection(withoutComments(denyText), 'advisories'), 'ignore') ?? '';
  return [...body.matchAll(/RUSTSEC-\d{4}-\d{4}/g)].map((m) => m[0]);
}

/**
 * What is wrong with the cargo-deny configuration (WASM-013 criterion 2): a missing check, a licence
 * the repository's policy does not allow, an advisory ignored with no unexpired record, a record for
 * an advisory that is not ignored, or a source other than crates.io.
 */
export function denyConfigProblems(
  denyText: string,
  policyAllow: readonly string[],
  exceptions: readonly AdvisoryException[],
  today: string,
): string[] {
  const problems: string[] = [];
  const plain = withoutComments(denyText);
  const advisories = tomlSection(plain, 'advisories');
  const sources = tomlSection(plain, 'sources');
  if (!/^yanked\s*=\s*"deny"/m.test(advisories))
    problems.push('deny.toml: [advisories] yanked must be "deny"');
  if (/^(vulnerability|notice)\s*=\s*"(warn|allow)"/m.test(advisories))
    problems.push('deny.toml: a vulnerability must fail, not warn');
  if (!/^unknown-registry\s*=\s*"deny"/m.test(sources))
    problems.push('deny.toml: [sources] unknown-registry must be "deny"');
  if (!/^unknown-git\s*=\s*"deny"/m.test(sources))
    problems.push('deny.toml: [sources] unknown-git must be "deny"');
  const registries = [...(tomlArray(sources, 'allow-registry') ?? '').matchAll(/"([^"]+)"/g)].map(
    (m) => m[1]!,
  );
  if (registries.some((r) => r !== 'https://github.com/rust-lang/crates.io-index'))
    problems.push('deny.toml: crates.io is the only registry that may be allowed');
  if ((tomlArray(sources, 'allow-git') ?? '').trim() !== '')
    problems.push('deny.toml: no git source may be allowed');

  const allowed = denyAllowedLicences(denyText);
  if (allowed.length === 0) problems.push('deny.toml: [licenses] allow is empty');
  for (const licence of allowed)
    if (!policyAllow.includes(licence))
      problems.push(`deny.toml allows ${licence}, which licences/policy.json does not`);

  const ignored = denyIgnoredAdvisories(denyText);
  for (const id of ignored) {
    const record = exceptions.find((e) => e.id === id);
    if (!record) {
      problems.push(
        `${id} is ignored in deny.toml and has no record in licences/cargo-advisory-exceptions.json`,
      );
      continue;
    }
    if (!record.crate || !record.reason || !record.decision)
      problems.push(`${id}: the exception needs crate, reason and decision`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(record.expires ?? '')) {
      problems.push(`${id}: the exception needs an expiry date`);
    } else if (record.expires < today) {
      problems.push(`${id}: the exception expired on ${record.expires}`);
    }
  }
  for (const record of exceptions)
    if (!ignored.includes(record.id))
      problems.push(
        `${record.id} has a record but deny.toml does not ignore it (remove the record)`,
      );
  return problems;
}
