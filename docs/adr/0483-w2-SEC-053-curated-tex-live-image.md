# ADR 0483: The curated TeX Live image, its licence manifest and its source offer

**Status:** proposed, 2026-11-27 (lane w2; SEC-053 criteria 1 and 3, EXP-073 criteria 1, 3 and 4). The owner has not reviewed it. It records choices that 09 §9.3 item 5 and ADR 0116 left open.

## Context

- 09 §9.3 item 5 asks for a curated TeX Live 2026 installation pinned by digest, a licence manifest and a source offer. Until now the image of `services/export-worker/Containerfile` was the full scheme (about 6 GB), pinned by the digest of its base.
- Owner decision 226 says the first tagged release is a pre-release that rehearses publishing. Decision 228 adds the Noto CJK fonts to the image. The owner approved TeX Live packages from CTAN or TeX Live mirrors on 2026-11-27, but this design needs none.

## Decision

1. **The curated installation is the pinned base, reduced.** The base image stays pinned by digest (`FROM` line of the Containerfile, checked by `exp-078-engine-ledger.test.ts`). The step `image/curate.lua` reads the base's own package database, keeps the packages of `image/curated-roots.txt` and what they depend on, and deletes every other file the database lists. Nothing is downloaded, so no new checksum is needed: what is kept is exactly what the pinned digest holds.
2. **The roots are the class's fixed list, the engine, and what the build and the converter load** (biblatex and biber, tagging, fancyhdr). Hyphenation patterns (every package that registers them) and the babel language files are kept whole, because the engine reads them on demand. Changing the roots is a class change (EXP-078).
3. **The database's `depend` lines are not enough.** The first curated image failed three compiles for packages the database does not list as dependencies: the babel language files (`british.ldf`, `german-germany.ldf`), the German hyphenation of `dehyph-exptl`, and `grfext`, which `epstopdf-base.sty` loads. So `curate.lua` also reads the `.sty`, `.cls` and `.ldf` files of the packages the `depend` lines reach, once, for the packages they load, and follows what it finds by `depend` lines without reading those again; a second round pulled in PSTricks, TikZ and the manuals' packages through optional files. `!pgf` in the roots file keeps the PGF back ends out (a hook package names them in an optional file). `/opt/docedit/licences/tex/tex-packages-why.txt` says why each package is kept. This is a superset of what a compile loads, checked by compiling; a load that no test, reference or document of this tree makes is not proved.
4. **The image is built with `--squash-all`**, so deleted files leave no layer behind (`scripts/build-image.ts`; `scripts/release/image.ts` passes it for images with `texlive: true`). Without it the image is as large as before.
5. **Formats of other engines and the build-time font caches are removed**; `lualatex.fmt` and `luahbtex.fmt` stay. The luaotfload names database is built after the curation, so it lists only fonts that are in the image.
6. **The package database is rewritten** to list the kept packages. `tlmgr info --only-installed`, which the release's bill of materials and notices read, then lists what the image holds. The lists of kept and removed packages and the roots file are kept in the image under `/opt/docedit/licences/tex/`.
7. **The base system (Debian) is not curated.** It holds what the TeX Live image holds. It is listed in the licence manifest and covered by the source offer; curating it is a separate choice.
8. **The release lists a licence manifest and a source offer for an image that holds TeX Live** (`scripts/release/licence-manifest.ts`, `image.ts`, `release.ts`): `<image>-<version>.licence-manifest.json` and `<image>-<version>.source-offer.md`. A release that records such an image without them fails a step. The manifest holds the TeX Catalogue licence of each package, the fonts, the base system packages with their source packages and the house class (Apache-2.0). A package with no Catalogue licence takes that of the package whose files it holds (`licenceFrom` says so: binaries, `hyphen-*` from `hyph-utf8`, the HarfBuzz LuaTeX from LuaTeX, the LaTeX format builder and configuration from LaTeX); four still have none (`texlive-scripts` and `texlive.infra`, with their binaries) and are listed, not guessed.
9. **The source offer is proposed wording.** It names the TeX Live source tree and revision for LuaTeX and the other GNU parts, and the Debian source packages for the base system. Legal note question 4 (the form of the offer) is the owner's to answer.

10. **An upgrade is gated by a script** (`services/export-worker/scripts/upgrade-gate.ts --image <tag>`): the engine ledger of EXP-078, the reference comparison of `pages-1` and the EXP-114 comparison of the shared references, all run against the candidate image with a skipped sandbox counted as a failure. A change of the curated roots is an image change and goes through the same gate; it does not change the `FROM` line, so the ledger does not ask for a class release for it (open: whether it should).

## Measured

On this machine (Windows 11, Podman machine, 2026-11-27, `podman images`): the full-scheme image `localhost/docedit-export-worker:w2` is 6.04 GB; the curated image built by `scripts/build-image.ts` with `DOCEDIT_EXPORT_IMAGE=localhost/docedit-export-worker:w2-curated` is 1.40 GB (1,398,934,474 bytes). `curate.lua` kept 234 of 5,263 packages. `/usr/local/texlive/2026` went from 4.9 GB to 283 MB (`du -sh` in a container of each image). The remaining 1.1 GB is the Debian base system and the Noto fonts.

## Consequences

- A document that needs a package outside the list fails to compile. The class already refuses packages from a bundle, so this is the same rule enforced by the image.
- A TeX Live upgrade changes the base digest, which is a class release (EXP-078 ledger); the roots are checked by compiling every reference.
- The image is no longer a place to install an extra package at run time; there is no tlmgr network access and the sandbox has no network.
- The sandbox's limits tests (`sandbox.escape.test.ts`, `sandbox.args.test.ts`, `capacity.test.ts`) fail on this machine when `DOCEDIT_CONTAINER_CGROUPS=disabled` is set, because the limits are not applied then. That is the machine, not the image; the two unit files pass without the variable.
