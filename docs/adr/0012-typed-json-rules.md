# ADR 0012: Field rules are a closed, typed JSON language with one shared implementation

**Status:** proposed, 2026-09-18, after the first review.

## Context

Rules must be customizable: show or hide a field depending on another, require it, validate it, compute it, route a document to an extra approver above an amount. They are evaluated in the editor for the user's benefit and on the server for enforcement, and the protocol allows backends in any language. The leading e-signature products keep their rule languages small; none exposes scripting.

Options examined on 2026-09-18:

| Option | Finding |
|---|---|
| JSON Logic | A JSON tree without loops, but it inherits JavaScript's coercion and truthiness, and its ports diverge |
| CEL | Not Turing-complete and has a conformance suite, but expressions are strings that do not round-trip with a visual rule builder, JavaScript implementations are young, and it has no decimal type |
| JSONata | Turing-complete; needs depth and time guards |
| Cedar, OPA | Authorisation languages; a fit behind the grants store, not for field logic |
| A minimal typed JSON language | Small enough to specify completely |

## Decision

Rules are JSON trees shaped like JSON Logic with a closed, typed operator set: strict comparison, defined null handling, decimal-string arithmetic, dates in the workflow's time zone, and a restricted regular-expression subset with linear-time matching. There are no loops and no user functions. Effects are `show`, `hide`, `require`, `enable`, `disable`, `validate` and `set` for fields, and `addParticipant` and `skipParticipant` for routing.

One package, `packages/rules`, runs in the editor, the authority and the authority service. Fixtures in the conformance kit pin its behaviour. Field rules live in the document's definitions and are frozen and hash-chained with it; routing rules live in the workflow resource. The graph of computed values must be acyclic, and evaluation is one pass in dependency order. The server's verdict wins, and a rejection names the rule.

## Consequences

Good:
- Safe by construction: no arbitrary code, bounded evaluation, no regular-expression denial of service.
- A rule builder can render every rule as a sentence and round-trip it.
- Deterministic across languages, because the semantics are small and pinned by fixtures.

Bad:
- A language of our own to specify, document and keep small under pressure to grow.
- Backends in other languages must pass the fixtures or use the authority service.

## Alternatives considered

See the table above. CEL can be offered later as an additional feature if customers ask for it.

## Revisit when

Rule needs outgrow the operator set repeatedly in ways that a standard language would cover.
