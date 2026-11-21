# ADR 0030: Semantics of the rules language

**Status:** proposed, 2026-11-06, as a maintainer's record of the decisions of story FRW-014. Accepted as proposed by the owner on 2026-11-15 (decision 220 of [owner-decisions-2026-11-15.md](../owner-decisions-2026-11-15.md), which accepts ADRs 0030 to 0052); decision 187 settles open item 3. The implementation is `packages/rules`; the fixtures that pin it are published in `spec/rules/` under the rules version `rules/1` (draft).

## Context

12 §5.2 fixes the shape of the language (ADR 0012) but defers four things: "null handling defined per operator", "a fixed precision" for decimal arithmetic, "a restricted regular-expression subset that guarantees linear-time matching", and the meaning of `empty` and of `{ "now": "date" }`. 12 §5.1 also leaves open the exact JSON shape of most operators and of the effects `validate` and `set`, and the stories list more gaps (FRW Open questions 20 and 21): whether `else` may be omitted, the bounds of a rule tree, the unit of `minLength`, and the presets.

Two implementations agree only if all of this is written down. The decisions below are the ones `packages/rules` implements and its fixtures pin.

## Decision

### 1. Types, null and errors

Every expression has a static type: `boolean`, `decimal`, `string`, `date` or `signature`. A field's type comes from its kind:

| Kind | Type | Empty values |
|---|---|---|
| `text` | string | null, `""` |
| `choice` | string (an option identifier) | null |
| `number` | decimal | null |
| `date`, `dateSigned` | date | null |
| `checkbox` | boolean | null, `false` |
| `signature`, `initials` | signature (tested only by `empty`) | null |
| `formula` | the type of the `set` that computes it: decimal or string; a formula no rule sets is always null | null, `""` when a string |
| `attachment` | reserved; a reference to it is refused | |

Null is the empty value. An operand of the wrong type is refused when the rule is checked (`type_mismatch`, with the path of the node), so no rule that passes the check ever meets one while it runs. Nothing is converted at run time and nothing is truthy. A stored value that does not have its kind's type (invariant I15 refuses those) is read as the error `invalid_value`.

Errors are values, not exceptions: `division_by_zero`, `overflow`, `too_long` (a `concat` result over 4 KiB), `invalid_value` and `no_clock` (`now` without a usable clock). An operator that meets an error returns it; with several, the first in operand order, except where `and`, `or` and `if` stop before reaching it. A rule whose condition is an error applies neither branch, and a formula it sets holds the error (its value is null).

| Operator | Operands | A null operand | A wrong type |
|---|---|---|---|
| `==` | two of one type: boolean, decimal, string or date | null equals null and nothing else; the result is true or false, never null | refused when checked; a signature is tested with `empty` |
| `!=` | as `==` | the negation of `==` | as `==` |
| `<` `<=` `>` `>=` | two decimals or two dates | null (unknown) | refused; strings and booleans have no order |
| `and` | two or more booleans | false if an operand is false, otherwise null if one is null (Kleene logic); evaluated left to right, stopping at the first false | refused |
| `or` | two or more booleans | true if an operand is true, otherwise null if one is null; stops at the first true | refused |
| `not` | one boolean | null | refused |
| `in` | a string, decimal or date, and a list of literals of its type | false | refused (a boolean, a list item of another type, an option the choice field does not have) |
| `empty` | one operand of any type | true | none: every type has its empty values (table above) |
| `matches` | a string and a pattern literal | null | refused |
| `+` `*` | two or more decimals | null | refused |
| `-` | one decimal (negation) or two | null | refused |
| `/` | two decimals | null, even when the divisor is zero | refused |
| `round` | a decimal and places from 0 to 20 | null | refused |
| `sum` | one or more decimals | skipped; null when every operand is null | refused |
| `min` `max` | one or more decimals, or one or more dates | skipped; null when every operand is null | refused, also for decimals mixed with dates |
| `concat` | one or more strings | skipped; null when every operand is null | refused: a decimal is not a string, and there is no formatting operator |
| `if` | a boolean and two branches of one type | a null condition takes the second branch | refused, also for branches of different types |
| a rule's `when` | a boolean | applies `else` | refused |
| `set` | a decimal or a string | the formula's value is null | refused (a boolean, a date or the null literal) |

