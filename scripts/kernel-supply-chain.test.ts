/**
 * WASM-013: the Rust kernel's supply chain. The checks are tried on synthetic crates, and then on
 * the real workspace in `crates/` when `cargo` is installed (the pinned toolchain of
 * crates/rust-toolchain.toml; rustup fetches it on first use).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  denyAllowedLicences,
  denyConfigProblems,
  denyIgnoredAdvisories,
  type AdvisoryException,
  dataReviewProblems,
  lockReviewProblems,
  needsDataReview,
  parseCargoLock,
  parseCargoTree,
  sha256Of,
  type DataReview,
  type LockReview,
} from './kernel-supply-chain.ts';
import { everyOptionAllowed, productionCrates, readCargoMetadata } from './cargo-licences.ts';
import { evaluate, type Policy } from './licence-policy.ts';

const root = resolve(import.meta.dirname, '..');
const read = (file: string) => readFileSync(join(root, file), 'utf8');
const policy = JSON.parse(read('licences/policy.json')) as Policy;
const reviews = (JSON.parse(read('licences/kernel-data.json')) as { reviews: DataReview[] })
  .reviews;
const locks = (
  JSON.parse(read('licences/cargo-lock-review.json')) as {
    locks: Record<string, LockReview>;
  }
).locks;
const TODAY = '2026-11-18';

const review = (over: Partial<DataReview> = {}): DataReview => ({
  crate: 'unicode-linebreak',
  version: '0.1.5',
  data: 'The line break property tables.',
  dataLicence: 'Unicode-3.0',
  finding: 'Permissive; notice kept.',
  decision: 'WASM-013 test',
  expires: '2027-01-01',
  ...over,
});

describe('which crates need a data review (criterion 1)', () => {
  it('names the crates that carry Unicode data or hyphenation patterns', () => {
    for (const name of [
      'unicode-linebreak',
      'unicode-segmentation',
      'hypher',
      'icu_segmenter',
      'icu',
    ])
      expect(needsDataReview({ name, version: '1.0.0', licence: 'MIT' }), name).toBe(true);
    expect(
      needsDataReview({
        name: 'unicode-ident',
        version: '1.0.27',
        licence: '(MIT OR Apache-2.0) AND Unicode-3.0',
      }),
    ).toBe(true);
    expect(
      needsDataReview({ name: 'wasm-bindgen', version: '0.2.130', licence: 'MIT OR Apache-2.0' }),
    ).toBe(false);
  });

  it('fails a data crate with no review, an expired one, and a review that says nothing', () => {
    const crate = { name: 'unicode-linebreak', version: '0.1.5', licence: 'Apache-2.0' };
    expect(dataReviewProblems([crate], [], TODAY)[0]).toContain(
      'no review in licences/kernel-data.json',
    );
    expect(dataReviewProblems([crate], [review()], TODAY)).toEqual([]);
    expect(dataReviewProblems([crate], [review({ expires: '2026-11-01' })], TODAY)[0]).toContain(
      'expired',
    );
    expect(dataReviewProblems([crate], [review({ finding: '' })], TODAY)[0]).toContain(
      'needs data',
    );
    // A review is of one version: an update is reviewed again.
    expect(dataReviewProblems([{ ...crate, version: '0.1.6' }], [review()], TODAY)[0]).toContain(
      'no review',
    );
  });

  it('asks a hyphenation crate for the licence of every pattern file', () => {
    const crate = { name: 'hypher', version: '0.1.8', licence: 'MIT OR Apache-2.0' };
    const base = review({ crate: 'hypher', version: '0.1.8', dataLicence: 'LPPL-1.3c OR MIT' });
    expect(dataReviewProblems([crate], [base], TODAY)[0]).toContain('each pattern file');
    const patterns = [{ file: 'hyph-en-us.tex', licence: 'permissive notice', option: 'as is' }];
    expect(dataReviewProblems([crate], [{ ...base, patterns }], TODAY)).toEqual([]);
    expect(
      dataReviewProblems(
        [crate],
        [{ ...base, patterns: [{ file: 'hyph-sk.tex', licence: '', option: '' }] }],
        TODAY,
      )[0],
    ).toContain('every pattern file');
  });
});

describe('the lock review (criterion 4)', () => {
  const text = 'version = 4\r\n\r\n[[package]]\r\nname = "a"\r\nversion = "1.0.0"\r\n';
  const record: LockReview = { sha256: sha256Of(text.replaceAll('\r\n', '\n')), reviewed: 'test' };

  it('accepts the reviewed text whatever the line endings', () => {
    expect(lockReviewProblems('crates/Cargo.lock', text, record)).toEqual([]);
    expect(lockReviewProblems('crates/Cargo.lock', text.replaceAll('\r\n', '\n'), record)).toEqual(
      [],
    );
  });

  it('fails a changed lock, naming both hashes, and a lock with no record', () => {
    const changed = text.replace('1.0.0', '1.0.1');
    const [problem] = lockReviewProblems('crates/Cargo.lock', changed, record);
    expect(problem).toContain('changed since it was reviewed');
    expect(problem).toContain(record.sha256);
    expect(lockReviewProblems('crates/Cargo.lock', text, undefined)[0]).toContain(
      'no review record',
    );
    expect(lockReviewProblems('crates/Cargo.lock', text, { ...record, reviewed: '' })[0]).toContain(
      'nobody reviewed',
    );
  });
});

describe('Cargo.lock and `cargo tree` text', () => {
  it('reads the packages and their checksums', () => {
    const lock = parseCargoLock(
      [
        'version = 4',
        '[[package]]',
        'name = "cfg-if"',
        'version = "1.0.5"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        'checksum = "4e76"',
        '[[package]]',
        'name = "mine"',
        'version = "0.0.0"',
        'dependencies = [',
        ' "cfg-if",',
        ']',
      ].join('\n'),
    );
    expect(lock).toEqual([
      {
        name: 'cfg-if',
        version: '1.0.5',
        source: 'registry+https://github.com/rust-lang/crates.io-index',
        checksum: '4e76',
      },
      { name: 'mine', version: '0.0.0', source: null, checksum: null },
    ]);
  });

  it('leaves out the workspace members and the repeated marks', () => {
    const crates = parseCargoTree(
      [
        'mine v0.0.0 (/work/crates/mine)|Apache-2.0',
        'wasm-bindgen v0.2.130|MIT OR Apache-2.0',
        'cfg-if v1.0.5|MIT OR Apache-2.0',
        'cfg-if v1.0.5|MIT OR Apache-2.0 (*)',
        'wasm-bindgen-macro v0.2.130 (proc-macro)|MIT OR Apache-2.0',
      ].join('\n'),
    );
    expect(crates.map((c) => `${c.name}@${c.version}`)).toEqual([
      'cfg-if@1.0.5',
      'wasm-bindgen@0.2.130',
    ]);
    expect(crates[0]?.licence).toBe('MIT OR Apache-2.0');
  });
});

const cargoOk = spawnSync(process.env['CARGO'] || 'cargo', ['--version']).status === 0;

describe.skipIf(!cargoOk || !existsSync(join(root, 'crates/Cargo.lock')))(
  'the kernel workspace in crates/ (criteria 1 and 4)',
  () => {
    const manifest = join(root, 'crates/Cargo.toml');
    const crates = cargoOk ? productionCrates(readCargoMetadata(manifest)) : [];

    it('has every crate on the licence allow-list, and no dual licence with an option that is not', () => {
      expect(crates.length).toBeGreaterThan(0);
      for (const c of crates) {
        const verdict = evaluate(c.licence ?? undefined, policy);
        expect(verdict.ok, `${c.name}@${c.version}: ${c.licence}`).toBe(true);
        if (verdict.dual) expect(everyOptionAllowed(c.licence!, policy), c.name).toBe(true);
      }
    });

    it('has its data crates reviewed: the Unicode tables of unicode-ident, today', () => {
      expect(dataReviewProblems(crates, reviews, TODAY)).toEqual([]);
      const reviewed = crates.filter((c) => needsDataReview(c)).map((c) => c.name);
      expect(reviewed).toContain('unicode-ident');
    });

    it('is pinned: the lock file is the reviewed one, direct dependencies are exact, builds are locked', () => {
      expect(
        lockReviewProblems(
          'crates/Cargo.lock',
          read('crates/Cargo.lock'),
          locks['crates/Cargo.lock'],
        ),
      ).toEqual([]);
      for (const file of ['crates/layout-kernel/Cargo.toml']) {
        const dependencies = /\[dependencies\]([\s\S]*?)(\n\[|$)/.exec(read(file))?.[1] ?? '';
        const lines = dependencies.split('\n').filter((l) => /^[\w-]+\s*=/.test(l));
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) expect(line, `${file}: ${line}`).toMatch(/"=\d+\.\d+\.\d+"/);
      }
      for (const line of read('crates/build.sh').split('\n'))
        if (/^\s*cargo (build|test|clippy|tree|metadata)\b/.test(line))
          expect(line, 'crates/build.sh').toContain('--locked');
    });
  },
);

describe('the advisory check (criterion 2; owner decision 281)', () => {
  const deny = read('crates/deny.toml');
  const exceptions = (
    JSON.parse(read('licences/cargo-advisory-exceptions.json')) as {
      exceptions: AdvisoryException[];
    }
  ).exceptions;
  const record = (over: Partial<AdvisoryException> = {}): AdvisoryException => ({
    id: 'RUSTSEC-2099-0001',
    crate: 'example <1.0.0',
    reason: 'The affected function is not called.',
    decision: 'WASM-013 test',
    expires: '2027-01-01',
    ...over,
  });
  const ignoring = (id: string) =>
    deny.replace('ignore = []', `ignore = [\n  { id = "${id}", reason = "x" }, # comment\n]`);

  it('accepts the configuration in crates/deny.toml against the licence policy', () => {
    expect(denyConfigProblems(deny, policy.allow, exceptions, TODAY)).toEqual([]);
    expect(denyAllowedLicences(deny)).toContain('Unicode-3.0');
    expect(denyIgnoredAdvisories(deny)).toEqual([]);
  });

  it('fails an ignored advisory that has no record, and one whose record expired', () => {
    const text = ignoring('RUSTSEC-2099-0001');
    expect(denyIgnoredAdvisories(text)).toEqual(['RUSTSEC-2099-0001']);
    expect(denyConfigProblems(text, policy.allow, [], TODAY)[0]).toContain('has no record');
    expect(denyConfigProblems(text, policy.allow, [record()], TODAY)).toEqual([]);
    expect(
      denyConfigProblems(text, policy.allow, [record({ expires: '2026-11-01' })], TODAY)[0],
    ).toContain('expired');
    expect(denyConfigProblems(text, policy.allow, [record({ reason: '' })], TODAY)[0]).toContain(
      'needs crate, reason and decision',
    );
  });

  it('fails a record for an advisory that is not ignored', () => {
    expect(denyConfigProblems(deny, policy.allow, [record()], TODAY)[0]).toContain(
      'does not ignore it',
    );
  });

  it('fails a licence the policy does not allow, a yanked release let through, and another source', () => {
    expect(
      denyConfigProblems(deny.replace('"ISC",', '"ISC", "GPL-3.0-only",'), policy.allow, [], TODAY),
    ).toEqual(['deny.toml allows GPL-3.0-only, which licences/policy.json does not']);
    expect(
      denyConfigProblems(
        deny.replace('yanked = "deny"', 'yanked = "warn"'),
        policy.allow,
        [],
        TODAY,
      ),
    ).toEqual(['deny.toml: [advisories] yanked must be "deny"']);
    expect(
      denyConfigProblems(
        deny.replace('unknown-git = "deny"', 'unknown-git = "warn"'),
        policy.allow,
        [],
        TODAY,
      ),
    ).toEqual(['deny.toml: [sources] unknown-git must be "deny"']);
    expect(
      denyConfigProblems(
        deny.replace('allow-git = []', 'allow-git = ["https://example.org/x"]'),
        policy.allow,
        [],
        TODAY,
      ),
    ).toEqual(['deny.toml: no git source may be allowed']);
  });

  it('runs on every build: cargo-deny is called, locked, by the tests and by both builds', () => {
    const script = read('crates/build.sh');
    expect(script).toMatch(/cargo deny --locked [^\n]*check/);
    // `advisories` is called in the `test` branch and in the `build|build-sea` branch.
    const calls = script.split('\n').filter((l) => /^\s+advisories$/.test(l));
    expect(calls).toHaveLength(2);
    // A machine without cargo-deny fails instead of skipping the check.
    expect(script).toMatch(/command -v cargo-deny[\s\S]*exit 1/);
  });

  it('pins cargo-deny in the builder image: an exact version and the SHA-256 of its crate', () => {
    const file = read('crates/Containerfile');
    expect(/^ARG CARGO_DENY_VERSION=\d+\.\d+\.\d+$/m.test(file)).toBe(true);
    expect(/^ARG CARGO_DENY_SHA256=[0-9a-f]{64}$/m.test(file)).toBe(true);
    expect(file).toContain('sha256sum -c');
    expect(file).toContain('cargo install --locked');
  });
});
