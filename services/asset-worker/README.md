# @docedit/asset-worker

The asset worker of 06 §1 and §4.4, and the separate origin that serves assets (10 §3.5, §3.7). An upload waits in `tenants/{tenant}/quarantine/{asset}`; the worker reads it, checks and re-encodes it in a single-use Podman sandbox without network, writable paths or credentials, computes the SHA-256 of what it produced, writes `tenants/{tenant}/assets/{sha256}` once with a fixed content type, deletes the upload and reports the outcome. Decisions, alternatives, limits and measurements: [ADR 0043](../../docs/adr/0043-asset-worker.md) (proposed).

| Upload | Stored object (display) | Rendition (print, for the typesetter) |
|---|---|---|
| PNG | a new PNG | the same object |
| JPEG | a new baseline JPEG, upright (Exif orientation applied) | the same object |
| GIF | a new GIF, every frame | a PNG of the first frame |
| SVG | a sanitised SVG of paths, gradients and clip paths, served only as an attachment | a PDF |
| Word file | the upload, unchanged, after its archive checks | none |

## How the control plane calls it

The control plane (services/document-service) owns the routes, the `assets` rows, the capability checks and the events. It uses this package in four places.

**1. `POST /documents/{id}/assets`** (BE-042, PRO-061). Check the declaration first, then create the row (`state` `quarantined`, `sha256` empty) and return the upload. A hash the client declares is not a parameter anywhere.

```ts
import { checkDeclaredUpload, presignQuarantineUpload, S3AssetObjects } from '@docedit/asset-worker';

const check = checkDeclaredUpload({ filename, mime, size }); // limits: contentLimits(overrides)
if (!check.ok) throw new ApiError(check.code, check.message); // too_large or validation_failed
// ... capability check (07 §12), INSERT INTO assets (id, tenant_id, mime = check.mime, state = 'quarantined', ...)
const upload = presignQuarantineUpload(uploadStore, { tenant, asset, size, lifetimeSeconds: 900 });
// { url, method: 'PUT', headers: { 'content-length': '…' }, expiresAt, key }
```

`uploadStore` is an `S3AssetObjects` whose credentials may only put objects under `tenants/*/quarantine/`. The signed `content-length` makes the store refuse a body of any other size.

**2. `POST /assets/{aid}/complete`.** Enqueue one job for the asset row's tenant: kind `ASSET_JOB_KIND` (`'asset'`), payload `{ asset, mime, size }` taken from the row. The worker reads nothing else from the payload, and takes the tenant from the job, never from the payload.

**3. The job handler.** Register it with the JobRunner (`control-plane/jobs/runner.ts`):

```ts
import { ASSET_JOB_KIND, AssetJobError, createAssetWorker, podmanSandbox } from '@docedit/asset-worker';

const worker = createAssetWorker({
  objects: workerStore, // reads and deletes quarantine keys, writes assets keys
  sandbox: podmanSandbox(), // DOCEDIT_ASSET_IMAGE, DOCEDIT_CONTAINER_CLI, DOCEDIT_PODMAN_MACHINE
  outcomes: {
    // state ready with sha256, bytes, object_key; store renditions; raise asset.ready
    ready: async (r) => { /* r: AssetReady */ },
    // state failed; raise asset.failed with r.code (05 §5.8) and r.reason
    failed: async (f) => { /* f: AssetFailed */ },
  },
});

handlers[ASSET_JOB_KIND] = async (job, ctx) => {
  try {
    const out = await worker.handle(
      { tenant: job.tenant, id: job.id, payload: job.payload },
      { signal: ctx.signal, report: (stage, progress) => ctx.report(stage, progress) },
    );
    if (!out.ok) throw new JobFailure(out.code, out.message, false); // the file failed: no retry
    return { ...out };
  } catch (e) {
    if (e instanceof AssetJobError) throw new JobFailure(e.code, e.message, e.retry);
    throw e;
  }
};
```

`handle` calls exactly one of `ready` or `failed` once the objects are written or the upload is deleted, and returns the same outcome. A file that fails (wrong type, a bomb, a hostile or broken file, a sandbox stopped at a limit) is not retried. A failure of the store or of the container engine throws `AssetJobError` with `retry: true` and leaves the upload for the next attempt.

`AssetReady` holds `sha256`, `bytes`, `objectKey`, `mime`, `contentType`, `width`, `height`, `frames`, `renditions` (`{ role: 'print', mime, sha256, bytes, objectKey }`) and `notes` (what was removed). The `assets` table of 06 §4.1 has no place for renditions; a `renditions jsonb` column (or a side table) is needed so that the export converter can find the print rendition of a GIF or an SVG (EXP-014).

**4. `POST /documents/{id}/assets/resolve`** (BE-045, PRO-062). After the permission check, and only for `ready` assets attached to the document (BE-044):

```ts
import { assetUrlExpiry, signAssetUrl } from '@docedit/asset-worker';

const url = signAssetUrl({ origin: ASSET_ORIGIN, tenant, sha256: row.sha256, mime: row.mime, expiresAt: assetUrlExpiry(Date.now()), keys });
```

