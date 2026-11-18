# ADR 0380: What a restore tells the person about definitions (HIS-020)

Status: proposed. Lane w7, 2026-11-17.

## Context

HIS-020 criterion 4: a restore whose old content needs a definition (a style, for example) that no longer exists recreates it when the user has `structure`, and otherwise falls back to the default and tells the user. `planRestore` already lists `recreated` and `replaced` definitions, and the dry run returns them as `notes`. The answer of an applied restore did not carry them. The schema names `RestoreResult` as a placeholder (gap G69), so its members are not fixed by the prose.

## Decision

1. The answer of an applied region restore carries `notes: { recreated: string[]; replaced: string[] }` when either list is not empty. Each entry is `<type>/<id>`, as in the dry run. When both are empty the member is absent, so existing clients and tests see no change.
2. The text a person reads is the interface's. The history pane shows the notice from `notes` (HIS-009, UX); this record fixes only the member.
3. A whole-document restore replaces the definitions with those of the target, so it has nothing to report. `reidentified` (blocks that got new identifiers) stays in the dry run only.

## Open

The member names belong to the owner's answer on G69 (the `RestoreResult` schema). Until then they are a proposal, as `preRestoreSeq` is (ADR 0358).
