/**
 * Session records (HIS-003 criterion 3; 08 section 2, last paragraph; owner decision 24 in
 * docs/owner-decisions-2026-11-15.md).
 *
 * The document service stores, per session, the user agent family and the client version, and no
 * other personal data about the user beyond the surrogate. The control plane holds the records in a
 * table of its own (`doc_sessions`, migration 0096), one row per session and document, and keeps
 * them as long as the document's history: the row goes when the document is purged (HIS-039), not
 * before.
 *
 * What a row holds, and nothing else:
 *
 * - the tenant, the document and the session, as the commits of the session name it;
 * - the user, as the tenant's surrogate identifier (08 section 13);
 * - the user agent family, one of a closed list, and its major version, a number;
 * - the client version of `hello`, when it has the shape of a version.
 *
 * The `User-Agent` header is reduced here and is not kept: no part of its text reaches the store.
 * The same holds for a client version that is not shaped like a version, which is stored as
 * unknown. The remote address, the origin, the host's `sub`, the display name and the token are
 * never given to this module.
 */
import type { SessionOpened } from '../seams.ts';

/** The families a record may name. `other` is every agent the list does not know, and none. */
export const USER_AGENT_FAMILIES = [
  'chrome',
  'edge',
  'firefox',
  'safari',
  'opera',
  'samsung',
  'other',
] as const;

export type UserAgentFamily = (typeof USER_AGENT_FAMILIES)[number];

/** A `User-Agent` header reduced to what may be stored (owner decision 24). */
export interface ReducedUserAgent {
  readonly family: UserAgentFamily;
  /** The major version, 0 to 9999, or null when the header gives none for its family. */
  readonly major: number | null;
}

/** The longest header that is looked at; the session cuts it to the same length. */
export const USER_AGENT_MAX = 512;
export const USER_AGENT_MAJOR_MAX = 9999;

/**
 * The product tokens that name a family, in the order they are tried. The order matters: Edge,
 * Opera and Samsung Internet also send `Chrome/` and `Safari/`, and every browser on iOS sends
 * `Safari/`, so the more specific token wins. A token counts only at the start of the header or
 * after a space, a semicolon or an opening parenthesis, so that it is not read out of the middle of
 * another product's name.
 */
