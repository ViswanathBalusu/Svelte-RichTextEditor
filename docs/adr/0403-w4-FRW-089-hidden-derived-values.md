# ADR 0403: Values derived from hidden content (FRW-089)

**Status:** the first two parts are implemented as the story's criteria 1 and 2 say; the third part (a redacted copy of the sealed PDF for each participant) is proposed and waits for the owner. Written by lane w4, 2026-11-18.

## Context

ADR 0019 hides regions and sensitive field values from readers who may not read them. A value that is computed from hidden content, or that copies it, would show the content again. FRW-089 asks that every such value is hidden as well, that the numbering choice is recorded with what each choice leaks, and that the sealed PDF and the evidence bundle say whether each participant receives a redacted copy.

## 1. What a reader's projection hides (implemented)

The hidden set of a connection (`hiddenSetOf`, `packages/authority/src/permissions/visibility.ts`) now carries two more members, used by the projection (`packages/authority/src/projection/projection.ts`):

- `keys`: the keys of the form fields whose value the reader may not read. They are the fields with a hidden value, the fields inside hidden regions, and the fields the document's rules compute from them (`derivedFromHidden`, FRW-089 criterion 1, rules part). When the rules do not compile, every key is in the set, as every value already was.
- `targets`: the reference targets (`node:<id>`, `bookmark:<name>`, `eq:<label>`) that lie inside hidden regions, with the region's own `node:<id>`.

The projection then keeps no `cached` text on:

| Field | When | Why |
|---|---|---|
| `formValue` (a mirror) | its `field:<key>` target is in `keys` | `cached` is the value as text |
| `ref` | its target is in `targets` | the reader cannot resolve it, and a label of something they cannot see is a placeholder, not a number |
| `styleRef` | any region is hidden from the reader | the text it caches comes from a paragraph the reader may not be able to see, and the projection cannot tell which |

A commit that writes such a `cached` text, or inserts such a field, reaches the reader as the difference of their two projections, so the text is not in any step they receive. The mirror's value is already shown as the redaction marker by the web view (`mirrorText`, ADR 0019). The server does all of this: the client receives only the projection.

The numbers of what the reader can see (`seq` fields, headings, list items, footnotes) are not blanked: see part 2.

## 2. Numbering across a confidential region (recorded; decided by the owner)

There are two choices for the numbers a reader sees when a hidden region lies between visible items.

| Choice | The reader sees | What it leaks | What it costs |
|---|---|---|---|
| Count the hidden items (the full document's numbers; gaps may show) | Section 3 after Section 1, when a hidden Section 2 lies between | That something is hidden there, and, from the counter effects the server sends, how many items of each level the hidden region holds (ADR 0032 says this is slightly more than the visible labels show). The component that no visible label reads can be dropped if the owner does not accept it. | Nothing: the numbers agree with the document the participants quote and with the sealed PDF of the full document. |
| Do not count them (the projection's own numbers) | Section 2 after Section 1 | Nothing about the size of the hidden region. | The numbers differ from the full document's, so a reference ("see Section 3") made by someone who sees more points to a different section for this reader. |

The owner chose the first on 2026-11-15 (decision 11 of [owner-decisions-2026-11-15.md](../owner-decisions-2026-11-15.md)). ADR 0019 §1 and ADR 0032 (projections) apply it: `computeLabels` with the effects of `counterEffects`. A `ref` whose target is hidden is the one place where a number would name something the reader cannot see; part 1 gives it a placeholder.

## 3. A redacted copy of the sealed PDF and of the evidence bundle (proposed, not decided)

Part B of `docs/owner-blockers-2026-11-17.md` gives the proposed default: one sealed full PDF for the owner and a sealed view per participant. This record repeats it so that FRW-089 and FRW-049 agree; it is not the owner's answer.

- The full sealed PDF contains the whole document and goes to the owner and to anyone with `manage`.
- Each participant receives a sealed PDF made from their own projection (`projectDocument`), with the placeholder where a region is hidden and the redaction marker where a value is. It is sealed separately, so a participant never holds a file that contains what they could not read.
- The evidence bundle's record lists, for each participant, which of the two they received and the visibility class of their projection, and holds no hidden value. The hashes of the full document and of each view are both recorded, so the views can be tied to the sealed original.

Until the owner decides, no export or evidence bundle for a participant is produced from the full document.

## Consequences

- Criteria 1 and 2 of FRW-089 are met and tested. Criterion 3 stays open.
- A reader's projection costs one more set per visibility class (`keys`, `targets`); both derive from the same document and regions, so the visibility key does not change.
- The blanking of `styleRef` is conservative: a reader who has any region hidden sees no cached running-head text. If the owner wants it kept where the source paragraph is visible, the model must say which paragraph a `styleRef` came from, which it does not.
