/**
 * The in-memory document service behind the mock backends: documents, token minting, revocation
 * watermarks and the service-credential calls a host makes (05 §3, §6.2). Universal: the clock is
 * injected and nothing reaches the network or the disk (PRO-099: "its data is gone" on reload).
 */
import { DEFAULT_LIMITS } from '@docedit/authority';
import { uuid7, type CdmEnvelope } from '@docedit/model';
import { validate } from '@docedit/model/validate';
import { PortError, type DocRole, type Limits } from '@docedit/protocol';
import {
  type BackendHost,
  MockBackend,
  type MockBackendOptions,
  type MockToken,
} from './backend.ts';
import { type GrantSpec, MockDocument } from './document.ts';

export interface MockServiceOptions {
  /** The server clock, Unix milliseconds (default `Date.now`). */
  now?: () => number;
  /** Whether to offer the optional `presence` port and announce `presence` (default true). */
  presence?: boolean;
  /** Limits announced in `welcome` (05 §5.1); the defaults are those of 04 where it names one. */
  limits?: Partial<Limits>;
  /**
   * The math gate (09 §6.3; I8): the reason a LaTeX source is refused, or null. Absent, the mock
   * accepts any source, as before. The host of the document service passes the converter's gate.
   */
  mathGate?: (latex: string, display: boolean) => string | null;
}

export interface MockUser {
  sub: string;
  name?: string;
  groups?: readonly string[];
  /**
   * The role placeholders the user may fill, and whether their participant is active (12 §4.1).
   * A stand-in of the mock: the token claim that carries them outside a workflow is not named in
   * 05 §3.1 (FRW-083), so the mock takes them from the user it is given.
   */
  fill?: { readonly roles: readonly string[]; readonly active?: boolean };
}

/** 15 minutes: the longest lifetime 05 §3.1 allows. */
export const TOKEN_LIFETIME_MS = 15 * 60_000;

export class MockService implements BackendHost {
  readonly limits: Limits;
  readonly features: readonly string[];
  readonly presence: boolean;
  private readonly mathGate: MockServiceOptions['mathGate'];
  private readonly baseNow: () => number;
  private clockOffset = 0;
  private readonly docs = new Map<string, MockDocument>();
  private serial = 0;
  private readonly watermarks = new Map<string, number>();
  private readonly denied = new Set<string>();
  private readonly sessions = new Set<MockBackend>();

  constructor(opts: MockServiceOptions = {}) {
    this.baseNow = opts.now ?? (() => Date.now());
    this.presence = opts.presence ?? true;
    this.mathGate = opts.mathGate;
    this.limits = {
      // 131,072 is the value of the example in 05 §5.9 and 16 an assumption: 05 names no defaults (G18).
      maxMessageBytes: 131_072,
      maxCommitBytes: DEFAULT_LIMITS.maxCommitBytes,
      maxStepsPerCommit: DEFAULT_LIMITS.maxStepsPerCommit,
      maxRebaseSteps: DEFAULT_LIMITS.maxRebaseSteps,
      maxChannels: 16,
      heartbeatMs: 25_000,
      ackTimeoutMs: 15_000,
      presenceHz: 10,
      presenceBytes: 1024,
      catchUpCommits: 5000,
      catchUpBytes: 5 * 1024 * 1024,
      ...opts.limits,
    };
    // The authority enforces regions, suggestions and the field invariants (07 §5; 12 §3). The mock
    // offers the fields port (list, values, prefill) and announces `fields` (FRW-065, FRW-067). It has
    // no workflow, so a fill by a participant needs the `fill` of a `MockUser`.
    this.features = [
      'regions',
      'suggest-enforced',
      'fields',
      ...(this.presence ? ['presence'] : []),
    ];
  }

  now(): number {
    return this.baseNow() + this.clockOffset;
  }

  document(id: string): MockDocument | undefined {
    return this.docs.get(id);
  }

  // --- Host calls with a service credential --------------------------------------------------

