# ADR 0366: The key of a copied form field

**Status:** proposed, 2026-11-15 (lane w4, FRW-002 criterion 4). Not decided by the owner.

## Context

A form field has a `key`, a data label that is unique in the document (12 §3.2; invariant I13). Rules, prefill and extraction name a field by its key. When a field is copied and pasted, the copy carries the key of the original, so the paste commit would hold two fields with one key and the authority would refuse it (`duplicate_field_key`). The spec says the copy gets a fresh `id` and that I13 must hold, and leaves open how the copy's key is chosen (FRW open question 20).

The command that inserts a new field already picks a free key: `<kind>_<n>` for the least free `n` (FRW-072).

## Decision (proposed)

1. A field that a local transaction brings into the document, and whose key another field of the document holds, gets a key of its own in the same transaction. The paste, the fresh identifier and the new key travel in one commit, so I13 holds at the end of it.
2. The new key is `<key>_<n>`, with `n` the least number from 2 that gives a key no field of the document uses. `tenant.income` becomes `tenant.income_2`, then `tenant.income_3`. The suffix extends the last segment of the key, so the result keeps the key grammar. A key too long for the suffix is shortened to stay within 128 characters.
3. The field that was already in the document keeps its key. Only a field that is new to the document (no identifier yet, an identifier the document did not hold before the transaction, or a duplicated identifier that the identifier plugin replaces) is renamed.
4. A field that is moved keeps its key: after a cut the key is free, so the pasted field meets no other holder.
5. Nothing else is rewritten. A mirror (`formValue`) or a rule that is pasted with the copy still names the original key, so it follows the original field, not the copy.
6. Remote commits are not touched: the authority has already checked I13 for them.

The rule lives in the identifier plugin (`packages/engine/src/ids.ts`, `copiedFieldKey`, `rekeyCopiedFields`).

## Alternatives

- **`<kind>_<n>`, as for a new field.** Simple, but the copy loses every trace of the data label it was copied from.
- **Refuse the paste.** Keeps keys in the author's hands, but copying a paragraph that holds a field is an everyday action and a refusal would be hard to explain.
- **Ask the author for a key.** The most exact, but a paste cannot wait for a dialog, and the author can rename the copy in the properties panel afterwards (FRW-073).
- **Rewrite mirrors and rules pasted with the copy to the new key.** Arguably what an author means when a whole block is duplicated; it is left out because rules are a phase 2 matter and the choice affects what a signed document computes.

## Consequences

- A paste never fails on I13, and no state the editor shows has two fields with one key.
- The new key is a guess. An author who wants `spouse.income` renames `tenant.income_2` in the properties panel.
- Undo removes the copy and its key together. Undoing a deletion that would bring back a key now taken by another field renames the field that comes back; this is rare and keeps I13.
- Point 5 is the part most likely to change when rules arrive.

## Open for the owner

Whether the suffix rule, the kind rule or a prompt is wanted, and whether mirrors and rules pasted with a copy should follow the copy.
