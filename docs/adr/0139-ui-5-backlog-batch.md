# ADR 0139: ui-5 backlog batch (UX-005, UX-010, UX-011, UX-012)

**Status:** proposed. **Date:** 2026-11-13. **Lane:** ui-5, round 1.

## Context

The lane was asked to take three to five unclaimed stories from the end of the UX slice (UX-005 to UX-027) whose criteria can be met inside `packages/ui`. Four were taken: UX-012 (access keys), UX-011 (command search), UX-010 (mini toolbar) and UX-005 (host-driven toolbar, mostly already built on the registry). UX-027 (collaborator carets) was read and not taken: its mapping through local steps is the core's (`PeerCaret`, `carets`), and `Carets.svelte` already draws what the core gives it. Nothing in UX-027 could be met by a Node.js test without a browser run.

## Decisions taken (proposed; spec default unless noted)

The spec leaves these open. Each takes the default below and is listed for the owner or the main session to confirm.

1. Access-key level. The level of an access key is the command's toolbar `group` (spec default: a level is a group of the toolbar). A key is unique within a level, not across the registry. Code: `packages/ui/src/commands/access-keys.ts` (`accessKeyLevel`).
2. Access-key form. An access key is one letter or digit, compared without case. The spec does not state a form; this is a new rule and is proposed here. Code: `accessKeyOf`.
3. Registration of a shared key. A second command with the same key on the same level is refused by `CommandRegistry.register` with a `CommandRegistrationError`, naming both commands, and nothing is overwritten (the same rule as shortcut keys, UX-013 criterion 5). The check is in `packages/ui/src/commands/registry.ts`.
4. Activation gesture. Not chosen. Nothing binds a key. This stays the open question of UX-012.
5. Command search ranking. A label that starts with the whole query ranks first, then a label that contains it, then a label that holds every word, then a match on a synonym only. Registration order breaks ties. The spec does not state a ranking (UX-011 Notes).
6. Synonyms. No source. `searchCommands` takes an injected `SynonymSource`; the shell passes none, because the locale tables carry no synonym keys (13 section 8). Where synonyms live is still open (UX-011 Notes).
7. Mini toolbar items. The `format` group is "common formatting" (spec default). A command that changes content is left out when its state's reason is `no-access` or `mode`. Code: `packages/ui/src/commands/mini-toolbar.ts`.

## Consequences

- `packages/ui/src/commands/registry.ts` gains one check and two map updates (access-key claims), exactly as the shortcut keys are handled. Existing tests in `packages/ui/test/registry.test.ts` still pass.
- New exports in `packages/ui/src/commands/index.ts`.
- The rendered surfaces (the mini toolbar's placement, the command search results list, the access-key labels and the gesture) are not built. Their criteria stay open in the stories.

## Open questions left to the owner or the main session

- The activation gesture for access keys (UX-012), and which browser sequences it must avoid (the shortcut table, UX-013).
- Where synonyms live: a field of the registry entry, or string-table keys per locale (UX-011; 13 section 8 points to the tables).
- Whether a level for access keys is the toolbar group or the menu position (UX-012).
- The form of an access key (one letter or digit) is a proposed rule, not a spec rule.
