/**
 * Verification before deployment (SEC-052; ADR 0044 §5): every image of a release must carry a
 * keyless Sigstore signature and an SPDX attestation made by the release workflow, for the release
 * tag, before it is pulled by digest. Run where the deployment runs; it needs cosign
 * (Apache-2.0; COSIGN overrides the command) and network access to the registry and to Sigstore.
 *
 * Usage: node scripts/release/verify.ts <release-manifest.json> --repository <owner/repo>
 *          [--workflow .github/workflows/release.yml]
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

export interface SignerIdentity {
  repository: string;
  workflow: string;
  tag: string;
}

/** The certificate identity of a keyless signature made by a workflow run on a tag. */
export function certificateIdentity(s: SignerIdentity): string {
  if (!/^[\w.-]+\/[\w.-]+$/.test(s.repository))
    throw new Error(`"${s.repository}" is not owner/repository`);
  if (!/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(s.workflow))
    throw new Error(`"${s.workflow}" is not a workflow file`);
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(s.tag))
    throw new Error(`"${s.tag}" is not a release tag`);
  return `https://github.com/${s.repository}/${s.workflow}@refs/tags/${s.tag}`;
}

export function imageRef(image: string, digest: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`"${digest}" is not a sha256 digest`);
  if (/[@:]\S*$/.test(image.split('/').at(-1) ?? ''))
    throw new Error(`"${image}" must have no tag or digest`);
  return `${image}@${digest}`;
}

/** Arguments of `cosign verify` and `cosign verify-attestation` for one image. */
export function cosignArgs(
  image: string,
  digest: string,
  signer: SignerIdentity,
): { signature: string[]; attestation: string[] } {
  const ref = imageRef(image, digest);
  const identity = [
    '--certificate-oidc-issuer',
    GITHUB_OIDC_ISSUER,
    '--certificate-identity',
    certificateIdentity(signer),
  ];
  return {
    signature: ['verify', ...identity, ref],
    attestation: ['verify-attestation', '--type', 'spdxjson', ...identity, ref],
  };
}

interface Manifest {
  version: string;
  images: Array<{ id: string; image: string; digest: string }>;
}

function main(argv: string[]): number {
  const file = argv[0];
  const opt = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const repository = opt('--repository');
  if (!file || !repository) {
    console.error(
      'usage: node scripts/release/verify.ts <release-manifest.json> --repository <owner/repo> [--workflow <file>]',
    );
    return 2;
  }
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  const signer = {
    repository,
    workflow: opt('--workflow') ?? '.github/workflows/release.yml',
    tag: `v${manifest.version}`,
  };
  if (!manifest.images.length) {
    console.log(`${file}: release ${manifest.version} lists no images; nothing to verify`);
    return 0;
  }
  const cosign = process.env['COSIGN'] || 'cosign';
  let failed = 0;
  for (const i of manifest.images) {
    const args = cosignArgs(i.image, i.digest, signer);
    for (const a of [args.signature, args.attestation]) {
      const r = spawnSync(cosign, a, { stdio: ['ignore', 'ignore', 'inherit'] });
      const ok = r.status === 0;
      console.log(`${ok ? 'verified' : 'REFUSED '} ${a[0]} ${i.image}@${i.digest}`);
      if (!ok) failed++;
    }
  }
  if (failed) console.error(`verify: ${failed} check(s) failed; do not deploy this release`);
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
