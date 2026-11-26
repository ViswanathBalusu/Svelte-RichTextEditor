/**
 * Release notes (FND-012 criteria 2 and 4; ADR 0044 §2). They state the protocol and CDM versions
 * the release supports, read from the generated manifests in spec/ (PRO's versioning rules, 05 §1),
 * the embedding API version, the conformance kit, every artefact with its checksum and bill of
 * materials, how to verify signatures, the changes and the requirements whose coverage changed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangeEntry, CoverageChange } from './stories.ts';

export interface Compatibility {
  protocol: { version: string; status: string; subprotocol: string; definitionHash: string } | null;
  cdm: { min: number; max: number; status: string; schemaHash: string } | null;
  rules: { version: string; status: string } | null;
  embedding: string | null;
  kit: { name: string; version: string } | null;
}

function readJson<T>(file: string): T | null {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : null;
}

/** Versions from the generated manifests in spec/, packages/element/src/version.ts and packages/tck. */
export function readCompatibility(root: string): Compatibility {
  const dep = readJson<{
    protocol: string;
    status: string;
    subprotocol: string;
    definitionHash: string;
    cdm: { min: number; max: number; sha256: string };
  }>(join(root, 'spec/dep/dep-1.manifest.json'));
  const cdm = readJson<{ cdm: number; status: string }>(join(root, 'spec/cdm/cdm-1.manifest.json'));
  const rules = readJson<{ rules: string; status: string }>(
    join(root, 'spec/rules/rules-1.manifest.json'),
  );
  const versionFile = join(root, 'packages/element/src/version.ts');
  const embedding = existsSync(versionFile)
    ? (/EMBEDDING_VERSION\s*=\s*'([^']+)'/.exec(readFileSync(versionFile, 'utf8'))?.[1] ?? null)
    : null;
  const tck = readJson<{ name: string; version: string }>(join(root, 'packages/tck/package.json'));
  return {
    protocol: dep
      ? {
          version: dep.protocol,
          status: dep.status,
          subprotocol: dep.subprotocol,
          definitionHash: dep.definitionHash,
        }
      : null,
    cdm: dep
      ? {
          min: dep.cdm.min,
          max: dep.cdm.max,
          status: cdm?.status ?? 'unknown',
          schemaHash: dep.cdm.sha256,
        }
      : null,
    rules: rules ? { version: rules.rules, status: rules.status } : null,
    embedding,
    kit: tck ? { name: tck.name, version: tck.version } : null,
  };
}

export interface Artefact {
  file: string;
  kind: string;
  size: number;
  sha256: string;
  sbom?: string;
}

export interface ImageRecord {
  id: string;
  image: string;
  digest: string;
  sbom: string;
}

/** The lossless DOCX round trip of ADR 0017 on the SPK-028 corpus (EXP-120), as `roundtrip-report.ts` writes it. */
export interface RoundTripSummary {
  corpus: { files: number; version: string };
  r0: { pass: number; of: number };
  r1: { pass: number; of: number };
  failures: readonly string[];
}

/** The summary of a `roundtrip-report.ts` JSON file, or null when the text is not one. */
export function parseRoundTrip(text: string): RoundTripSummary | null {
  try {
    const j = JSON.parse(text) as Partial<RoundTripSummary>;
    const count = (x: unknown): x is { pass: number; of: number } =>
      !!x &&
      typeof (x as { pass?: unknown }).pass === 'number' &&
      typeof (x as { of?: unknown }).of === 'number';
    if (
      !j.corpus ||
      typeof j.corpus.version !== 'string' ||
      typeof j.corpus.files !== 'number' ||
      !count(j.r0) ||
      !count(j.r1) ||
      !Array.isArray(j.failures)
    )
      return null;
    return {
      corpus: { files: j.corpus.files, version: j.corpus.version },
      r0: { pass: j.r0.pass, of: j.r0.of },
      r1: { pass: j.r1.pass, of: j.r1.of },
      failures: j.failures.map(String),
    };
  } catch {
    return null;
  }
}

/** The lossless round-trip section: the corpus version and the pass rates (EXP-120, criterion 4). */
export function renderRoundTrip(r: RoundTripSummary | null | undefined): string[] {
  const head = ['## Lossless DOCX round trip', ''];
  if (!r)
    return [
      ...head,
      'Not measured for this release: the round-trip report did not run (see the release steps).',
      '',
    ];
  return [
    ...head,
    `Corpus version \`${r.corpus.version}\` (${r.corpus.files} files; the first 16 hexadecimal digits of the SHA-256 of \`packages/export-docx/corpus/SOURCES.md\`).`,
    '',
    '| Contract (ADR 0017) | Passed | Of | Pass rate |',
    '|---|---:|---:|---:|',
    `| R0, import and export without edits | ${r.r0.pass} | ${r.r0.of} | ${rate(r.r0)} |`,
    `| R1, scripted edits | ${r.r1.pass} | ${r.r1.of} | ${rate(r.r1)} |`,
    '',
    r.failures.length
      ? `${r.failures.length} failure(s); the first: ${r.failures[0]}`
      : 'No failures.',
    '',
  ];
}

function rate(x: { pass: number; of: number }): string {
  return x.of ? `${((100 * x.pass) / x.of).toFixed(1)} %` : 'not applicable';
}

export interface NotesInput {
  version: string;
  date: string;
  dryRun: boolean;
  previous: string | null;
  compatibility: Compatibility;
  artefacts: readonly Artefact[];
  images: readonly ImageRecord[];
  missing: readonly string[];
  changes: readonly ChangeEntry[];
  coverage: readonly CoverageChange[];
  /** The result of the lossless round-trip report; absent when it did not run (EXP-120). */
  roundTrip?: RoundTripSummary | null;
  /** The workflow identity that signs images, for the verification commands. */
  signer?: { repository: string; workflow: string };
}

