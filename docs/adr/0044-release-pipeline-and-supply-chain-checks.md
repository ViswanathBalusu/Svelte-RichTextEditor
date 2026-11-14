# ADR 0044: Release pipeline and supply-chain checks

**Status:** proposed, 2026-11-06. Written while building FND-012, SEC-051, SEC-052 and SEC-054 (`scripts/release/`, `scripts/supply-chain/`, `.github/workflows/release.yml`, `.github/workflows/supply-chain.yml`). Not reviewed by the project owner. Where the specification is silent, this record takes a position; the questions for the owner are at the end.

## Context

10 §3.8 asks for a software bill of materials per release, signed container images, pinned base images, and an editor bundle that loads no code from third-party origins. FND-012 asks for versioned, reproducible releases with provenance, semantic versioning, a changelog per package, and release notes that state the protocol and CDM versions. The specification names no bill-of-materials format, no signing tool, no version scheme, no source for the changelog and no way of publishing. The repository has no remote yet, so nothing here has run in CI.

## Decisions (proposed)

### 1. What a release ships

- **npm:** the element only, `@docedit/element`: the Vite library build in `packages/element/dist/lib` (the ECMAScript module, its lazy chunks and the PDF viewer's page), with a generated manifest (no dependencies, because everything is bundled; `exports` names the entry; `license` Apache-2.0), `LICENSE`, `NOTICE` and `THIRD-PARTY-NOTICES.md`. The build's size report stays out. The other packages export TypeScript sources, and Node.js does not strip types under `node_modules`, so they cannot be published until they have a JavaScript build. Whether the reference service is also published as a library is open (01 §9).
- **Images:** one per service whose Containerfile exists: the export worker's TeX Live sandbox, the asset worker's decoder sandbox (its build script stages the context), and the document service when it has one. `scripts/release/distributables.ts` lists them.
- The conformance kit image (`packages/tck/Containerfile`) and the reference host's demo image are not release artefacts in this proposal.

### 2. Versions, changelog and notes

- **One version for the release train.** Every `@docedit/*` package, the element and every image carry the same version, and the tag is `v<version>`, so that a host pins one number. It is a release version, not the protocol version: the notes state both.
- Semantic Versioning 2.0.0: a major version for a breaking change to the embedding API or a published package's interface, or when a protocol major version or a CDM version is no longer supported; a minor version for additions; a patch for fixes. In major version 0 a minor version may break, as Semantic Versioning allows.
- The maintainer sets the version in every package (and in the element's `RELEASE` constant) and tags; the pipeline checks and never writes. A version must be new, and above every earlier release of its own MAJOR.MINOR line, so a fix to an older line stays possible.
- **The changelog comes from the stories, not from commits.** Stories are this project's unit of change, with criteria and evidence; there is no commit convention, and agents do not commit. Each release keeps `stories-snapshot.json` (every criterion's state, by a hash of its text); the next release lists the criteria met since then, under every package the story's Evidence line names. The same snapshots give the requirements whose coverage changed (FND-014 criterion 2).
- **Release notes** state the protocol version, the CDM range and the rules version from the generated manifests in `spec/`, the embedding API version, the conformance kit's version, every artefact with its SHA-256 and bill, the images with their digests once published, how to verify, and the requirements whose coverage changed. The n and n-1 support window is stated as not yet published: 03 §11.3 gives no number.

### 3. Bills of materials: SPDX 2.3, in JSON

SPDX rather than CycloneDX, because:

- the licence gate speaks SPDX expressions, and SPDX keeps the licence a package declares (`licenseDeclared`) apart from the licence concluded for it (`licenseConcluded`): here, the gate's verdict, which for a dual licence is the option a recorded decision took. Borrow list §15 asks for both to be kept;
- Syft writes SPDX 2.3 for images, and cosign attests it (`--type spdxjson`), so every artefact has the same format and one checker;
- SPDX 2.2.1 is ISO/IEC 5962:2021, and 2.3 extends it.

A CycloneDX copy can be converted from it if a tenant asks. What each bill holds:

- **The element:** what the build output contains, not what its manifest declares. Each generated file is attributed through its source map (each source to the nearest `package.json`), any other file by being identical to a file of a package (fonts, WebAssembly, the copied PDF.js worker and data), and the viewer's page and stylesheet by name to the element. Every file is listed with SHA-1 and SHA-256, with the package verification code and the tarball's SHA-256 and SHA-512. Each package has its purl, registry address, the SHA-512 of the lock file, and its declared and concluded licences; workspace packages appear at the release version.
- **A service:** the licence gate's walk (`pnpm licenses list --json --prod`) over the service and every workspace package it needs in production.
- **An image:** Syft's catalogue of the image as an OCI archive; for the export worker also every TeX Live package (`tlmgr` run inside the image without network) and every font of `fonts.json`. TeX Catalogue licence keys become SPDX identifiers only where the match is exact, `LicenseRef-TeXCatalogue-<key>` otherwise; a package with several keys gets them all, joined with AND, because the catalogue does not say whether they are alternatives.

A mismatch fails the release: the element's bill against the lock file (presence and SHA-512), against the build output both ways (packages, and files with SHA-256), and against the files `npm pack` put in the tarball; a service's bill against the lock file; an image's TeX Live packages against `tlmgr`; and, for an image that runs the service's own code, the service's npm packages against Syft's. Bills are deterministic: the creation time is `SOURCE_DATE_EPOCH` (the commit time) and the namespace is derived from the content.

Found while building it: the licence gate's walk does not see packages that are bundled but declared as development dependencies (now `pdfjs-dist` in the viewer; `katex` and `mathlive` when the math pane is bundled), and `pnpm notices` with `--filter <package>` misses the dependencies of the workspace packages it depends on (for the element, every ProseMirror module). The release's notices therefore come from the bundle's contents, and its bill concludes those licences with the same policy.

### 4. Third-party notices

Each artefact carries the notices of what it contains (`scripts/release/notices.ts`): name, version, licence, and every licence, copying and notice file the package publishes. The element's are inside the tarball as well. A package published without such a file says so, with the reason of its recorded exception. The MIT texts with copyright lines that those exceptions require (for `is-reference`, `locate-character`, `pg-types`, `pgpass` and `omggif`) are not written yet.

### 5. Images: Podman, pinned, reproducible, signed without keys

- **Built with Podman only**, through `DOCEDIT_CONTAINER_CLI` (default `podman`), with `--timestamp` set to `SOURCE_DATE_EPOCH`, twice, the second time without the cache. Two different image identifiers fail the release. Publication builds again and refuses an image whose identifier differs from the one the draft recorded.
- **The pinning check** (`scripts/supply-chain/pin-check.ts`) fails on a base (`FROM`, `COPY --from`, `RUN --mount=from=`) without a digest, a remote `ADD` without a checksum, a container definition named `Dockerfile`, a compose image that is neither pinned nor built there, an action not pinned to a full commit, a job image without a digest, Docker's own actions, a call of the Docker CLI, a call of `podman` that ignores `DOCEDIT_CONTAINER_CLI`, and an image reference in code (not in tests) with a tag and no digest. Images built in the repository (`localhost/…`) are judged by their own Containerfile. It runs on every pull request that touches a container definition, a compose file, a workflow or a script (`supply-chain.yml`). A weekly job reports pins whose tag has moved upstream (`base-drift.ts`, with skopeo), as a prompt to review the new base and move the pin.
- **Signing:** cosign without keys (Sigstore's certificate authority and transparency log), with the release workflow's GitHub OIDC identity. Each image is pushed to GitHub's registry by digest, signed, given an SPDX attestation, and both are verified in the same job. The identity is `https://github.com/<owner>/<repository>/.github/workflows/release.yml@refs/tags/v<version>` from the issuer `https://token.actions.githubusercontent.com`. No key or token exists: the registry takes the run's own token, Sigstore and npm take its OIDC token.
- **Verification before deployment:** `node scripts/release/verify.ts <release-manifest.json> --repository <owner>/<repository>` runs `cosign verify` and `cosign verify-attestation` for every image of the release; deploy by digest only. A weekly job verifies the latest release's images. For Kubernetes, the chart (BE) can enforce the same identity with Sigstore's policy controller; a starting point, not tested here:

  ```yaml
  apiVersion: policy.sigstore.dev/v1beta1
  kind: ClusterImagePolicy
  metadata:
    name: docedit-release-images
  spec:
    images:
      - glob: 'ghcr.io/<owner>/docedit-*'
    authorities:
      - keyless:
          url: https://fulcio.sigstore.dev
          identities:
            - issuer: https://token.actions.githubusercontent.com
              subjectRegExp: '^https://github\.com/<owner>/<repository>/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+.*$'
        attestations:
          - name: spdx
            predicateType: spdxjson
  ```

  containers-policy.json(5), as documented when this was written, matches a certificate of Sigstore's authority by e-mail address (`subjectEmail`), and a workflow's identity is a URI, so a Podman or compose deployment verifies with the script above before it pulls.
- **Actions** are pinned to full commits, each release chosen at least seven days old when pinned (the same caution as pnpm's minimum release age); the comment names the release. Syft is pinned to v1.55.0 and npm to 11.21.1 the same way.

### 6. The origin check (SEC-054)

`scripts/supply-chain/origin-check.ts` parses every script of the build output with TypeScript's parser (already a development dependency), and reads every stylesheet and page. It reports remote imports, imports from computed addresses (`import()` and `importScripts` with anything but a literal), script, style, font and WebAssembly addresses of other origins and any address of a public code or font service, and code evaluation (`eval`, the `Function` constructor, timers given strings, imports of `data:` and `blob:` code). Each finding names the package that wrote it, through the source maps. A finding passes only with a reviewed exception for that package and rule, with a reason, a decision and an expiry (`scripts/supply-chain/origin-exceptions.json`), as the licence gate does.

Proposed exceptions, both in PDF.js inside the viewer's frame: the import of `workerSrc` when no worker can be started, and the import of a JavaScript decoder from `wasmUrl` when WebAssembly is not available. The viewer sets both addresses to its own files on its own origin (`packages/element/src/pdf/viewer/main.ts`). WebAssembly modules and their compile sites are listed but pass: they are the viewer's own files, and the frame's policy must allow `'wasm-unsafe-eval'` (S2's list). Remote addresses that load nothing (documentation links, XML namespaces) are listed and pass. The check is static: that every request of a full feature tour goes to the host or the configured service (criterion 1), and that fonts come from the service's manifest (criterion 3), need browser tests.

### 7. Publishing: a draft first, nothing from a developer machine

A tag produces a draft GitHub release, never a published one. To publish, a maintainer runs the release workflow by hand on the tag with "publish" set; the `release` environment's required reviewers approve. That run rebuilds everything and refuses to publish unless the files' SHA256SUMS and every image identifier equal the draft's; then it pushes, signs and verifies the images, publishes the npm tarball with provenance through npm's trusted publishing, adds the images to the notes and makes the release public. `node scripts/release/release.ts --dry-run` runs the local part on any machine and publishes nothing.

## Consequences

Good:
- Each artefact's bill describes what really ships, and a difference between the bill, the lock file and the artefact stops the release.
- A signature is tied to one workflow run on one tag; there is no key to steal or rotate.
- What is published is what was reviewed, byte for byte, or nothing is published.

Bad:
- Images must really be reproducible, or no release is made. Measured on 2026-11-06 on the development machine (Podman 6.0.2 on its WSL machine, `--timestamp 1762387200`, the second build without the cache, bases already present): the asset worker's sandbox image came out identical twice (`sha256:90878cd0…`); the export worker's did not. 15 of its 16 layers match; the one that differs is the font-cache warm-up step (`luaotfload-tool --update` and the warm-up compile). Until that step writes the same bytes every time, the release refuses the export worker's image.
- The first publication of a package name on npm needs the owner to create it and register the workflow as its trusted publisher.
- A release that is not a pre-release fails while a listed image is missing (today the document service's).
- Publishing builds everything a second time.

## Alternatives considered

| Alternative | Why not |
|---|---|
| CycloneDX 1.6 | Equally capable for packages, but the gate's data is SPDX and so is Syft's and cosign's path used here; a converted copy is possible |
| Changelog from commits (conventional commits, Changesets) | No commit convention exists and agents do not commit; Changesets would add a root development dependency and a second record of change beside the stories |
| A version per package | Hosts would need a compatibility table between element, service and images; one number is simpler while everything ships together |
| Signing with a stored key (`cosign --key`, a key service) | A key to guard and rotate; keyless signing ties the signature to the workflow run and the tag |
| Docker Buildx and `docker/build-push-action` | Containers are built with Podman only |
| Only a recorded network tour for SEC-054 | Finds only what the tour exercises; the static check covers every file of the build |
| Running actionlint locally | It would mean running a downloaded binary on the development machine; the workflows were reviewed by hand and parsed instead |

## Questions for the owner

1. Accept the two PDF.js exceptions of §6, or require a viewer build without those paths? SEC-054 criterion 2 stays open until this is decided.
2. One release version for everything (§2), or a version per package?
3. Which packages besides the element are published to npm, and is the reference service published as a library (01 §9)?
4. May a release ship without the document service's image? This proposal allows it only for pre-releases.
5. How long are CDM versions n and n-1 supported side by side (03 §11.3, CDM-050)?
6. The registry and image names: GitHub's registry under the repository's owner is assumed, with working names (SPK-007).
