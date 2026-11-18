# ADR 0404: The authority service, `mapRanges` (proposed)

Status: proposed. Lane w5, story PRO-105. The choices below are the ones 05 §10 leaves open ("as
named", no signatures) and ADR 0015 leaves to the caller. The maintainers have not accepted them.

## Context

A relay or sidecar backend keeps comment ranges and presence positions on the text they were drawn
on only if the authority service maps them (05 §10; PRO-105). The in-process mapping is
`mapRangesThrough` of `@docedit/authority`, the same function the engine uses (SYN-001).

## Choices

1. The call names a state in the path: `POST /v1/authority/states/{stateId}/map-ranges`. The body is
   `{ seq, ranges: [{ from, to }] }`: the seq the ranges are on, and the ranges. A presence position
   is a range of zero width (`from` equal to `to`).
2. The ranges are mapped through the commits after `seq` up to the head, with `mapRangesThrough`.
   The answer is `{ seq, headSeq, ranges }`, where each range carries `from`, `to` and `collapsed`,
   in the order given.
3. A range whose content was deleted collapses (`collapsed: true`, `from` equal to `to`), as ADR 0015
   says. A snapshot commit collapses every range at 0, as the in-process function does.
4. The call reads no permission. A range is two positions. The caller already holds the document
   the positions belong to, and the answer reveals nothing the positions do not.
5. An unknown `stateId` is `unknown_state` ("call open again"), as for the other calls. A `seq`
   before the checkpoint the state was opened from, or past its head, is `not_found`. A malformed
   body is `invalid_request`. These are errors, not answers, as in ADR 0395.

## Consequences

- The call is listed in `IMPLEMENTED_CALLS`, so `GET /v1/authority/capabilities` offers it.
- The mapping is tested against the in-process function on the same commits
  (`services/authority-service/test/map-ranges.test.ts`).
- Not decided here: whether a caller may ask for ranges at a seq below its visibility gate. The
  positions carry no content, so the call does not check the gate (choice 4). The owner or the
  history design may change this.