/** Marks where the published images go until the release workflow has pushed and signed them. */
export const IMAGES_MARKER = '<!-- container images: added when they are published -->';

/** The images section, or the marker when there are none yet. */
export function renderImages(images: readonly ImageRecord[]): string {
  if (!images.length) return `${IMAGES_MARKER}\n`;
  const rows = images.map((i) => `| \`${i.image}\` (${i.id}) | \`${i.digest}\` | \`${i.sbom}\` |`);
  return [
    '## Container images',
    '',
    '| Image | Digest | Bill of materials |',
    '|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

export function renderReleaseNotes(n: NotesInput): string {
  const c = n.compatibility;
  const p: string[] = [
    `# Release ${n.version}${n.dryRun ? ' (dry run, not published)' : ''}`,
    '',
    `Date: ${n.date}. ${n.previous ? `Previous release: ${n.previous}.` : 'First release.'} All names are working names (SPK-007).`,
    '',
    '## Supported versions',
    '',
    '| Contract | Version | Status |',
    '|---|---|---|',
    c.protocol
      ? `| Protocol (DEP) | ${c.protocol.version}, WebSocket subprotocol \`${c.protocol.subprotocol}\`, definition hash \`${c.protocol.definitionHash.slice(0, 16)}…\` | ${c.protocol.status} |`
      : '| Protocol (DEP) | not found: spec/dep/dep-1.manifest.json is missing | |',
    c.cdm
      ? `| Document model (CDM) | ${c.cdm.min === c.cdm.max ? c.cdm.min : `${c.cdm.min} to ${c.cdm.max}`}, schema hash \`${c.cdm.schemaHash.slice(0, 16)}…\` | ${c.cdm.status} |`
      : '| Document model (CDM) | not found | |',
    c.rules
      ? `| Field rules | ${c.rules.version} | ${c.rules.status} |`
      : '| Field rules | not found | |',
    `| Embedding API of \`<doc-editor>\` | ${c.embedding ?? 'not found'} | major 0, not frozen |`,
    c.kit
      ? `| Conformance kit | ${c.kit.name} ${c.kit.version}, tests protocol ${c.protocol?.version ?? 'unknown'} | |`
      : '| Conformance kit | not part of this release | |',
    '',
    'The versioning rules are those of 05 §1: a minor protocol version only adds, receivers ignore what they do not know, and features are announced in discovery. CDM versions n and n-1 are supported side by side (owner decision 75). Version n-1 stays in the window until version n+1 is released, and the notes of that release say so; no duration in time is set (03 §11.3 gives none; docs/adr/0424-w6-CDM-050-support-window.md, proposed). No second CDM version has shipped, so the window has not begun.',
    '',
    '## Artefacts',
    '',
    '| File | Kind | Bytes | SHA-256 | Bill of materials |',
    '|---|---|---:|---|---|',
    ...n.artefacts.map(
      (a) =>
        `| \`${a.file}\` | ${a.kind} | ${a.size} | \`${a.sha256}\` | ${a.sbom ? `\`${a.sbom}\`` : ''} |`,
    ),
    '',
  ];
  p.push(renderImages(n.images));
  if (n.missing.length) {
    p.push('## Not in this release', '');
    for (const m of n.missing) p.push(`- ${m}`);
    p.push('');
  }
  p.push(
    '## Verifying',
    '',
    '`SHA256SUMS` lists every file above. Container images are pulled by digest and signed in the release workflow without keys (Sigstore, GitHub OIDC). Before deploying, verify each one:',
    '',
    '```sh',
    n.signer
      ? `cosign verify <image>@<digest> --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-identity https://github.com/${n.signer.repository}/${n.signer.workflow}@refs/tags/v${n.version}`
      : 'cosign verify <image>@<digest> --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-identity https://github.com/<owner>/<repository>/.github/workflows/release.yml@refs/tags/v<version>',
    'node scripts/release/verify.ts <release-manifest.json>   # every image of the release, as above, plus its SPDX attestation',
    '```',
    '',
    '## Requirements whose coverage changed',
    '',
  );
  if (!n.coverage.length) p.push('None.', '');
  else {
    p.push('| Requirement | Stories with met criteria, before | After |', '|---|---|---|');
    for (const r of n.coverage)
      p.push(
        `| ${r.requirement} | ${r.before.length} | ${r.after.length} (${r.after.filter((s) => !r.before.includes(s)).join(', ') || 'none added'}) |`,
      );
    p.push('');
  }
  p.push(...renderRoundTrip(n.roundTrip));
  p.push(
    '## Accessibility',
    '',
    'The accessibility conformance report of this release is `ACCESSIBILITY-CONFORMANCE-REPORT.md` (and `accessibility-conformance-report.json`), beside these notes. It states for each WCAG 2.2 and ATAG 2.0 criterion of level A and AA whether it is supported, with the tests behind each statement and the known issues. It does not claim conformance. The integration guide links to it (UX-069).',
    '',
    '## Changes',
    '',
    `${n.changes.length} stories changed; the criteria, per package, are in \`CHANGELOG.md\`.`,
    '',
    '## Licences',
    '',
    'The project is licensed under Apache-2.0 (`LICENSE`, `NOTICE`). Each artefact carries the third-party notices of what it contains, and its bill of materials states every licence as declared and as concluded by the licence gate.',
    '',
  );
  return p.join('\n');
}
