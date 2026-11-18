# 0383 UX-011: where the synonyms of a command live

**Status:** proposed (2026-11-17, lane w3). Owner decision 170 (`docs/owner-decisions-2026-11-15.md`) says the synonyms live in the locale tables (13 §8). The key shape below is this lane's proposal within that answer.

## Context

13 §2 says command search "matches labels and synonyms". 13 §8 says all interface strings are external. UX-011 criterion 2 asks that a command with synonyms in the current locale is listed when a synonym is typed. `searchCommands` already took an injected `SynonymSource`; the shell passed none, because no locale table carried synonyms.

## Decision (proposed)

- Synonyms are strings of the locale table, one key per command: `synonyms.<command id>`, for example `synonyms.format.bold`. The value holds the words, separated by semicolons. Spaces around a word are ignored.
- `synonymsFromStrings` (`packages/ui/src/commands/search.ts`) reads them through the translator. The command search passes it. A locale that lacks a key falls back to the en-GB words, as every other string does.
- A host can replace them with the strings property (UX-063), as any string.
- A synonym matches only after the label does not (rank 3, ADR 0139), so it never hides a label match.
- Extension commands (UX-051) have no table entry. They are found by their label, which the extension supplies translated.

## Other options

1. A `synonyms` array in the command entry. It is not translatable, so it breaks 13 §8.
2. One key with a list per locale in a separate JSON file. It adds a second loading path for no gain.

## Consequences

Translators of a new locale add `synonyms.*` keys with the words people use there. A test (`packages/ui/test/command-search.test.ts`) fails when a key names a command that does not exist. The en-GB list is a first set for the built-in commands; it is not reviewed by a writer or checked with users.
