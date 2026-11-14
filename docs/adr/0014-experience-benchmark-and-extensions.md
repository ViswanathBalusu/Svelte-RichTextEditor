# ADR 0014: Word for the web as the feature benchmark, the product's own design, ports for assistance, host-registered extensions first

**Status:** proposed, 2026-09-18, after the first review. Revised the same day after the owner clarified the goal.

## Context

The owner expects the editor to have the same features as Microsoft 365 and to be an all-round package. The owner was explicit that this is about features: the project is not imitating Microsoft 365, and the editor has its own design.

"The same features" still needs a boundary. Desktop Word's entire feature list is unbounded scope. Word for the web is a defined and much smaller target: Microsoft's own service description shows that it has no offline mode and cannot author captions, citations, content controls, watermarks or mail merge. Beyond the page itself, the capabilities its users rely on are a complete command surface that works from the keyboard, finding a command by typing, modes for editing, reviewing and viewing, presence, comments with mentions and tasks, catch-up, sharing, proofing, an assistant, dark mode and add-ins.

## Decision

- Word for the web is the feature benchmark. A parity profile sorts every capability into built in, delivered through ports and extensions, or non-goal (13, section 2). Parity is judged by what a user can do, never by how a screen looks.
- The visual design, icons, fonts, layout of controls and names are the product's own. Nothing of Microsoft's design is used, so the look-alike concern raised in the first review does not apply. Marketing may say "compatible with" a Microsoft format and does not use Microsoft product or feature names as its own.
- One command registry drives the toolbar in its compact and full layouts, context menus, command search, access keys, the `exec` and `queryCommand` methods and extensions.
- Spelling, grammar and AI assistance are ports, not built-in services. An assistant acts under a delegated agent identity capped at `suggest`, so its writes arrive as suggestions that the existing suggestion rule enforces on the server, and history always distinguishes a person's words from a model's.
- Extensions come in two trust tiers. Host-registered, in-page extensions ship first. Sandboxed third-party extensions come later, if an ecosystem appears.
- Custom content uses reserved extension nodes with a mandatory fallback, so that every writer can still express the document.
- A reference host application, an integration guide and administration interfaces are part of the product.

## Consequences

Good:
- A bounded feature target and a written contract against scope creep.
- Freedom to design the interface well for this product, including for fields, regions and workflows, which Word for the web does not have.
- AI features fit the permission and history model instead of bypassing it.
- Hosts can build their own toolbar and panels from the same commands.

Bad:
- The feature set is a large amount of interface work, all of it under accessibility obligations, and it needs a designer: a feature list does not produce a good interface.
- Every feature competes with the typing-latency and bundle-size budgets, so most of it loads on demand.
- An extension interface is a compatibility promise.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Desktop Word as the feature benchmark | Unbounded |
| A minimal editor without these features | Does not meet the expectation |
| Reproducing Microsoft's interface | Not a goal. The owner wants the features, not the look |
| A built-in AI service | Ties the product to one provider and one data-handling model |
| Sandboxed extensions first | High cost before there is anyone to write them |

## Revisit when

The first market turns out to need capabilities that only desktop Word has, or a partner wants to publish third-party extensions.
