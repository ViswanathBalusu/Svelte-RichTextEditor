# ADR 0417: a relay as a test target of the conformance kit (lane w5)

Status: proposed. Owner decisions are the owner's; each item names the spec default used.

Date: 2026-11-18.

## Context

PRO-124 (criteria 2 and 3) and SYN-044 (criterion 5) waited for a server that speaks DEP in
`mode: "relay"`. The `Relay` class of `@docedit/authority` is only the room side of 04 §14. The
question whether a relay-mode server is built was item 4 of the owner list in
`docs/adr/0316-lane-U-PRO-120-131.md`, with no proposed default. The brief of lane w5 answers it for
this lane: build the smallest relay as a test target in the place the kit expects (`packages/tck/test/targets/`),
not a production service.

## Decisions taken in the lane

1. **The relay is a test target.** `packages/tck/test/targets/relay-server.ts` is the `Relay` behind
   discovery, `POST /tokens`, `POST /documents`, `hello` and `welcome`, `ch.open` and `sync.submit`.
   It lives beside the mock and reference targets and is not shipped. A production relay, and a user
   guide for relay integrators, stay out of scope.

2. **The REST surface of a relay is the bootstrap contract and nothing else.** 05 §11 says the kit
   creates its own documents and mints tokens. A relay has no document model, so `POST /documents`
   creates an empty stream and does not read or keep the `content` of the request; every other route
   (including `GET /documents/{id}/content`) answers `not_found`, "this relay does not offer the
   route". The spec (05 §9) says a relay needs the authority service for content, restore,
   comparison and export, and does not say how a relay creates a document. Spec default: none; this
   is the smallest reading that lets the bootstrap contract run.

3. **A channel opened without `resume` streams the log from its first commit.** A relay has no
   content to reload, so `ch.opened` has `catchUp: "stream"`, the stored commits follow in one
   `sync.commit` and then `sync.caughtUp`. A client whose `resume` names another incarnation, or a
   `seq` beyond the head, is told `catchUp: "reload"`. 05 §5.2 does not say what a relay answers
   when it has no content. Proposed default: as above.

4. **`access` of a relay is the role's capabilities and nothing enforces it.** `ch.opened` needs an
   `access` object. The target fills it from the role of the token (viewer: `view`; editor:
   `view`, `comment`, `suggest`, `edit`; and so on) with `doc`, `body` and `defs` scopes. A relay
   checks no commit against it (04 §14).

5. **The profile's submit scenarios use only what a relay does.** `stale_base` with action `rebase`
   and the head for a base that is not the head (04 §14), storage before acknowledgement, relay to the
   other channels with server attribution, and steps that are not read. They do not test content
   reads, presence, heartbeat or token expiry. The scenario `sync.steps-unread` asks a relay to
   store a step of an unknown type; a relay that validates step types would fail it, and 04 §14
   ("skips steps 4 to 7") says it must not.

## Open questions for the owner

- Whether a relay-mode server ships as a product (item 4 of ADR 0316), and, if it does, where it
  lives and how it creates documents.
- Whether a relay announces any feature (this target announces none; `presence` is the only
  feature a relay could plausibly offer without a document model).
