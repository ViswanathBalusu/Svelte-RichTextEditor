# ADR 0470: Remote pictures in pasted HTML are fetched by the service (FE-054 criterion 6)

Status: proposed. Lane w1, 2026-11-27. Owner decision 123 (docs/owner-decisions-2026-11-15.md) says that remote images in pasted HTML are fetched and stored as assets, that the fetch goes through the egress proxy with its policy, and that the design goes in an ADR before it is built. This is that ADR. Nothing in it is built.

## Context

Pasted HTML from a web page or from Google Docs holds `<img src="https://...">`. Today the paste reads pictures written as `data:` URIs and uploads them through the assets port (`packages/engine/src/clipboard-html.ts`, `picturesFromForeignDocument`); a remote `src` is dropped and the text is kept (ADR 0303 item 6).

The browser must not fetch the picture itself. A request from the author's browser would send the author's address, cookies for that site and a referrer to a server the document's author does not control, it would reach private addresses on the author's network, and most image hosts refuse a cross-origin read. The service already has a network exit that refuses private addresses: `EgressProxy` (`services/document-service/src/control-plane/webhook-egress.ts`; BE-056). It checks the address it connects to, follows redirects only after checking each target and records the reason for a refusal.

## Decision (proposed)

1. **A new optional operation of the assets feature (05 section 6.2):** `POST /documents/{id}/assets/import` with `{ url, name? }`. The service fetches the URL and answers as the upload does: an asset identifier, with `asset.ready` or `asset.failed` arriving on the event channel after the same quarantine as any upload. The operation is part of the `assets` feature and has its own capability flag, `assets.import`, so a service without it keeps today's behaviour and the editor does not ask.
2. **The assets port gains `importUrl(docId, url)`** beside `upload`, with the same result. The mock backend implements it with an injected fetch, so the editor's tests need no network.
3. **The editor.** For each `img` with an `http` or `https` `src` that survives the whitelist, the paste asks the port to import it, after the pasted text is in, as it does for `data:` pictures. The picture is inserted when `asset.ready` arrives, at the place of the `img`. A picture that fails (refused, too large, not an image, timed out, no `assets.import`) is dropped, the text stays, and one notice says how many pictures could not be added. No `src`, `srcset`, `alt`-less identifier or vendor attribute is stored in the document: bookmarks, anchors and foreign identifiers are stripped as they are now.
4. **The service's policy** (defaults to be confirmed by the owner):
   - schemes: `https` only; `http` is refused;
   - addresses: every address class `egress-address.ts` refuses is refused, checked at connection time, and each redirect target is checked again; at most 3 redirects;
   - no cookies, no `Authorization`, no referrer, a fixed user agent that names the service;
   - the answer must be one of `image/png`, `image/jpeg`, `image/gif`, `image/webp`, and its first bytes must agree with the type; SVG is refused (scripted SVG, I9);
   - at most 10 MB for one picture, at most 20 pictures for one paste, 10 seconds for one fetch;
   - the quarantine, the scan and the size limits of an upload apply unchanged.
5. **Who may ask.** Only a person who may upload to the document; the service counts an import as an upload for its limits and for the audit log, and records the URL's host (not the full URL) in the audit record.
6. **No second route out.** The service reaches the network for this only through `EgressProxy`. A deployment whose network policy has no route for it answers `assets.import` as unsupported.

## Consequences

- A DEP change: 05 section 6.2 and the contract in `packages/protocol` (generated files included), the conformance kit's `assets` profile, the document service, the mock backend and the element's port adapter. Because the contract changes, the owner reads this before it is built.
- A web page that needs a login for its pictures yields no picture. This is the intended result.
- The author's pasted text arrives at once; the pictures arrive later and may arrive in a different order. The undo step of the paste is the text; each picture is its own step.

## Not decided here

- The numbers in item 4.
- Whether the editor should offer "paste without pictures" when imports are slow.
- Whether a host may turn the operation off for a tenant (a tenant setting is the likely place).