Equality of strings compares code units exactly: no case folding and no Unicode normalisation, so `é` written as one code point differs from `e` and a combining accent. Decimals compare by value (`"12.5"` equals `"12.50"`); dates compare as days.

### 2. Literals

Literals are JSON strings, `true`, `false` and `null`. A string literal is a string, except where the checker needs a decimal or a date: the other side of a comparison with a decimal or a date, an operand of an arithmetic operator, a list item of `in` beside a decimal or date, a branch of `if` beside a decimal or date branch. There it must be a canonical decimal string (`"12.50"`) or a calendar date (`"2026-11-06"`), read once when the rule is checked (`invalid_literal` otherwise). Where nothing else decides, an ordering operator, `min` and `max` read a literal as a decimal if it is one, else as a date. Two string literals compared with `==` are strings: `{ "==": ["5", "5.0"] }` is false.

JSON numbers are refused (`number_literal`), because the CDM holds no floating-point numbers (03 §1 principle 7) and a rule builder must round-trip one spelling. The only JSON number is the integer places of `round`. This keeps the examples of 12 working as written: `{ ">": [ { "field": "lease.total" }, "50000" ] }` compares decimals, and `{ "==": [ { "field": "tenant.maritalStatus" }, "married" ] }` compares an option identifier.

### 3. Decimal arithmetic

A decimal is exact: a big-integer coefficient and a scale. No operation passes through a binary float.

- Operands are the CDM's decimal strings (no exponent, no leading plus or zeros, at most 64 characters), read exactly.
- `+` and `-` are exact. `*` is exact, then truncated toward zero to **20 fraction digits**. `/` gives the quotient truncated toward zero to 20 fraction digits. These 20 digits are the fixed precision of 12 §5.2.
- `round(x, n)` rounds **half away from zero** to n places, n from 0 to 20, as commercial rounding and spreadsheet `ROUND` do.
- Division by zero is the error `division_by_zero`, also for `0 / 0`.
- A result of magnitude 10^40 or more is the error `overflow`. A result therefore always fits the CDM's 64-character decimal strings.
- `+`, `*`, `sum`, `min` and `max` with more than two operands fold from left to right.
- Results are written in canonical form: no trailing fraction zeros, no trailing point, no `-0`. Display uses the field's `format.decimals` (12 §3.2), so `"25"` shows as `25.00`.

Truncating rather than rounding at 20 digits has a useful property: rounding boundaries for 19 or fewer places have at most 20 fraction digits, so truncation never moves a quotient across one, and `round(a / b, 2)` is correctly rounded.

Worked examples, all fixtures:

| Expression | Result |
|---|---|
| `0.1 + 0.2` | `0.3` |
| `1.10 + 2.20` | `3.3` |
| `19.99 × 3` (three items) | `59.97` |
| `round(59.97 × 0.19, 2)` (VAT at 19 % on 59.97) | `11.39` (the product is 11.3943) |
| `round(19.99 × 1.19, 2)` (a gross price) | `23.79` (the product is 23.7881) |
| `119.00 / 1.19` (net from gross) | `100` |
| `round(2.345, 2)`, `round(-2.345, 2)` | `2.35`, `-2.35` |
| `round(2.5, 0)`, `round(-2.5, 0)` | `3`, `-3` |
| `100 / 3` | `33.33333333333333333333` |
| `2 / 3` | `0.66666666666666666666` (truncated); `round(2 / 3, 2)` is `0.67` |
| `round(100 / 7, 2)` (a bill of 100 split seven ways) | `14.29` |
| `sum(10.00, empty, 5.50)` | `15.5` |
| `12345678901234567890.12 + 0.01` | `12345678901234567890.13` (beyond a binary double) |
| `10 / 0` | error `division_by_zero` |
| `9999999999999999999999999999999999999999 + 1` | error `overflow` |
| `0.00000000001 × 0.00000000001` | `0` (10^-22 truncated at 20 digits) |

### 4. Dates and `now`

A date is an RFC 3339 `full-date`, `YYYY-MM-DD`, in the proleptic Gregorian calendar, years 0000 to 9999. Dates compare as day numbers.

