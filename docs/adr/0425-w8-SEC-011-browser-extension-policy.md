# 0425. Browser extensions that read or edit the editor's content

**Status:** accepted (owner decision 199, 2026-11-15: "the position of 10 §6: they run with the user's privileges and the guide says so"; docs/owner-decisions-2026-11-15.md). Written by lane w8, 2026-11-25, for SEC-011. It records the position the spec proposed in 10 §6 and ADR 0344 (round 3, question 1); the content is the spec's, and nothing here is new policy.

## Context

Grammar checkers, translators and similar browser extensions read the page's text and may change it. They run in the user's browser with the user's privileges, in a content script that can reach an open shadow root. A web component cannot prevent this and does not try.

## Decision

1. The product does not try to keep a browser extension out. An extension runs with the user's privileges and sees what the user sees.
2. The product guarantees what the editor and the server do with what the extension changes:
   - An edit made by an extension (a mutated DOM, dispatched `input` events) is read as ordinary input, like a typed or pasted change.
   - The schema keeps only valid content. A node or attribute the document model does not allow does not enter the document.
   - The server checks the resulting commit like any other and refuses what breaks a permission, with `permission_denied`. An extension cannot write where the user cannot.
3. The product does not promise that an extension cannot read the content shown to the user, and it does not promise that every change an extension makes is a change the user meant. Output restrictions (`no-copy`, `no-export`, `no-print`) are a deterrent, not a boundary (UX-040).
4. A host that cannot accept extensions reading content must not show that content to that user. This is a matter for the host's token endpoint and the document service, not for the editor.

## Where it is stated

- docs/spec/10-security.md, section 6 (the item is marked as decided).
- apps/reference-host/docs/integration-guide.md, "Limits of the embedding", bullet "Browser extensions (SEC-011)".

## Evidence that the guarantees hold

packages/element/e2e/sec-011-extension.spec.ts (a simulated extension mutates the DOM and dispatches input events in a permitted and a restricted region, in Chromium, Firefox and WebKit). The guide statement is checked by apps/reference-host/test/integration-guide.extensions.test.ts.
