/**
 * What the port contract suite needs from the backend under test (PRO-098; 05 §11 bootstrap
 * contract). Everything maps to a public interface: a backend for a user is a token minted through
 * `POST /tokens`; the other calls are control-plane calls with a service credential. The optional
 * members are test hooks of the fault-injection profile and the test-mode switch (05 §11); a case
 * that needs one is skipped when it is absent.
 *
 * The suite imports only the port typings and this interface, never an implementation.
 */
import type { CdmEnvelope } from '@docedit/model';
import type { Backend } from '../ports/core.ts';
import type { DocRole } from '../ports/types.ts';

export interface ContractUser {
  /** The token's `sub`. */
  sub: string;
  name?: string;
  /** The token's `grp`. */
  groups?: readonly string[];
}

/** A region grant as the host sets it (07 §1). */
export interface GrantSpec {
  region: string;
  /** `user:<sub>`, `group:<id>`, `everyone`, `role:<id>`. */
  principal: string;
  role: 'viewer' | 'commenter' | 'suggester' | 'editor';
}

/** Holds a document's log writes so that commits stay pending (fault injection, 04 §5). */
export interface WriteHold {
  /** Lets the held writes complete. */
  release(): Promise<void>;
  /** Makes the held writes fail: the room rejects their commits with `unavailable`. */
  fail(): Promise<void>;
}

export interface ContractHarness {
  /** `POST /documents` with CDM content and initial region grants; resolves the document id. */
  createDocument(content: CdmEnvelope, opts?: { grants?: readonly GrantSpec[] }): Promise<string>;
  /** A backend acting for `user`, with the roles of `docs` in its token. Not yet connected. */
  backend(user: ContractUser, docs: Readonly<Record<string, DocRole>>): Promise<Backend>;
  /** `PATCH /documents/{id}/grants` with a service credential: replaces the region grants. */
  setGrants(docId: string, grants: readonly GrantSpec[]): Promise<void>;
  /** `PUT /documents/{id}/content`: a snapshot commit with origin `import`. */
  replaceContent(docId: string, content: CdmEnvelope): Promise<void>;
  /** `PATCH /documents/{id}` with a new `state`. */
  setDocumentState(docId: string, state: 'active' | 'locked' | 'archived'): Promise<void>;
  /**
   * `POST /sessions/revoke` for a user. Tokens issued before it are refused; a backend's token
   * source mints a new one on reconnect, so the refusal of the old token is a wire-level check of
   * the kit (PRO-016), not a port contract.
   */
  revokeSessions(sub: string): Promise<void>;
  /** The host stops issuing tokens for a user: that user's token source fails from now on. */
  denyTokens?(sub: string): void;
  /** Test hook: holds the next log writes of a document. */
  holdWrites?(docId: string): WriteHold;
  /** Test hook: writes a checkpoint, which MAY send `sync.check` (04 §13). */
  checkpoint?(docId: string): Promise<void>;
  /** Test-mode switch: moves the server clock forward (token expiry, leases). */
  advanceClock?(ms: number): Promise<void>;
  /** Releases everything the harness created. */
  dispose(): Promise<void>;
}

export type HarnessFactory = () => Promise<ContractHarness>;

export interface ContractOptions {
  /** A timer, which the universal suite cannot create itself. */
  sleep(ms: number): Promise<void>;
  /** How long a case waits for an expected message (default 5,000 ms). */
  timeoutMs?: number;
  /** How long "nothing else arrives" is watched (default 30 ms). */
  quietMs?: number;
}

/** What a runner gives each case. */
export interface CaseContext {
  /** Marks the case as skipped, with the reason; the runner reports it (PRO-098). */
  skip(reason: string): void;
}