`{ "now": "date" }` is the calendar date of an instant in an IANA time zone. The instant is the server's clock (01 §8: the only trusted clock), as an RFC 3339 UTC timestamp with milliseconds, from 1970 to 9999; the zone is the workflow's `timeZone` (12 §6.1). The mapping goes from the instant to the zone's wall clock, and every instant has exactly one wall-clock reading, so daylight-saving changes never make the date ambiguous: a skipped hour, a repeated hour, a skipped midnight (America/Sao_Paulo on 4 November 2018) or a skipped day (Pacific/Apia on 30 December 2011) all give one date. The host's own time zone never enters.

The zone's rules come from the runtime's copy of the IANA time-zone database, through ECMA-402 `Intl.DateTimeFormat` with the Gregorian calendar. Runtimes ship different releases of the database, and an editor's clock can differ from the server's near midnight. When the editor and the authority disagree, the authority's date wins (12 §5.3). The fixtures use historical transitions on which every release since 2018 agrees.

Without a usable clock (none given, an unknown zone, an instant outside the range), `now` is the error `no_clock`.

### 5. Patterns

`matches` and `validation.pattern` share one subset:

- literal characters; `.` (any code point, line feeds included); classes `[...]` and `[^...]` with ranges; the escapes `\d \D \w \W \s \S` with ASCII meanings (`\s` is tab, line feed, vertical tab, form feed, carriage return and space), `\t \n \r \f \v`, `\xHH`, `\uHHHH`, `\u{H...}`, and escaped syntax characters;
- groups `(...)` and `(?:...)` (both only group: nothing is captured); alternation `|`;
- the quantifiers `*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}` and their lazy forms, which match the same values;
- `^` and `$`, which are allowed but change nothing at the ends.

A pattern matches the **whole** value, as the HTML `pattern` attribute does, by Unicode code point, case-sensitively. Everything else is refused when the rule or field is saved, with the construct named: back-references (`\1`, `\k<name>`), look-ahead, look-behind, named groups, group modifiers and flags, word boundaries, Unicode property escapes, control escapes, other escapes, a quantifier after a quantifier (possessive forms), and the syntax errors ECMAScript's Unicode mode also refuses. Each problem carries a stable `construct` name.

Limits: a pattern is at most 256 code points (the CDM grammar of `validation.pattern`); a repetition count is at most **100**; the compiled program is at most **1,000** instructions once counted repetitions are expanded.

The matcher compiles the pattern to a Thompson automaton and simulates all threads at once (a Pike machine without captures). Each instruction is visited at most once per input position, so a match takes at most 2 × instructions × (code points + 1) steps, whatever the pattern. No user pattern ever reaches the runtime's own regular-expression engine. The steps are counted, and the count is the same in every runtime.

Measured on 2026-11-06 on the development machine (Windows 11, Node.js 22.18; `src/pattern.universal.test.ts`, best of three runs): six patterns that make backtracking engines take exponential time, such as `(a+)+b` against a run of `a`, took 0.7 to 3.2 ms on 4,096 code points, and their step counts at most doubled when the input doubled (512 to 4,096 code points). The same test in Chromium, Firefox and WebKit (Playwright 1.65, whose timers resolve 0.1 to 1 ms) measured at most 4 ms. The costliest pattern the limits allow keeps every thread alive: `(?:(?:.*){100}){3}x`, 902 instructions, took 4,923,993 steps and 33 ms (median of nine runs, Node.js) on 4,096 code points.

### 6. Operands and shapes

