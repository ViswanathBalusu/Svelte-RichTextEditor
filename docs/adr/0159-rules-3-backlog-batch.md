# ADR 0159: rules-3 backlog batch (FRW-037, FRW-064 and the rules side of the FRW tail)

**Status:** proposed. **Date:** 2026-11-13. **Lane:** rules-3, round 1.

## Context

The lane was asked to take three to five unclaimed stories from the end of the FRW slice (FRW-060 to FRW-071 and the phase 4 stories, rules side) whose criteria can be met inside `packages/rules`. Each candidate was read against its spec section and its Notes.

## Finding

- FRW-060 to FRW-063, FRW-065 to FRW-071: the code lives in the document service, `packages/tck`, `packages/backend-mock`, the component and the embedding API. None can be met from `packages/rules`. No criterion was ticked and no story was claimed.
- FRW-064 (spreadsheet formula neutralisation): its condition is "only if the platform produces a spreadsheet-format output of field values". No such output is specified in 12, 05 or 09 (Open questions, item 30). The condition is not met, so no neutralisation code was written. A helper with no caller would be a hollow test.
- FRW-037 (route by rules): the routing condition is an expression of the rules language, so the evaluation and the save-time checks belong to `packages/rules`. This story was taken. Criteria 1 to 4 need the workflow service; only criterion 5 is met inside the package.

## Decisions taken in `packages/rules/src/routing.ts` (proposed, spec default unless noted)

The spec does not settle these. Each takes the default below and is listed here for the owner or the main session to confirm.

1. Evaluation order and matching. Every route is evaluated, in the order written. There is no first match. (Default: evaluate all; 12 §5.1 does not say.)
2. Unknown condition. A condition whose value is null (for example a field with no value) does not apply. This follows the rules language, where null does not take the true branch. (Spec: 12 §5.2 defers null handling to ADR 0030 §1.)
3. Failing condition. A condition whose evaluation gives an error, such as a stored value that no longer checks, is reported with its error and does not apply. Nothing is applied on an error. (Not stated in the spec.)
4. `order`. A positive integer, written as a JSON number. The spec's example uses `2` and gives no grammar. (Default: 1 or more.)
5. Cap. A workflow carries at most `LIMITS.rules` routes, the cap already used for rules in a document. (Not stated in the spec; no new number is invented.)
6. Roles in the routing context. Routing has no evaluating participant, so callers pass `roles: []`. A `{ "role": ... }` operand is therefore false in a route. (Not stated; follows 12 §5.1 "the evaluating participant's roles".)

## Open questions left to the owner or the main session

- The point at which routing is evaluated (on each fill, on send, or on completion of a participant), and who the person for an added role is. These are FRW-037's own Notes and remain open.
- FRW-064: whether the platform produces a spreadsheet export at all. If it does, the neutralisation rule (leading `=`, `+`, `-` or `@`) and the handling of negative `number` values need a decision and a story note first.
- Whether `null` routing conditions should instead be reported as a problem to the participant, not silently skipped.

## Consequences

- `packages/rules` gains `src/routing.ts`, `test/routing.test.ts`, and additive exports in `src/index.ts`. No other package changes.
- FRW-037 criterion 5 is ticked. Criteria 1 to 4 stay open, each with its reason in the story's Notes.
- The workflow service must call `compileRouting` on save and `evaluateRouting` when a participant completes or a fill is committed, once it exists. Those calls belong to the service lane.

## Needed from others

- Workflow service (document-service or its successor): call `compileRouting` when a workflow is saved, and apply the actions of `evaluateRouting` (activation, ordering, control commit, webhooks, `wf.changed`).
- Main session: confirm or change decisions 1 to 6, and decide whether FRW-064 applies.
