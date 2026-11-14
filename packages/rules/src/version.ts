/**
 * The rules version identifier (FRW-020). It names the behaviour pinned by the published fixtures
 * (spec/rules/), as an engine identifier names step semantics (04 §4). A change to the expected
 * result of any published case is a new rules version; the generator refuses to write one under
 * the old identifier, and a test refuses a published case that changed under it.
 */
export const RULES_VERSION = 'rules/1';

/** Draft until the owner reviews ADR 0030. */
export const RULES_STATUS = 'draft';
