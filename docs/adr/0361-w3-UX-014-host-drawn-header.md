# 0361. Lane w3, UX-014: what a host-drawn header reads from the element

**Status:** proposed (2026-11-15). Written by the developer of lane w3 for UX-014. Not reviewed by the owner. Nothing here is an owner decision.

## Context

UX-014 criterion 5 asks that a host that draws its own header can get the save and connection state, the mode, presence and the counts "through documented attributes, properties or events".

05 §8.1 names `toolbar` but nothing that hides the header, and no event for the mode in effect, presence or the counts. The story records this as a gap. ADR 0041 section 4 proposed a `header` shell setting (`default`, `none`); the element did not reflect it. `de-status` already carries the connection and the save state.

## Proposed additions to the embedding API

All names are working placeholders, like every `de-` name. They are additive: a host that ignores them sees no change.

1. **Attribute `header`** on `<doc-editor>`: `default` (also when absent or unknown) or `none`. `none` hides the built-in header. It is reflected without remounting, and removing it brings the header back.
2. **Event `de-mode-change`**, detail `{ mode, requested }`: the mode in effect and the mode the host or the user asked for. The access may make the mode in effect more restrictive.
3. **Event `de-presence`**, detail `{ peers: [{ session, user, status }] }`, `status` being `active` or `idle`. Identifiers and a status only. No name and no selection is carried: the host resolves `user` in its own directory.
4. **Event `de-counts`**, detail `{ comments, catchUp }`: open comment threads and catch-up activity. A member is `null` while the count is unknown.
5. **Property `headerState`** (read-only): `{ status, mode, presence, counts }` as they are now, or `null` until the editor is live. `status` is the `de-status` detail's `connection` and `sync`. A host that starts listening late reads it once.

Each event is raised once when the editor becomes live, with the state at that moment, and then only when its detail changes. Like the other `de-` events they bubble and are composed. None carries document content or a token.

The definitions are in `packages/element/src/events.ts` and `packages/element/src/header-events.ts`; the attribute and the property are in `packages/element/src/doc-editor.ts`.

## Limits

- 05 §8.1 does not list these names. PRO owns that section; until it adopts or renames them they are documented here and in the source only.
- The editing core has no source for the counts yet (comments and catch-up are later stories), so `de-counts` reports `null` for both outside tests. The built-in header reads the same view and shows no count either.

## Alternatives considered

- One `de-header` event with everything: simpler to listen to, but each change would repeat the whole state, and presence changes far more often than the mode.
- Carrying the peer's display name: refused, because names are the host's data (ADR 0041 section 5) and the editor must not hand back what the host already holds.

## Revisit when

PRO writes the header attribute and these events into 05 §8.1, or the comment and catch-up sources are built.
