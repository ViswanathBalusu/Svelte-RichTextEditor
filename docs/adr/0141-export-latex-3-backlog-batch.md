# ADR 0141: Decisions in the export-latex-3 backlog batch (2026-11-13)

**Status:** proposed. Written by the developer of lane `export-latex-3` (round 1). The owner reviews these.

**Context.** The batch ticked criterion 2 of EXP-073 in `packages/export-latex`. The criterion says that the digest of the curated image is recorded in `manifest.json` when a bundle is built. The criterion does not say how the digest is given, how its format is written, whether an absent digest is an error, or whether it takes part in the bundle hash. The choices below are the ones taken. Each is the spec's default or the smallest reading of the criterion.

## Decisions

1. **How the digest enters the converter (EXP-073 criterion 2).** The caller passes `imageDigest` in `ConvertOptions`. The converter does not read the image itself: it is pure and has no environment (convert.ts header; EXP-002). The worker that compiles the bundle supplies the value.
2. **An absent digest is recorded as `null` (EXP-073 criterion 2).** The manifest always has the member `imageDigest`, as it always has `seq` and `chainHead`. The criterion does not say that a missing digest is an error, so the converter does not refuse one. Whether the export worker refuses a bundle with a `null` digest is open. It belongs to the worker (EXP-067, EXP-073) and is not decided here.
3. **Format of the digest.** The value must be `sha256:` followed by 64 lowercase hexadecimal digits. Any other value throws a `RangeError` before any file is built. This follows the OCI form of a registry digest.
4. **Registry digest or local image ID (EXP-073 criterion 2, open).** ADR 0116, decision 4 records that the export worker's manifest holds the local image ID, not the registry digest, and that the owner has not chosen. The converter accepts the form of a registry digest only. If the owner chooses a local image ID, the pattern in `packages/export-latex/src/convert.ts` (`IMAGE_DIGEST_PATTERN`) changes in the same change as the worker.
5. **The digest is not a content file (EXP-073 criterion 2).** It is not in `files` and does not change `bundleHash`. The same content therefore gives the same `bundleHash` on any image, so a compile can be cached by bundle and compared across images (EXP-076). The digest is a property of the compile, not of the content. The test `packages/export-latex/src/image-digest.test.ts` checks this.

## Not done here

- EXP-073 criterion 1 (the image is built and pinned by digest), criterion 3 (the licence manifest from the TeX Catalogue), criterion 4 (the source offer) and criterion 5 (the pre-built font name cache, EXP-047) need the image, the catalogue or a release. They are not in `packages/export-latex`.
- EXP-073 criterion 2 is ticked for the converter. The worker that supplies the digest, and the check that a bundle carries one, are not built here.