`keys` is `{ current: { id, secret }, previous?: [...] }`, shared with the asset origin; secrets have at least 32 bytes. URLs last 300 s by default (the control plane's own signed URLs default to the same), rounded to a 60 s window so that browsers can cache them.

A URL already issued is not withdrawn when the user's access is revoked: the asset origin keeps no revocation list, so the URL works until its expiry and no longer. The control plane issues no new URL to a revoked user (test/control-plane/sec-046-v-revoke-url.test.ts in services/document-service).

## The asset origin

```ts
import { S3AssetObjects, startAssetOrigin } from '@docedit/asset-worker';

await startAssetOrigin({ objects: readOnlyStore, keys, host: '0.0.0.0', port: 8443 });
```

Run it on a site of its own: never the application's site or a subdomain of it, so that no cookie or storage of the application reaches it. It serves `GET` and `HEAD` of `/a/{tenant}/{sha256}.{ext}?exp=&kid=&sig=` only, with a fixed content type per kind, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, `Cross-Origin-Resource-Policy: cross-origin`, `Referrer-Policy: no-referrer`, `Content-Disposition: attachment` for SVG, PDF and Word files, an ETag of the hash and `Cache-Control: private, max-age=31536000, immutable`. It checks the hash of what it reads and refuses URLs that live longer than an hour. Its store credentials need read access to `tenants/*/assets/` only.

## Limits

Settings, not measurements; each can be overridden (`createAssetWorker({ limits })`, `podmanSandbox({ limits })`). The supervisor sends the content limits to the sandbox with every job.

| Setting | Default |
|---|---|
| `imageMaxBytes`, `svgMaxBytes`, `docxMaxBytes` | 20 MiB, 4 MiB, 64 MiB |
| `maxPixels`, `maxDimension` | 20 000 000, 16 384 |
| `maxDecodeMiB` (decoder memory estimate) | 448 |
| `maxFrames`, `maxTotalFramePixels` | 500, 200 000 000 |
| `maxJpegScans`, `maxPngChunks` | 100, 65 536 |
| `outputMaxBytes` | 48 MiB |
| `zipMaxEntries`, `zipMaxTotalBytes`, `zipMaxEntryBytes`, `zipMaxRatio`, `zipRatioFloorBytes` | 4 096, 256 MiB, 128 MiB, 100, 64 KiB |
| `svgMaxElements`, `svgMaxDepth`, `svgMaxDrawn`, `svgMaxPathCommands` | 20 000, 64, 50 000, 500 000 |
| `jpegQuality` | 90 |
| Sandbox: `wallSeconds`, `memoryMiB`, `heapMiB`, `cpus`, `pids`, `userProcesses`, `openFiles`, `outputBytes` | 60, 1024, 512, 1, 32, 512, 64, 96 MiB + 64 KiB |

`maxPixels` and `maxDecodeMiB` fit the default sandbox memory: raising one without the other makes large images fail at the memory limit instead of before decoding (ADR 0043 has the measurement).

## Failure reasons

`asset.failed` carries the registry code (`too_large` for `too_large`, `pixel_limit`, `frame_limit`, `scan_limit`, `archive_limit`, `drawing_limit`, `output_limit`, `resource_limit`; `validation_failed` for the rest) and one of these reasons: `type_mismatch`, `unsupported_type`, `unsupported_content`, `too_large`, `pixel_limit`, `frame_limit`, `scan_limit`, `archive_limit`, `nested_archive`, `drawing_limit`, `malformed`, `unsafe_content`, `decode_failed`, `output_limit`, `resource_limit`, `missing_upload`, `size_mismatch`, `bad_reply`.

## The sandbox image

```
node services/asset-worker/scripts/build-image.ts
```

builds `localhost/docedit-asset-worker:dev` (DOCEDIT_ASSET_IMAGE) from `Containerfile`: Node.js 24.21.0 on Debian 12 slim, pinned by digest, without npm, corepack or yarn, holding only `src/sandbox/` and the decoders pngjs, jpeg-js and omggif. On Windows and macOS, `podmanSandbox` goes through `podman machine ssh` with `--cgroup-manager=cgroupfs` when the remote client cannot apply cgroup limits (DOCEDIT_PODMAN_MACHINE, detected by `sandboxReady`). Prefer rootless Podman in production; on a rootful host give `podmanSandbox({ userns: 'auto' })` with subordinate ID ranges for the `containers` user.

## Tests

```
pnpm exec vitest run --project node services/asset-worker
```

`content`, `worker`, `origin` and `boundaries` run anywhere. `sandbox.podman.test.ts` needs Podman and the image; `s3.test.ts` needs the S3-compatible store of the test environment (`pwsh -NoProfile -File infra/test-env.ps1 up -NoExport`); `origin-isolation.test.ts` needs Playwright's Chromium. Each skips, with the reason, when what it needs is missing. The test that runs a JPEG at exactly the pixel limit through the sandbox uses close to 1 GiB in the Podman machine and runs only with `DOCEDIT_ASSET_HEAVY_TESTS=1`.
