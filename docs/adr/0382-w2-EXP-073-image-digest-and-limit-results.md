# ADR 0382: The image digest in the manifests, and the result of a job that reaches a limit

**Status:** proposed, 2026-11-17 (lane w2; EXP-073 criterion 2, EXP-076 criterion 4, EXP-061 criterion 4). The owner has not reviewed it. It closes two points that earlier records left open, by recording more than either reading asked for, so neither reading is chosen over the other.

## Context

- EXP-073 criterion 2 and EXP-076 criterion 4 say "image digest". ADR 0116 decision 4 left open whether that means the identifier of the local image (`podman image inspect` `.Id`, the digest of the image configuration) or a registry digest. The worker recorded only the identifier, in the result manifest, and no code gave the converter its `imageDigest` option, so every bundle recorded `null`.
- EXP-061 criterion 4 asks that a job that reaches a limit of EXP-071 records that its page references did not converge. EXP-071 criterion 2 says such a job ends `failed`. ADR 0320 (round 7) read the two as conflicting and asked for a decision.

## Decision

1. **Both values are recorded.** The result manifest (`manifest.json` of the outputs) holds `image: { name, id, digest }`. `id` is the image identifier, as before. `digest` is the manifest digest of the image (`podman image inspect --format {{.Digest}}`), the value a registry pins and an orchestrator pulls by. It is `null` when the image has none. The worker passes the same `digest` to the converter, which writes it to `imageDigest` in the bundle's `manifest.json` (EXP-073 criterion 2). The digest is not a content file, so it is outside `bundleHash` (as `image-digest.test.ts` already shows).
2. **No registry digest is invented.** A locally built image has a manifest digest but no registry digest. A deployment that pulls the image from a registry by digest gets the same manifest digest from `podman image inspect`, so the value stays the one that was pinned. The ADR does not decide which of the two the owner prefers as "the" digest; it records both.
3. **A job that reaches a limit still ends `failed`, and its result says so.** `JobFailure` already carries a result (ADR 0045 §7). For `too_large` the result is now `{ diagnostics, converged, passes }`: `converged` is what the sandbox's pass timings reported (false when the pass that was running was killed before `converged 1` was written) and `passes` is the number of passes whose timing was written. EXP-071 criterion 2 is unchanged, and no API change is needed in the document service.

## Consequences

- A reader of a failed export's job resource sees `converged: false` and how many passes ran, and the limit's diagnostic.
- The manifests record two image values. A change to what "image digest" means later is a change of which value a consumer reads, not of what is recorded.
- Tests that replace `imageId` without `imageDigest` record no digest (`null`) and do not call the container runtime.

## Open for the owner

- Whether one of the two values should be dropped, or a registry digest added when the image comes from a registry (the worker has no registry today).
