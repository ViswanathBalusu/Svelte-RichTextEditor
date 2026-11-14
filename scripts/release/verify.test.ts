// Verification before deployment (SEC-052): the keyless identity of the release workflow.
import { describe, expect, it } from 'vitest';
import { certificateIdentity, cosignArgs, GITHUB_OIDC_ISSUER } from './verify.ts';

const signer = {
  repository: 'owner/repo',
  workflow: '.github/workflows/release.yml',
  tag: 'v0.2.0',
};
const digest = `sha256:${'a'.repeat(64)}`;

describe('image verification', () => {
  it('expects the signature of the release workflow run on the release tag', () => {
    expect(certificateIdentity(signer)).toBe(
      'https://github.com/owner/repo/.github/workflows/release.yml@refs/tags/v0.2.0',
    );
  });

  it('verifies the signature and the SPDX attestation of the image by digest', () => {
    const { signature, attestation } = cosignArgs(
      'ghcr.io/owner/docedit-export-worker',
      digest,
      signer,
    );
    const identity = [
      '--certificate-oidc-issuer',
      GITHUB_OIDC_ISSUER,
      '--certificate-identity',
      certificateIdentity(signer),
    ];
    expect(signature).toEqual([
      'verify',
      ...identity,
      `ghcr.io/owner/docedit-export-worker@${digest}`,
    ]);
    expect(attestation).toEqual([
      'verify-attestation',
      '--type',
      'spdxjson',
      ...identity,
      `ghcr.io/owner/docedit-export-worker@${digest}`,
    ]);
  });

  it('refuses tags, digests and identities that are not exact', () => {
    expect(() => cosignArgs('ghcr.io/owner/x:latest', digest, signer)).toThrow(/no tag or digest/);
    expect(() => cosignArgs('ghcr.io/owner/x', 'sha256:abc', signer)).toThrow(
      /not a sha256 digest/,
    );
    expect(() => certificateIdentity({ ...signer, tag: 'main' })).toThrow(/not a release tag/);
    expect(() => certificateIdentity({ ...signer, repository: 'owner/repo/../x' })).toThrow(
      /not owner\/repository/,
    );
    expect(() => certificateIdentity({ ...signer, workflow: 'release.yml' })).toThrow(
      /not a workflow file/,
    );
  });
});
