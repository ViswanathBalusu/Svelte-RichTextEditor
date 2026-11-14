# ADR 0043: The asset worker: formats, decoders, sandbox, limits and serving

**Status:** proposed, 2026-11-06. Records the choices made while building `services/asset-worker` (PLAN-1b packet S: BE-043, the worker's side of BE-042 and BE-045, SEC-038, SEC-040). The spec names no formats and no numbers for assets; every value below is a setting with a default, not a measurement, except where a measurement is given with how and where it was taken. The project owner has not reviewed any of it.

## Context

06 §4.4 and 10 §3.5 require that an upload waits in quarantine, that the asset worker checks the real type against the declared one, decodes and re-encodes the file in a sandbox without network or credentials, computes the hash itself and alone writes the content-addressed object, with limits on pixels, frames, archive entries, sizes and ratios. 09 §2 requires SVG to be converted to PDF when the asset is processed. 10 §3.1 says SVG is never rendered as live SVG. 10 §3.5 and §3.7 require assets to be served with fixed content types and `nosniff` from a separate origin by short-lived signed URLs. The licence policy (`licences/policy.json`) allows permissive licences only. The export worker (`services/export-worker`) already runs a sandboxed, single-use Podman container per job.

## Decision

### Accepted types

PNG, JPEG, GIF, SVG and Word files (`application/vnd.openxmlformats-officedocument.wordprocessingml.document`, the input of `POST /documents/{id}/imports`). Everything else fails with `unsupported_type`, including WebP, AVIF, HEIC, BMP, TIFF and PDF. The declared type is normalised (lower case, parameters dropped, the aliases `image/jpg`, `image/pjpeg`, `image/x-png`) and must equal the type detected from the bytes, or the asset fails with `type_mismatch`.

### Decoders and own code

| Part | Choice | Licence |
|---|---|---|
| PNG decode and encode | pngjs 7.0.0, pure JavaScript, no dependencies | MIT |
| JPEG decode and encode | jpeg-js 0.4.4, pure JavaScript, no dependencies | BSD-3-Clause |
| GIF encode | omggif 1.0.10 (`GifWriter`), pure JavaScript, no dependencies | MIT; the tarball has no file named LICENSE, so `licences/exceptions.json` records it (BE-043, until 2027-05-06) |
| Structure checks before any decoding: PNG chunks and CRCs, JPEG markers, GIF blocks, ZIP directory; GIF LZW decoding; bounded inflation | own code over `node:zlib` | project licence |
| SVG: strict XML parser, styles, geometry, sanitised SVG writer, PDF writer | own code | project licence |

The image decoders are JavaScript, run by Node.js inside the sandbox, and memory-safe; the only native code that reads upload bytes is zlib's inflate inside Node.js (PNG image data, archive entries). The worker reads the structure first and checks it against the limits, then hands only well-formed input to the decoders. pngjs inflates interlaced images without a bound, so the worker measures the inflated size itself first, stopping at the size the header announces.

### Re-encoding

Every stored file except a Word file is new, written from decoded pixels or from the parsed drawing; no byte of the upload is copied. Metadata (Exif, XMP, ICC profiles, text chunks, comments, thumbnails) and bytes after the end of the image are dropped. JPEG: the Exif orientation is applied to the pixels; re-encoded as baseline JPEG at quality 90. PNG: 8-bit output in the smallest of grey, grey and alpha, RGB, RGBA; 16-bit input is scaled to 8 bits; an animated PNG keeps its default image (`animation_dropped`). GIF: every frame is re-encoded with its palette, delay, disposal and transparency; a PNG of the first frame is stored as the print rendition, because LuaLaTeX does not read GIF. SVG: see below. Word file: kept unchanged (EXP-108, ADR 0017), after its archive checks.

### SVG

The upload is parsed strictly: a document type declaration, an entity other than the predefined ones, a script, an event handler, `foreignObject`, `iframe`, `object`, `embed`, a reference to another document (`href`, `url()`, `@import`) or a `javascript:` value fails the asset as `unsafe_content`; text and `image` fail as `unsupported_content` (text needs the font registry; convert text to outlines). Supported: shapes and paths, `g`, nested `svg`, `use` and `symbol` (internal references, cycles ignored), solid colours, linear and radial gradients, `clipPath`, a subset of CSS (`tag`, `.class`, `#id` selectors), transforms. Animation, filters, masks, markers and patterns are dropped with a note. The drawing is reduced to paths and written twice: a sanitised SVG of paths, gradients and clip paths only, for display, and a one-page PDF 1.4 at 96 CSS pixels per inch, for the typesetter (09 §2). The display SVG is served as an attachment under a sandboxing policy, for `<img>` only, where browsers run no script and load nothing; the uploaded text is never stored or served. Every drawn element, references included, counts against a limit, so a chain of references that multiplies its content fails (`drawing_limit`).

### Word files and archives

The directory is checked before anything is expanded: the entry count from the end record alone, declared sizes and ratios, the total, names (no absolute paths, `..`, backslashes, colons, control characters, duplicates ignoring case), methods (stored and deflate), no encryption, no ZIP64, no comment, and a contiguous layout from byte 0 with nothing before, between or after the entries, which refuses overlapping entries and ZIP polyglots. Then every entry is inflated without being kept, stopping one byte past its declared size, and its length and CRC-32 must match. Macro parts and a `macroEnabled` content type fail as unsafe; a document type declaration in `[Content_Types].xml` fails. Nested archives are never expanded. SEC-038 says nested archives fail; under A2 a Word file's embedded objects (`word/embeddings/`, for example the workbook of a chart) are preserved opaquely (ADR 0017, 10 §3.5), so they are allowed there and fail anywhere else (`nested_archive`). This reading is a decision for the owner to confirm.

### The sandbox

One container per job, from a local image built from `services/asset-worker/Containerfile` (Node.js 24.21.0 on Debian 12 slim, pinned by digest, npm, npx, corepack and yarn removed; the build context holds only `src/sandbox/` and the three decoders), run with Podman (`DOCEDIT_CONTAINER_CLI` overrides): `--pull=never`, `--network=none`, `--ipc=none`, `--read-only` with no tmpfs and an empty read-only file system over `/run/secrets`, `--cap-drop=ALL`, `no-new-privileges`, the default seccomp profile, user 10001, cgroup limits on memory (swap included), CPU and processes, rlimits on processes, open files, CPU time, file size and core files, `--timeout`, and no environment but the heap size. Inside, Node.js runs under its permission model (read access to its own code only; no writes, child processes, workers, add-ons or WASI) and without code generation from strings. The upload goes in on standard input and the reply comes back on standard output; the supervisor reads it as hostile (frame size, JSON header, expected outputs per type, sizes, leading and trailing bytes, dimensions, and for SVG and PDF the absence of anything the writers do not produce). The sandbox holds no credential of any kind: the supervisor reads the quarantined object and writes the final ones, which is stronger than BE-043's "a write-only location for this job". On the development machine the Podman machine (WSL) is rootful and its systemd cgroup manager delegates no controllers to the remote client, so jobs go through `podman machine ssh ... podman --cgroup-manager=cgroupfs` (DOCEDIT_PODMAN_MACHINE), as for the export worker; `--userns=auto` is an option (`userns`) that this machine cannot use, because it has no subordinate ID ranges for the `containers` user.

### Limits (settings)

| Setting | Default |
|---|---|
| Upload bytes: raster image, SVG, Word file | 20 MiB, 4 MiB, 64 MiB |
| Pixels; longest side | 20 000 000; 16 384 |
| Decoder memory estimate | 448 MiB |
| Frames; pixels across frames | 500; 200 000 000 |
| JPEG scans; PNG chunks | 100; 65 536 |
| Output bytes per output | 48 MiB |
| Archive entries; total; per entry; ratio (above 64 KiB) | 4 096; 256 MiB; 128 MiB; 100 |
| SVG elements; depth; drawn elements after references; path commands | 20 000; 64; 50 000; 500 000 |
| Sandbox wall clock; memory; heap; CPU; processes (container); processes (sandbox user); open files | 60 s; 1024 MiB; 512 MiB; 1; 32; 512; 64 |
| Signed URL lifetime; window; longest accepted | 300 s (as the control plane's); 60 s; 1 hour |
| Quarantine upload lifetime | 900 s |

The pixel limit and the decoder budget were set from a measurement, so that an image at the limit fits the default memory. Measured on 2026-11-06 on the development machine (Windows 11; Podman 6.0.2 WSL machine with 10 CPUs and 2 GiB, machine route with cgroupfs; sandbox at 1 CPU and 1024 MiB; baseline 4:4:4 JPEG files made by jpeg-js at quality 85, worst case for memory): JPEG of 16 MP passed in 9.8 s and of 20 MP in 13.0 s; 24 MP and 32 MP were killed at the memory limit; an RGBA PNG of 24 MP passed in 13.0 s; with the 448 MiB budget, a 20 MP JPEG at the limit passed, and 16-bit PNGs of 20 MP (RGB) and 16 MP (RGBA) passed in 8.5 s and 6.8 s; GIFs of 200 frames of 1000 × 1000 and 500 frames of 632 × 632 (200 MP in all) passed in 12.7 s and 11.2 s. Times include starting the container through `podman machine ssh`. jpeg-js accounts for about 420 MiB at 20 MP and 504 MiB at 24 MP (4:4:4), and used more than twice that at 24 MP, so a budget of 448 MiB of its accounting admits 20 MP and refuses 24 MP before allocating anything.

### Serving

A small HTTP server of this package (`origin.ts`) is the separate origin: `/a/{tenant}/{sha256}.{ext}?exp=&kid=&sig=`, with an HMAC-SHA-256 over the tenant, hash, kind and expiry, keys with identifiers for rotation, exactly these three parameters, a cap on the lifetime, and a check that the stored bytes still have their hash. Responses carry a fixed content type per kind, `nosniff`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, `Cross-Origin-Resource-Policy: cross-origin`, `Referrer-Policy: no-referrer`, `Content-Disposition: attachment` for SVG, PDF and Word files, an ETag of the hash, and `Cache-Control: private, max-age=31536000, immutable`; expiries are rounded to a 60 s window so that the browser cache can reuse a URL. The origin must be on a site of its own, never the application's site or a subdomain of it. S3 cannot add `nosniff` to its responses, so pre-signed store URLs are not given to browsers.

## Consequences

Good:
- A hostile file meets structure checks, then memory-safe decoders, inside a container with no network, nothing writable, no credentials and hard limits, and what comes out is checked again and served inertly.
- No dependency with native code, a copyleft licence or further dependencies; the image holds only the sandbox code and three small decoders.
- Assets are deterministic for the same input (the PDF writer and the encoders), which suits content addressing.

Bad:
- jpeg-js is slow and memory-hungry: a 20 MP JPEG takes about 13 s and nearly 1 GiB. Photographs above 20 MP are refused unless an operator raises both the memory and the pixel limit.
- Colour profiles are dropped and 16-bit images become 8-bit; wide-gamut photographs may shift in colour.
- SVG text is not supported, and group opacity, clip unions and gradient stop opacity are approximated (with notes).
- Animated PNGs lose their animation; GIF animation is kept.
- A container per job costs time: small jobs took between about 1.3 and 4.5 s each in the test runs on the development machine, start-up through `podman machine ssh` included.

## Alternatives considered

| Alternative | Why not |
|---|---|
| sharp (libvips) | Native binaries under LGPL-3.0, which the policy denies; a large native attack surface |
| ImageMagick, GraphicsMagick | Native, very large attack surface, a long history of decoder vulnerabilities |
| @jsquash codecs (WebAssembly) | MozJPEG is under the IJG licence, not on the allow list; libwebp (BSD-3-Clause) is a candidate when WebP is wanted |
| fast-png | MIT, maintained, but inflates through pako with no bound on the output |
| upng-js | MIT; supports APNG, but unmaintained since 2018 |
| Jimp | MIT, but bundles the same decoders with a larger tree |
| omggif's `GifReader` | Writes past frame bounds without checks and logs to standard output on corrupt data; the worker's own parser and LZW decoder replace it |
| resvg (resvg-js, resvg-wasm) | MPL-2.0, not on the allow list; would also render text |
| librsvg, Inkscape, CairoSVG | LGPL or GPL |
| Ghostscript | AGPL, excluded from worker images by the legal note |
| svg2pdf.js with jsdom, pdfkit with svg-to-pdfkit | MIT, but they implement far more of SVG than is safe to accept and need a DOM or their own XML parser |
| Serving through pre-signed S3 URLs | No `nosniff`, no sandboxing policy, the store's content type |
| A tmpfs or mounted directory for outputs | Standard output needs no writable path at all |

## Revisit when

WebP, AVIF or HEIC uploads are wanted; SVG text is needed (with the font registry of BE-047); colour management is wanted; production hosts give the sandbox more memory; the export converter starts reading the print renditions (EXP-014); BE-044 attaches assets and the control plane stores the renditions.
