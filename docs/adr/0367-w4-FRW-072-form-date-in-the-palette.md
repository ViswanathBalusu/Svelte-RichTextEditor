# ADR 0367: The palette's `date` is the form field kind (lane w4, FRW-072)

- Status: proposed
- Date: 2026-11-15
- Story: FRW-072 (criterion 1). Follows ADR 0342 (lane V-FRW-055-072), item 2, which left this open.

## Context

`insertField` of the document API takes a `kind`. `date` names two things: the page date of
FE-136 (a `field` node whose text comes from a server instant) and the form field kind `date` of
12 §3.2, which the palette of phase 1b lists. ADR 0342 kept `date` as the page date and gave the
owner three options: (a) a separate argument for the form kind, (b) a distinct name, (c) defer the
form date. Until one is taken, choosing "Date field" in the palette inserted nothing.

## Decision (proposed)

Option (a). `FieldArgs` gains `form?: boolean`. A caller that asks for a form field sets it, and
then `date` is the form field kind. Without it `date` is the page date, as before, so FE-136 and
its callers do not change. The element's palette command (`runNamed('insertField', { kind })`)
sets `form: true` for every kind, because the palette inserts form fields only.

The other four kinds (`text`, `number`, `checkbox`, `choice`) are form kinds with or without the
argument, as ADR 0342 item 1 made them.

## Consequences

- The palette inserts all five kinds of phase 1b (FRW-072 criterion 1).
- `CoreApi` of the shell is unchanged: the palette still passes `{ kind }`; the element adds `form`.
- If the owner prefers a distinct name (option b), the change is local: the argument goes and the
  element maps the palette's `date` to the new name.

## Not decided here

The default `format` of a form date and what a form date shows before it is filled are FRW-079's.
