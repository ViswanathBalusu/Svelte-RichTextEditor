# ADR 0391: `migrate` and `evaluateRules` of the authority service (proposed)

Status: proposed. Lane w5, story PRO-107. The maintainers have not accepted it. It builds on
ADR 0389 (`open`, `materialise`).

## Context

05 §10 lists `migrate` and `evaluateRules` "as named" and gives no signatures. 03 §11.3 says a
migration is gated by an operator and is never triggered by opening a document.

## Choices

1. `migrate` takes `{ content, target }`, a CDM envelope and the version to move it to, and not a
   `stateId`. A document of an older `cdm` cannot be opened as a state, because `open` refuses a
   version it does not read (`unsupported_cdm`, ADR 0389 choice 8). Route:
   `POST /v1/authority/documents/{doc}/migrate`. This differs from ADR 0314, which put every call
   under the state path.
2. The answer holds the canonical content under the target's definition, its hash, the `cdm` and the
   names of the migrations that ran. The service stores nothing: the result is not a state. The
   backend writes it as a snapshot commit with origin `migration` (CDM-049 criterion 4) and calls
   `open`. A failed migration therefore leaves nothing to clean up.
3. The result is read with the target's definition before it is returned (`readDocument`). A migration
   that returns an invalid document is a failure (`migration_failed`, detail `result_invalid`), as is
   one that does not stamp the target version or a downgrade. The framework is the model's
   (`migrate`), exported from `@docedit/model`.
4. The operator enables migrations: `allowMigrations` is false by default, and the call answers
   `migration_not_enabled` and is not listed in the service's capabilities while it is off. The
   registry of migrations and the definitions of the versions the service can write are configuration
   (`migrations`, `definitions`). No migration of CDM 1 exists yet, so the registry is empty by
   default.
5. `evaluateRules` takes `{ roles?, values?, keys?, now?, budget? }` for a held state, and answers
   with the rules package's `Evaluation` for the state's head (`evaluateDocument`): fields in order
   with visibility, enablement, requirement, messages and computed values, and the outcome of each
   rule. `values` replace stored ones by field key, as in the package. A document whose rules do not
   compile is `invalid_rules` with the problems; an exhausted budget is `budget_exceeded`. Route:
   `POST /v1/authority/states/{stateId}/evaluate-rules`.
6. The service adds no rule logic. A document with rule problems often fails earlier: 7 of the 37
   negative fixtures fail the model's invariants at `open`, and the other 30 open and answer
   `invalid_rules`.

## Consequences

- PRO-107 criterion 4 (the service's conformance profile covers both calls) waits for the profile
  (PRO-125), which does not exist: the interface is not reachable over DEP, so the kit has no way in
  yet.
- Choice 1 should be reviewed with PRO-104 to PRO-106, which fix the other signatures.