const PRODUCT_TOKENS: ReadonlyArray<readonly [UserAgentFamily, RegExp]> = [
  ['edge', /(?:^|[\s;(])(?:Edg|Edge|EdgA|EdgiOS)\/(\d+)/],
  ['opera', /(?:^|[\s;(])(?:OPR|OPT|OPiOS)\/(\d+)/],
  ['samsung', /(?:^|[\s;(])SamsungBrowser\/(\d+)/],
  ['firefox', /(?:^|[\s;(])(?:Firefox|FxiOS)\/(\d+)/],
  ['chrome', /(?:^|[\s;(])(?:Chrome|HeadlessChrome|Chromium|CriOS)\/(\d+)/],
];
/** Safari names itself with `Safari/` and carries its version in `Version/`. */
const SAFARI_TOKEN = /(?:^|[\s;(])Safari\/\d/;
const SAFARI_VERSION = /(?:^|[\s;(])Version\/(\d+)/;

function majorOf(digits: string | undefined): number | null {
  if (digits === undefined || digits.length > 4) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) && n >= 0 && n <= USER_AGENT_MAJOR_MAX ? n : null;
}

/**
 * Reduces a `User-Agent` header to a family and a major version. The result is built from the
 * closed list and from digits only, so nothing a client writes in the header can reach the store
 * as text. A missing header, an empty one and one that names no known family are all `other`.
 */
export function reduceUserAgent(header: string | null | undefined): ReducedUserAgent {
  if (typeof header !== 'string' || header.length === 0) return { family: 'other', major: null };
  const text = header.length > USER_AGENT_MAX ? header.slice(0, USER_AGENT_MAX) : header;
  for (const [family, token] of PRODUCT_TOKENS) {
    const m = token.exec(text);
    if (m) return { family, major: majorOf(m[1]) };
  }
  if (SAFARI_TOKEN.test(text))
    return { family: 'safari', major: majorOf(SAFARI_VERSION.exec(text)?.[1]) };
  return { family: 'other', major: null };
}

export const CLIENT_VERSION_MAX = 64;
/**
 * The shape of a client version that is stored: one to four numbers joined by dots, then an optional
 * pre-release tag after `-` and an optional build tag after `+`, each of letters, digits, dots and
 * hyphens (`1`, `0.4.2`, `1.5.0-beta.2`, `2.0.0+build.7`). The table has the same rule as a check
 * constraint (migration 0096).
 */
const CLIENT_VERSION =
  /^[0-9]{1,6}(?:\.[0-9]{1,6}){0,3}(?:-[0-9A-Za-z.-]{1,32})?(?:\+[0-9A-Za-z.-]{1,32})?$/;

/**
 * The client version of `hello` as it may be stored: the value itself when it is shaped like a
 * version and holds at most 64 characters, otherwise null. `hello.client.version` is any string the
 * client chooses, so free text is not kept: it could name a person or a machine.
 */
export function reduceClientVersion(version: unknown): string | null {
  return typeof version === 'string' &&
    version.length <= CLIENT_VERSION_MAX &&
    CLIENT_VERSION.test(version)
    ? version
    : null;
}

/** A session record as stored. Every member is listed in the module comment; there are no others. */
export interface SessionRecord {
  readonly tenant: string;
  readonly document: string;
  readonly session: string;
  /** The per-tenant surrogate of the session's user. */
  readonly user: string;
  readonly userAgentFamily: UserAgentFamily;
  readonly userAgentMajor: number | null;
  readonly clientVersion: string | null;
}

/** The members of a record, for the checks that no other is ever added without a review. */
export const SESSION_RECORD_MEMBERS = [
  'tenant',
  'document',
  'session',
  'user',
  'userAgentFamily',
  'userAgentMajor',
  'clientVersion',
] as const satisfies ReadonlyArray<keyof SessionRecord>;

/** Storage of the session records. A record is written once and never changed. */
export interface SessionRecordStore {
  /**
   * Stores the record unless the session already has one for the document, in which case the first
   * one stays. A document that does not exist, or that is deleted, gets no record and no error: the
   * channel that asked is refused by the room for that reason.
   */
  record(row: SessionRecord): Promise<void>;
  /** The record of one session on one document, or null. */
  get(tenant: string, document: string, session: string): Promise<SessionRecord | null>;
  /** The records of a document, in session order. */
  list(tenant: string, document: string): Promise<SessionRecord[]>;
}

export class MemorySessionRecordStore implements SessionRecordStore {
  readonly #rows = new Map<string, SessionRecord>();

  static #key(tenant: string, document: string, session: string): string {
    return JSON.stringify([tenant, document, session]);
  }

  async record(row: SessionRecord): Promise<void> {
    const key = MemorySessionRecordStore.#key(row.tenant, row.document, row.session);
    if (!this.#rows.has(key)) this.#rows.set(key, { ...row });
  }

  async get(tenant: string, document: string, session: string): Promise<SessionRecord | null> {
    const row = this.#rows.get(MemorySessionRecordStore.#key(tenant, document, session));
    return row ? { ...row } : null;
  }

  async list(tenant: string, document: string): Promise<SessionRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.tenant === tenant && r.document === document)
      .sort((a, b) => (a.session < b.session ? -1 : a.session > b.session ? 1 : 0))
      .map((r) => ({ ...r }));
  }
}

/**
 * The record of a session that opens a channel, built from what the data plane knows about the
 * connection. This is the only place where a `User-Agent` header and a client version become stored
 * values.
 */
export function sessionRecordOf(open: SessionOpened): SessionRecord {
  const agent = reduceUserAgent(open.userAgent);
  return {
    tenant: open.tenant,
    document: open.doc,
    session: open.session,
    user: open.user,
    userAgentFamily: agent.family,
    userAgentMajor: agent.major,
    clientVersion: reduceClientVersion(open.clientVersion),
  };
}

/** The session records of the service: what the data plane's `sessionOpened` writes to. */
export class SessionRecords {
  readonly #store: SessionRecordStore;

  constructor(store: SessionRecordStore) {
    this.#store = store;
  }

  /**
   * Records the session for the document. It resolves once the record is stored, and rejects when
   * the store fails: the data plane then does not open the channel, so no commit is ever stored for
   * a session that has no record.
   */
  opened(open: SessionOpened): Promise<void> {
    return this.#store.record(sessionRecordOf(open));
  }

  get(tenant: string, document: string, session: string): Promise<SessionRecord | null> {
    return this.#store.get(tenant, document, session);
  }

  of(tenant: string, document: string): Promise<SessionRecord[]> {
    return this.#store.list(tenant, document);
  }
}
