/**
 * The release pipeline's local part (FND-012; ADR 0044). Everything a release carries except what
 * needs CI (images, signatures, publication): it checks the version, runs the licence gate and the
 * pinning check, builds the element, runs the origin check, writes per distributable the bill of
 * materials and the third-party notices, packs the element's npm tarball, writes the changelog and
 * the release notes, and lists every file in SHA256SUMS and release-manifest.json. It publishes
 * nothing. The release workflow (.github/workflows/release.yml) runs it on a tag, then builds,
 * signs and attaches the images, and keeps the GitHub release a draft until a maintainer publishes.
 *
 * Usage: node scripts/release/release.ts [--dry-run] [--tag v<version>] [--out <dir>]
 *          [--previous-snapshot <stories-snapshot.json>] [--released <v1,v2>] [--skip-build]
 *          [--images <images.json>] [--strict]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyseBundle, hashFile, type BundleFile } from '../supply-chain/bundle.ts';
import {
  checkOrigins,
  printOriginReport,
  type OriginException,
} from '../supply-chain/origin-check.ts';
import { scanRepository } from '../supply-chain/pin-check.ts';
import { presence, type Distributable } from './distributables.ts';
import { parseLockfile } from './lockfile.ts';
import { compareCratesWithLock, moduleCrates } from './crates.ts';
import { renderNotices, type NoticeEntry } from './notices.ts';
import {
  parseRoundTrip,
  readCompatibility,
  renderReleaseNotes,
  type Artefact,
  type ImageRecord,
} from './notes.ts';
import {
  bundleSbom,
  compareWithContents,
  compareWithLock,
  createdAt,
  serviceSbom,
  type SbomContext,
} from './sbom.ts';
import { imageLicenceArtefacts } from './licence-manifest.ts';
import { stringify } from './spdx.ts';
import {
  compactSnapshot,
  coverageChanges,
  diffStories,
  renderChangelog,
  snapshotStories,
  type StorySnapshot,
} from './stories.ts';
import { checkReleaseVersion, isPrerelease, trainVersion, workspacePackages } from './version.ts';
import {
  conclude,
  flattenLicenceList,
  loadPolicy,
  runLicenceList,
  workspaceClosure,
  type Dependency,
} from './walk.ts';

export interface Step {
  name: string;
  ok: boolean;
  detail: string[];
}

const toPosix = (p: string) => p.split(sep).join('/');

/** The file name an artefact of a distributable gets in the release. */
export function artefactName(
  d: Pick<Distributable, 'packageName'>,
  version: string,
  suffix: string,
): string {
  return `${d.packageName.replace(/^@/, '').replace('/', '-')}-${version}${suffix}`;
}

/** The manifest of the published element package: the build output, nothing to install. */
export function npmManifest(
  d: Distributable,
  version: string,
  source: { description?: string },
  repository?: string,
): Record<string, unknown> {
  return {
    name: d.packageName,
    version,
    ...(source.description ? { description: source.description } : {}),
    type: 'module',
    license: 'Apache-2.0',
    exports: { '.': './doc-editor.js', './package.json': './package.json' },
    sideEffects: true,
    ...(repository
      ? { repository: { type: 'git', url: `git+${repository}.git`, directory: d.dir } }
      : {}),
    publishConfig: { access: 'public', provenance: true },
  };
}

/** `sha256sum` format: one line per file, sorted by name. */
export function sha256sums(files: ReadonlyArray<{ file: string; sha256: string }>): string {
  return `${[...files]
    .sort((a, b) => (a.file < b.file ? -1 : 1))
    .map((f) => `${f.sha256}  ${f.file}`)
    .join('\n')}\n`;
}