- `{ "field": key }`; the key must exist (I14).
- `{ "role": "<role_def id>" }` is true exactly when the evaluating participant holds that role. Without a participant (an author's preview) the evaluation context carries the roles chosen for the preview; with nobody, every role test is false. When the document's `role_def` identifiers are known, an unknown one is refused.
- `{ "now": "date" }`; no other form.
- An operator is an object with one member, the operator's name, whose value is the list of operands, always a list: `{ "not": [x] }`, `{ "empty": [x] }`. `in` takes `[operand, [literal, ...]]`, `matches` takes `[operand, "pattern"]`, `round` takes `[operand, places]`, `if` takes exactly three operands, `and` and `or` at least two, `+` and `*` at least two, `-` one or two, `/` two, `sum`, `min`, `max` and `concat` at least one.

### 7. Effects and evaluation

- `then` is a list of effects and `else` is a list, `null` or absent; absent means no effects. A rule is `{ id, when, then, else }`; `ext` is the CDM's and is ignored. Rule identifiers are unique in a document.
- `{ "show": [keys] }`, `hide`, `require`, `enable` and `disable` name a non-empty list of distinct keys. `{ "validate": { "fields": [keys], "message": "..." } }` marks the fields invalid with the message when its branch applies; written in `else`, it reads "unless the condition holds, say this". `{ "set": { "field": key, "value": expression } }` targets a `formula` field only.
- At most **one rule** shows or hides a given field, at most one enables or disables it, and at most one sets a formula (its two branches may both set it). A second is refused when the rules are checked (`conflicting_rules`), and so is showing and hiding one field in one branch (`conflicting_effects`). `require` and `validate` may come from several rules: a field is required if any applies, and messages accumulate, ordered by rule identifier. This keeps the result independent of the order rules are stored in without a precedence rule to specify.
- A field is visible unless its rule hides it, enabled unless its rule disables it or its static `readOnly` is set (a rule cannot lift `readOnly`), and required when its static `required` is set or a `require` applies. A hidden field is never required and carries no messages; the authority clears its value at completion (12 §5.3).
- A formula is always computed from its rule; the stored value is the server's last write and is not read. When the branch that applies has no `set` for it, its value is null.
- `set` effects and the fields they read form a graph; a cycle is refused and the problem names the keys on it (I14). Rules are sorted by identifier, formulas are computed in dependency order, and every condition and expression is evaluated at most once. An evaluation can be limited to the fields a fill check needs, which evaluates only the rules those fields depend on.
- Evaluation is total and deterministic. It counts steps; a caller may pass a budget, and evaluation stops with `budget_exceeded`, which the authority answers with `rate_limited` (04 §12). A compiled rule set states an upper bound on its steps. Measured on the development machine (Windows 11, Node.js 22.18; `test/document.test.ts`, median of seven runs) for a synthetic document at the targets of 2,000 fields and 500 rules (visibility rules, a chain of 150 rounded formulas, 50 `matches` rules on values of 4,000 characters, 50 date rules): reading and checking the rules took 34.6 ms, evaluating every field took 10.5 ms in 7,675 steps, and evaluating what one field's fill check needs took 0.07 ms.
- A rule set with any problem is not evaluated: `evaluateRules` on a document answers `invalid_rules` with the problems. Of those problems, only unknown keys and cycles (I14) and more than 500 rules (I15) are invariants checked on every commit; the others are refused by the rule builder and by the send checklist ("rules validate", 12 §6.2).
- The routing effects `addParticipant` and `skipParticipant` are refused in a `rule_def` (`routing_effect`); they belong to the workflow resource (FRW-037).

### 8. Static checks of an entry

- The type of each kind's value is 12 §3.3, as in §1 above; a `text` or `formula` value is at most 4 KiB of UTF-8.
- `required` refuses an empty value of a visible field (null, `""`, an unticked checkbox). A space is content.
- `min` and `max` apply to `number` fields and compare as decimals. `minLength` and `maxLength` apply to `text` fields and count Unicode code points, as the CDM's string grammars do (ADR 0018). `pattern` and `preset` apply to `text` fields, match the whole value and are not applied to an empty value. A limit on a kind it does not apply to, or `min` above `max`, is a problem of the field's definition.
- `message` is the author's message for `pattern` (owner decision 187 of 2026-11-15, which settles open item 3): an entry that does not match the pattern is reported with it, in the editor and when a participant completes. Without it the report carries this package's own wording. It speaks for the pattern alone; the details are in [ADR 0423](0423-w4-FRW-018-pattern-message.md) (proposed).
- Presets, written in the subset and published with the fixtures (proposed for FRW-004): `email` is the WHATWG HTML definition of a valid e-mail address; `phone` is an optional `+` and `(`, then 4 to 20 digits with at most two of the separators space, `(`, `)`, `.`, `/`, `-` after each digit but the last; `postcode` is 2 to 10 letters, digits, spaces and hyphens, starting and ending with a letter or digit.

### 9. Bounds

| Bound | Value | Source |
|---|---|---|
| `when`, `then`, `else` each | 16 KiB of canonical JSON, 32 levels deep | the CDM grammar of `rule_def` |
| Rules in a document | 500 | I15 (12 §3.6), target |
| Fields in a document | 2,000 | I15, target |
| A value | 4 KiB | 12 §3.3, target |
| A pattern | 256 code points | the CDM grammar of `validation.pattern` |
| A repetition count; a compiled pattern | 100; 1,000 instructions | proposed here, targets |
| A `validate` message; a `validation.message` | 1 to 255 code points, no control characters | the CDM grammar of labels |
| Decimal results | 20 fraction digits; magnitude below 10^40 | proposed here |

### 10. Version and fixtures

The rules version is `rules/1`. The fixtures are published as `spec/rules/rules-1.fixtures.json`, with the JSON Schema of the language (`rules-1.schema.json`) and a manifest. A change to the expected result of a published case, or the removal of one, needs a new rules version: the generator refuses it and a test fails otherwise, as a release that changes a step fixture is a new engine identifier (04 §4).

Fixture categories, proposed for FRW-020: operators (every operator with typical, null and wrong-type rows), decimal (precision, rounding, division, overflow, currency), dates (comparison, leap years, `now` at midnight and across daylight-saving changes in several zones), patterns (what the subset accepts and every construct it refuses), rules (every effect, dependency order, conflicts, cycles, roles, the date), invalid (what cannot be expressed: loops, functions, code, host data, JSON numbers, depth) and values (the static checks and presets).

## Consequences

Good:
- One definition for the editor, the authority, the authority service and other languages. A backend in another language needs big integers, an automaton simulator and an `Intl`-like time-zone lookup, and the fixtures tell it whether it got them right.
- No rule can coerce, loop, stall on a pattern or overflow silently; every problem is found when the rule is saved, with a path.
- The rule builder can round-trip every rule: each value has one spelling.

Bad:
- Authors cannot express "show if any of several rules says so" with several rules; they write one rule with `or`.
- 20 fraction digits and truncation are a choice other systems do not share; a backend that uses its language's decimal type must follow them exactly.
- The editor and the authority can disagree about `now` near midnight or across time-zone database releases. The authority's answer wins.
- The limits allow a rule set whose evaluation is expensive: 500 rules that each match the costliest pattern of §5 against a 4 KiB value would take about 500 × 33 ms, some 16 seconds, to evaluate in full. The step budget stops it, and a fill check evaluates only the rules its field depends on; admission control still needs a number (below).

## What remains open

1. The time zone of `now` without a workflow (form mode, FRW-083): there is no workflow `timeZone`. Proposed: the caller passes UTC until FRW-083 and the protocol decide. Not decided here.
2. The step budget of admission control (04 §12 names none) and whether the rule builder should refuse a rule set whose static step bound exceeds it.
3. Settled by the owner on 2026-11-15 (decision 187, [owner-decisions-2026-11-15.md](../owner-decisions-2026-11-15.md)): the field definition carries an optional message, and the CDM gained `validation.message` (§8 above; ADR 0423). Before that, the CDM's `validation` object had no message member, so FRW-018's "the message the author gave" for `pattern` had nowhere to live.
4. Read restrictions (ADR 0019): a rule that reads a value hidden from the evaluating reader sees the redacted empty value in that reader's editor, while the authority sees the real one. Whether rules may read hidden values at all is open.
5. Localised `validate` messages; Unicode normalisation of strings before comparison; the final presets, which FRW-004 owns.
6. Routing rules (FRW-037) reuse the expression language; the shape of `skipParticipant` is not given in 12.

## Alternatives considered

| Alternative | Why not |
|---|---|
| SQL's three-valued `==` (null compared with anything is unknown) | `x != "single"` would hide a field until x is filled in either way; two-valued equality on null is what form authors expect, and ordering still returns unknown |
| A precedence between `show` and `hide` across rules | Either order makes one of "any" or "all" wrong for the author; refusing a second deciding rule is simpler to specify and to explain |
| Significant-digit precision (IEEE 754 decimal128, 34 digits) | Currency needs a fixed number of places; with a fixed scale and truncation, rounding a quotient is exact |
| Banker's rounding (half to even) | Not what invoices and spreadsheets do |
| JSON numbers as decimal literals | The CDM refuses floats; two spellings break the builder's round trip |
| The runtime's regular-expression engine with a timeout | Backtracking engines differ between runtimes, and a timeout makes the verdict depend on the machine |
| A third-party decimal or RE2 library | Each runtime would need the same build; the arithmetic and the automaton are small enough to own and to pin with fixtures |