  /** `POST /documents` with CDM content; refuses content that fails `model.validate()`. */
  createDocument(
    content: CdmEnvelope,
    opts: { grants?: readonly GrantSpec[]; id?: string } = {},
  ): string {
    const result = validate(content);
    if (!result.valid)
      throw new PortError(
        'validation_failed',
        `invalid CDM content: ${result.violations.map((v) => `${v.invariant} ${v.path} ${v.message}`).join('; ')}`,
      );
    const id = opts.id ?? uuid7();
    this.docs.set(
      id,
      new MockDocument(id, content, opts.grants ?? [], {
        now: () => this.now(),
        limits: this.limits,
        presence: this.presence,
        ...(this.mathGate ? { mathGate: this.mathGate } : {}),
      }),
    );
    return id;
  }

  /** `PATCH /documents/{id}/grants`: replaces the region grants. */
  setGrants(docId: string, grants: readonly GrantSpec[]): void {
    this.must(docId).setGrants(grants);
  }

  /** `PUT /documents/{id}/content`: a snapshot commit with origin `import`. */
  replaceContent(docId: string, content: CdmEnvelope): void {
    const result = validate(content);
    if (!result.valid) throw new PortError('validation_failed', 'invalid CDM content');
    this.must(docId).replaceContent(content);
  }

  /** `PATCH /documents/{id}` with a new state. */
  setDocumentState(docId: string, state: 'active' | 'locked' | 'archived'): void {
    this.must(docId).setState(state);
  }

  /** `POST /sessions/revoke`: tokens issued before now are refused and the user's channels close. */
  revokeSessions(sub: string): void {
    this.watermarks.set(sub, this.serial);
    for (const b of [...this.sessions]) if (b.sub === sub) b.revoke('the host revoked the session');
  }

  /** The host stops issuing tokens for a user: the token source of that user fails. */
  denyTokens(sub: string): void {
    this.denied.add(sub);
  }

  holdWrites(docId: string): { release(): Promise<void>; fail(): Promise<void> } {
    return this.must(docId).holdWrites();
  }

  checkpoint(docId: string): Promise<void> {
    return this.must(docId).checkpoint();
  }

  /** Test mode (05 §11): moves the clock forward and lets sessions notice their token expiry. */
  advanceClock(ms: number): void {
    this.clockOffset += ms;
    for (const b of this.sessions) b.tick();
  }

  private must(docId: string): MockDocument {
    const d = this.docs.get(docId);
    if (!d) throw new PortError('not_found', `no document ${docId}`);
    return d;
  }

  // --- Tokens and sessions (05 §3) ----------------------------------------------------------

  /** `POST /tokens`: a token for `user` with a role in each of `docs` (at most 20). */
  mintToken(user: MockUser, docs: Readonly<Record<string, DocRole>>): MockToken {
    if (this.denied.has(user.sub))
      throw new PortError('forbidden', 'the host issues no token for this user');
    if (Object.keys(docs).length > 20)
      throw new PortError('validation_failed', 'at most 20 documents in `docs` (05 §3.1)');
    const iat = this.now();
    const token: MockToken = {
      serial: ++this.serial,
      jti: uuid7(),
      sub: user.sub,
      grp: [...(user.groups ?? [])],
      docs: { ...docs },
      iat,
      exp: iat + TOKEN_LIFETIME_MS,
    };
    if (user.name !== undefined) token.name = user.name;
    if (user.fill !== undefined)
      token.fill = { roles: [...user.fill.roles], active: user.fill.active ?? true };
    return token;
  }

  verify(token: MockToken): 'ok' | 'revoked' | 'token_expired' | 'unauthenticated' {
    if (token.serial <= (this.watermarks.get(token.sub) ?? 0)) return 'revoked';
    if (this.now() > token.exp) return 'token_expired';
    return 'ok';
  }

  /**
   * A backend for `user`: its token source mints a new token on every call, as a host's
   * `getToken` does (05 §8.1).
   */
  backend(
    user: MockUser,
    docs: Readonly<Record<string, DocRole>>,
    opts: MockBackendOptions = {},
  ): MockBackend {
    return new MockBackend(this, async () => this.mintToken(user, docs), opts);
  }

  register(b: MockBackend): void {
    this.sessions.add(b);
  }

  unregister(b: MockBackend): void {
    this.sessions.delete(b);
  }

  /** Closes every session; the service keeps nothing (PRO-099). */
  async dispose(): Promise<void> {
    for (const b of [...this.sessions]) await b.close();
    this.docs.clear();
  }
}