/** Runs pnpm or npm (a `.cmd` shim on Windows, which needs a shell). */
function run(
  command: 'pnpm' | 'npm',
  args: string[],
  cwd: string,
): { ok: boolean; stdout: string; output: string } {
  const win = process.platform === 'win32';
  const quoted = win
    ? args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    : args;
  const r = spawnSync(win ? `${command}.cmd` : command, quoted, {
    cwd,
    encoding: 'utf8',
    shell: win,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    output: `${r.stdout ?? ''}${r.stderr ?? ''}`,
  };
}

/** `npm pack` of a staged directory into `dest`: the tarball's path and the files npm put in it. */
function npmPack(stage: string, dest: string): { file: string; paths: string[] } {
  mkdirSync(dest, { recursive: true });
  const r = run('npm', ['pack', '--json', '--pack-destination', dest], stage);
  if (!r.ok) throw new Error(`npm pack failed:\n${r.output}`);
  const [info] = JSON.parse(r.stdout) as Array<{
    filename: string;
    files: Array<{ path: string }>;
  }>;
  return {
    file: join(dest, info!.filename.replace(/^@([^/]+)\//, '$1-')),
    paths: info!.files.map((f) => f.path).sort(),
  };
}

function sha512(file: string): string {
  return createHash('sha512').update(readFileSync(file)).digest('hex');
}

function gitCommit(root: string): { sha: string | null; epoch: number | null } {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%H %ct'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const [sha, epoch] = out.split(' ');
    return { sha: sha ?? null, epoch: epoch ? Number(epoch) : null };
  } catch {
    return { sha: null, epoch: null };
  }
}

export interface ReleaseOptions {
  root: string;
  out: string;
  dryRun: boolean;
  tag?: string;
  previousSnapshot?: string;
  released: string[];
  skipBuild: boolean;
  images?: string;
  /** Fail when a distributable or image is missing (CI, for a release that is not a pre-release). */
  strict: boolean;
}

export async function release(o: ReleaseOptions): Promise<{ steps: Step[]; dir: string }> {
  const steps: Step[] = [];
  const step = (name: string, ok: boolean, detail: string[] = []) => {
    steps.push({ name, ok, detail });
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${name}${detail.length ? `\n${detail.map((d) => `       ${d}`).join('\n')}` : ''}`,
    );
  };

  // 1. Version: one version for the train, the tag names it, above earlier releases.
  const packages = workspacePackages(o.root);
  const train = trainVersion(packages);
  const version = train.version ?? '0.0.0';
  const versionProblems = [
    ...train.problems,
    ...(train.version ? checkReleaseVersion({ version, tag: o.tag, released: o.released }) : []),
  ];
  step(
    `version ${version}${o.tag ? ` (tag ${o.tag})` : ''}`,
    !versionProblems.length,
    versionProblems,
  );

  const dir = join(o.out, `${version}${o.dryRun ? '-dry-run' : ''}`);
  const artefactsDir = join(dir, 'artefacts');
  const reportsDir = join(dir, 'reports');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(artefactsDir, { recursive: true });
  mkdirSync(reportsDir, { recursive: true });

  const commit = gitCommit(o.root);
  const epoch = Number(
    process.env['SOURCE_DATE_EPOCH'] ?? commit.epoch ?? Math.floor(Date.now() / 1000),
  );
  const created = createdAt(epoch);
  const repository = process.env['DOCEDIT_REPOSITORY_URL'];
  const { policy, exceptions } = loadPolicy(o.root);
  const today = new Date().toISOString().slice(0, 10);
  const ctx: SbomContext = {
    version,
    created,
    namespaceBase: process.env['DOCEDIT_SBOM_NAMESPACE'] ?? 'https://docedit.invalid/spdx',
    projectLicence:
      (JSON.parse(readFileSync(join(o.root, 'package.json'), 'utf8')) as { license?: string })
        .license ?? 'NOASSERTION',
    sourceLocation:
      repository && commit.sha ? `git+${repository}.git@${commit.sha}` : 'NOASSERTION',
    lock: parseLockfile(readFileSync(join(o.root, 'pnpm-lock.yaml'), 'utf8')),
    policy,
    exceptions,
    today,
  };

  // 2. The licence gate over the whole workspace (FND-011).
  const gate = spawnSync(process.execPath, [join(o.root, 'scripts/licence-gate.ts')], {
    cwd: o.root,
    encoding: 'utf8',
  });
  step(
    'licence gate (scripts/licence-gate.ts)',
    gate.status === 0,
    `${gate.stdout}${gate.stderr}`
      .trim()
      .split('\n')
      .filter((l) => /problem|passed|checked|- /.test(l))
      .slice(0, 12),
  );

  // 3. Base images pinned and built with Podman (SEC-052).
  const pins = scanRepository(o.root, ['containerfiles', 'compose', 'podman', 'references']);
  writeFileSync(join(reportsDir, 'pin-check.json'), `${JSON.stringify(pins, null, 2)}\n`);
  step(
    `pin check (${pins.files.containerfiles} Containerfile(s), ${pins.files.compose} compose file(s))`,
    !pins.findings.length,
    pins.findings.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.message}`),
  );

  const { present, images, missing } = presence(o.root);
  const strictMissing = o.strict && !isPrerelease(version);
  step(
    `distributables: ${present.map((d) => d.id).join(', ')}`,
    !(strictMissing && missing.length),
    missing.map((m) => `missing: ${m}`),
  );

  const artefacts: Artefact[] = [];
  const addArtefact = (file: string, kind: string, sbom?: string) => {
    const h = hashFile(join(artefactsDir, file));
    artefacts.push({ file, kind, size: h.size, sha256: h.sha256, ...(sbom ? { sbom } : {}) });
  };
  let reproducibleTarball: boolean | null = null;

  for (const d of present) {
    const walkPackages = workspaceClosure(o.root, d.packageName, packages);
    const walk: Dependency[] = flattenLicenceList(
      runLicenceList(
        o.root,
        walkPackages.map((p) => p.name),
      ),
    );
    if (d.kind === 'bundle') {
      // 4. Build, then the origin check (SEC-054) on what was built.
      if (!o.skipBuild) {
        const b = run('pnpm', ['--filter', d.packageName, 'build'], o.root);
        step(`build ${d.packageName}`, b.ok, b.ok ? [] : b.output.trim().split('\n').slice(-15));
        if (!b.ok) continue;
      }
      const output = join(o.root, d.output!);
      if (!existsSync(output)) {
        step(`${d.id}: build output`, false, [
          `${d.output} does not exist; build the package first`,
        ]);
        continue;
      }
      const exclude = new Set(d.exclude ?? []);
      const contents = analyseBundle(output, {
        ownPackageDir: join(o.root, d.dir),
        exclude: (p) => exclude.has(p),
        // The layout kernel's WebAssembly file is a build output (`dist/` is skipped by default):
        // it is explained by the package that built it (WASM-013).
        candidateDirs: [join(o.root, 'packages/layout-kernel/dist')],
      });
      const originExceptions = (
        JSON.parse(
          readFileSync(join(o.root, 'scripts/supply-chain/origin-exceptions.json'), 'utf8'),
        ) as { exceptions: OriginException[] }
      ).exceptions;
      const origins = checkOrigins(contents, originExceptions, today);
      printOriginReport(origins);
      writeFileSync(
        join(reportsDir, `origin-check-${d.id}.json`),
        `${JSON.stringify(origins, null, 2)}\n`,
      );
      step(
        `origin check of ${d.output} (${origins.scanned} files, ${origins.excused.length} excused)`,
        origins.ok,
        [
          ...origins.findings.map(
            (f) =>
              `${f.rule} at ${f.file}:${f.line + 1}:${f.column + 1} (${f.package ?? 'no package'}): ${f.detail}`,
          ),
          ...origins.problems,
        ],
      );

      // 5. Notices from what the bundle contains, then the staged package and its tarball.
      const notices: NoticeEntry[] = [...contents.packages.values()]
        .filter((p) => !p.workspace)
        .map((p) => {
          const c = conclude(
            { name: p.name, version: p.version, licence: p.licence ?? '' },
            policy,
            exceptions,
            today,
          );
          return {
            name: p.name,
            version: p.version,
            licence: p.licence ?? 'UNKNOWN',
            dir: p.dir,
            ...(c.note && c.ok ? { exception: c.note } : {}),
          };
        });
      // A bundle that carries the layout kernel's WebAssembly module also carries the crates
      // compiled into it: they are in its bill and in its notices (WASM-013).
      const crates = [...contents.packages.values()].some(
        (p) => p.name === '@docedit/layout-kernel',
      )
        ? moduleCrates(join(o.root, 'crates'))
        : [];
      for (const c of crates)
        notices.push({
          name: c.name,
          version: c.version,
          licence: c.licence ?? 'UNKNOWN',
          dir: c.dir || null,
        });
      const rendered = renderNotices(`${d.packageName} ${version}`, notices);
      const stage = join(dir, 'stage', d.id);
      for (const f of contents.files) {
        mkdirSync(dirname(join(stage, f.path)), { recursive: true });
        cpSync(join(output, f.path), join(stage, f.path));
      }
      const source = JSON.parse(readFileSync(join(o.root, d.dir, 'package.json'), 'utf8')) as {
        description?: string;
      };
      writeFileSync(
        join(stage, 'package.json'),
        `${JSON.stringify(npmManifest(d, version, source, repository), null, 2)}\n`,
      );
      cpSync(join(o.root, 'LICENSE'), join(stage, 'LICENSE'));
      cpSync(join(o.root, 'NOTICE'), join(stage, 'NOTICE'));
      writeFileSync(join(stage, 'THIRD-PARTY-NOTICES.md'), rendered.text);
      const extra: BundleFile[] = [
        'package.json',
        'LICENSE',
        'NOTICE',
        'THIRD-PARTY-NOTICES.md',
      ].map((f) => ({ path: f, ...hashFile(join(stage, f)) }));
      const packed = npmPack(stage, artefactsDir);
      const tarball = packed.file;
      const again = npmPack(stage, join(dir, 'repack'));
      reproducibleTarball = hashFile(tarball).sha256 === hashFile(again.file).sha256;
      rmSync(join(dir, 'repack'), { recursive: true, force: true });
      const tarHash = hashFile(tarball);

      // 6. The bill: contents, lock file, the gate's walk, and the files npm packed.
      const sbom = bundleSbom({
        id: d.id,
        packageName: d.packageName,
        contents,
        walk,
        extraFiles: extra,
        crates,
        tarball: { sha256: tarHash.sha256, sha512: sha512(tarball), fileName: basename(tarball) },
        ctx,
      });
      const listed = [...contents.files, ...extra].map((f) => f.path).sort();
      const compared = [
        ...compareWithLock(sbom.doc, ctx.lock, version),
        ...compareWithContents(sbom.doc, contents, d.packageName),
        ...(crates.length
          ? compareCratesWithLock(
              sbom.doc,
              readFileSync(join(o.root, 'crates/Cargo.lock'), 'utf8'),
              crates.length,
            )
          : []),
        ...packed.paths
          .filter((p) => !listed.includes(p))
          .map((p) => `${p} is in the tarball but not in the bill`),
        ...listed
          .filter((p) => !packed.paths.includes(p))
          .map((p) => `${p} is in the bill but npm did not pack it`),
      ];
      const sbomFile = artefactName(d, version, '.spdx.json');
      writeFileSync(join(artefactsDir, sbomFile), stringify(sbom.doc));
      const noticesFile = artefactName(d, version, '.notices.md');
      writeFileSync(join(artefactsDir, noticesFile), rendered.text);
      writeFileSync(
        join(reportsDir, `sbom-${d.id}.txt`),
        `${[...sbom.problems, ...compared]
          .map((p) => `problem: ${p}`)
          .concat(sbom.notes.map((n) => `note: ${n}`))
          .join('\n')}\n`,
      );
      step(
        `bill of materials ${sbomFile}: ${sbom.doc.packages.length - 1} packages, ${sbom.doc.files?.length ?? 0} files; matches the lock file and the bundle`,
        !sbom.problems.length && !compared.length,
        [
          ...sbom.problems,
          ...compared,
          ...sbom.notes.map((n) => `note: ${n}`),
          ...rendered.withoutFiles.map((w) => `note: ${w} ships without a licence or notice file`),
        ],
      );
      step(
        `npm tarball ${basename(tarball)} (${tarHash.size} bytes; packed twice: ${reproducibleTarball ? 'identical' : 'DIFFERENT'})`,
        reproducibleTarball,
        [],
      );
      addArtefact(basename(tarball), 'npm package (ECMAScript module and lazy chunks)', sbomFile);
      addArtefact(sbomFile, 'SPDX 2.3 bill of materials');
      addArtefact(noticesFile, 'third-party notices');
    } else {
      const sbom = serviceSbom({
        id: d.id,
        packageName: d.packageName,
        workspace: walkPackages.map((p) => p.name),
        walk,
        ctx,
      });
      const compared = compareWithLock(sbom.doc, ctx.lock, version);
      const sbomFile = artefactName(d, version, '.spdx.json');
      writeFileSync(join(artefactsDir, sbomFile), stringify(sbom.doc));
      const notices = walk.map((dep) => {
        const c = conclude(dep, policy, exceptions, today);
        return {
          name: dep.name,
          version: dep.version,
          licence: dep.licence,
          dir: dep.path,
          ...(c.note && c.ok ? { exception: c.note } : {}),
        };
      });
      const rendered = renderNotices(`${d.packageName} ${version}`, notices);
      const noticesFile = artefactName(d, version, '.notices.md');
      writeFileSync(join(artefactsDir, noticesFile), rendered.text);
      step(
        `bill of materials ${sbomFile}: ${sbom.doc.packages.length - 1} packages; matches the lock file`,
        !sbom.problems.length && !compared.length,
        [
          ...sbom.problems,
          ...compared,
          ...rendered.withoutFiles.map((w) => `note: ${w} ships without a licence or notice file`),
        ],
      );
      addArtefact(sbomFile, 'SPDX 2.3 bill of materials (npm packages of the service)');
      addArtefact(noticesFile, 'third-party notices');
    }
  }

  // 7. Images, from the release workflow; listed as missing otherwise.
  const imageRecords: ImageRecord[] = o.images
    ? (JSON.parse(readFileSync(o.images, 'utf8')) as ImageRecord[])
    : [];
  for (const r of imageRecords) {
    const from = join(dirname(o.images!), r.sbom);
    if (existsSync(from)) cpSync(from, join(artefactsDir, r.sbom));
    if (existsSync(join(artefactsDir, r.sbom)))
      addArtefact(r.sbom, `SPDX 2.3 bill of materials (${r.id} image)`);
    else step(`${r.id} image bill of materials`, false, [`${r.sbom} was not produced`]);
    const licence = imageLicenceArtefacts(r, images.find((i) => i.id === r.id)?.texlive === true);
    if (licence.problems.length)
      step(`${r.id} image licence manifest and source offer`, false, licence.problems);
    for (const { file, kind } of licence.files) {
      const source = join(dirname(o.images!), file);
      if (existsSync(source)) cpSync(source, join(artefactsDir, file));
      if (existsSync(join(artefactsDir, file))) addArtefact(file, kind);
      else step(`${r.id} image ${kind.split(' (')[0]}`, false, [`${file} was not produced`]);
    }
  }
  const missingNotes = [
    ...missing,
    ...(o.images
      ? []
      : images.map(
          (i) =>
            `${i.id} image (${i.containerfile}): built twice and compared by the release workflow, then pushed, signed and listed here when the release is published`,
        )),
  ];

  // 8. Changelog and release notes from the stories.
  const snapshot = snapshotStories(join(o.root, 'docs/stories'), version, created);
  const previous = o.previousSnapshot
    ? (JSON.parse(readFileSync(o.previousSnapshot, 'utf8')) as StorySnapshot)
    : null;
  const changes = diffStories(previous, snapshot);
  const coverage = coverageChanges(previous, snapshot);
  writeFileSync(
    join(artefactsDir, 'stories-snapshot.json'),
    `${JSON.stringify(compactSnapshot(snapshot))}\n`,
  );
  writeFileSync(
    join(artefactsDir, 'CHANGELOG.md'),
    renderChangelog(version, previous?.version ?? null, changes),
  );
  // 8a0. The lossless DOCX round trip (EXP-120): R0 and R1 on the SPK-028 corpus, whose corpus
  // version and pass rates the notes state. The report is written even when a file fails.
  const roundTripFile = 'lossless-roundtrip-report.json';
  const roundTripRun = run(
    'pnpm',
    ['--filter', '@docedit/export-docx', 'roundtrip:report', join(artefactsDir, roundTripFile)],
    o.root,
  );
  const roundTripPath = join(artefactsDir, roundTripFile);
  const roundTrip = existsSync(roundTripPath)
    ? parseRoundTrip(readFileSync(roundTripPath, 'utf8'))
    : null;
  step(
    'lossless DOCX round trip',
    roundTripRun.ok && roundTrip !== null,
    roundTripRun.ok && roundTrip ? [] : roundTripRun.output.trim().split('\n').slice(-15),
  );
  const compatibility = readCompatibility(o.root);
  const signerRepo = repository?.replace(/^https:\/\/github\.com\//, '');
  const notes = renderReleaseNotes({
    version,
    date: created.slice(0, 10),
    dryRun: o.dryRun,
    previous: previous?.version ?? null,
    compatibility,
    artefacts,
    images: imageRecords,
    missing: missingNotes,
    changes,
    coverage,
    roundTrip,
    ...(signerRepo
      ? { signer: { repository: signerRepo, workflow: '.github/workflows/release.yml' } }
      : {}),
  });
  writeFileSync(join(artefactsDir, 'RELEASE-NOTES.md'), notes);
  step(
    `changelog (${changes.length} stories changed) and release notes (protocol ${compatibility.protocol?.version ?? '?'}, CDM ${compatibility.cdm ? `${compatibility.cdm.min}-${compatibility.cdm.max}` : '?'})`,
    compatibility.protocol !== null && compatibility.cdm !== null,
  );
  for (const f of ['stories-snapshot.json', 'CHANGELOG.md', 'RELEASE-NOTES.md'])
    addArtefact(f, 'release record');
  if (roundTrip) addArtefact(roundTripFile, 'lossless round-trip report');

  // 8b. The parity report (UX-002; 13 §2), published beside the release notes. The script
  // refuses to write while a shipped row links to no automated test.
  const parity = run(
    'pnpm',
    [
      '--filter',
      '@docedit/ui',
      'parity:report',
      '--release',
      version,
      '--date',
      created.slice(0, 10),
      '--out',
      artefactsDir,
    ],
    o.root,
  );
  const parityFiles = ['PARITY-REPORT.md', 'parity-report.json'];
  const parityOk = parity.ok && parityFiles.every((f) => existsSync(join(artefactsDir, f)));
  step('parity report', parityOk, parityOk ? [] : parity.output.trim().split('\n').slice(-15));
  if (parityOk) for (const f of parityFiles) addArtefact(f, 'parity report');

  // 8b2. The embedding reference (UX-090 criterion 3), generated by `pnpm generate` into spec/embedding
  // and published with this release, so that it carries the release's embedding API version.
  const referenceFiles = ['embedding-reference.md', 'embedding-reference.json'];
  const referenceOk = referenceFiles.every((f) => existsSync(join(o.root, 'spec/embedding', f)));
  if (referenceOk)
    for (const f of referenceFiles) {
      cpSync(join(o.root, 'spec/embedding', f), join(artefactsDir, f));
      addArtefact(f, 'embedding reference');
    }
  step(
    'embedding reference',
    referenceOk,
    referenceOk ? [] : ['spec/embedding is missing: run pnpm generate'],
  );

  // 8c. The accessibility conformance report (UX-069; 13 §8), linked from the release notes. It
  // draws on the axe results of the browser run (DOCEDIT_AXE_RESULTS, when that file exists), the
  // manual logs and the known issues, and refuses to build on an inconsistent table.
  const axeResults = process.env['DOCEDIT_AXE_RESULTS'];
  const a11y = run(
    'pnpm',
    [
      '--filter',
      '@docedit/ui',
      'a11y:report',
      '--release',
      version,
      '--date',
      created.slice(0, 10),
      '--out',
      artefactsDir,
      ...(axeResults && existsSync(axeResults) ? ['--axe', resolve(axeResults)] : []),
    ],
    o.root,
  );
  const a11yFiles = [
    'ACCESSIBILITY-CONFORMANCE-REPORT.md',
    'accessibility-conformance-report.json',
  ];
  const a11yOk = a11y.ok && a11yFiles.every((f) => existsSync(join(artefactsDir, f)));
  step(
    'accessibility conformance report',
    a11yOk,
    a11yOk ? [] : a11y.output.trim().split('\n').slice(-15),
  );
  if (a11yOk) for (const f of a11yFiles) addArtefact(f, 'accessibility conformance report');

  // 9. The manifest and the checksums of every file.
  const failed = steps.filter((s) => !s.ok).map((s) => s.name);
  const manifest = {
    version,
    tag: o.tag ?? null,
    dryRun: o.dryRun,
    created,
    commit: commit.sha,
    artefacts,
    images: imageRecords,
    missing: missingNotes,
    reproducible: { npmTarball: reproducibleTarball },
    checks: steps.map((s) => ({ name: s.name, ok: s.ok })),
    ok: failed.length === 0,
  };
  writeFileSync(
    join(artefactsDir, 'release-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const files = readdirSync(artefactsDir).filter(
    (f) => f !== 'SHA256SUMS' && statSync(join(artefactsDir, f)).isFile(),
  );
  writeFileSync(
    join(artefactsDir, 'SHA256SUMS'),
    sha256sums(files.map((f) => ({ file: f, sha256: hashFile(join(artefactsDir, f)).sha256 }))),
  );
  console.log(
    `\nrelease ${version}${o.dryRun ? ' (dry run)' : ''}: ${files.length + 1} files in ${toPosix(relative(o.root, artefactsDir)) || artefactsDir}`,
  );
  console.log(
    failed.length
      ? `release: ${failed.length} step(s) failed: ${failed.join('; ')}`
      : 'release: every step passed; nothing was published',
  );
  return { steps, dir };
}

function parseArgs(argv: string[], root: string): ReleaseOptions {
  const opt = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tag = opt('--tag');
  const previousSnapshot = opt('--previous-snapshot');
  const images = opt('--images');
  return {
    root,
    out: resolve(opt('--out') ?? join(root, 'dist/release')),
    dryRun: argv.includes('--dry-run'),
    ...(tag ? { tag } : {}),
    ...(previousSnapshot ? { previousSnapshot } : {}),
    released: (opt('--released') ?? '')
      .split(',')
      .map((s) => s.trim().replace(/^v/, ''))
      .filter(Boolean),
    skipBuild: argv.includes('--skip-build'),
    ...(images ? { images } : {}),
    strict: argv.includes('--strict'),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
  const { steps } = await release(parseArgs(process.argv.slice(2), root));
  process.exitCode = steps.every((s) => s.ok) ? 0 : 1;
}
