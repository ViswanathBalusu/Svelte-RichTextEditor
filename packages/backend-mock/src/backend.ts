/**
 * The mock backend: an implementation of the core ports and the `presence` port (05 §8.3; PRO-099)
 * over the in-memory service. No network, no storage beyond memory.
 */
import { formatTimestamp, uuid7 } from '@docedit/model';
import type { Connection } from '@docedit/authority';
import {
  OrderedDelivery,
  PortError,
  type Access,
  type AuthPort,
  type Backend,
  type Content,
  type DocRole,
  type ErrorCode,
  type PermissionsPort,
  type PresencePeers,
  type PresencePort,
  type Resume,
  type Session,
  type SyncChannel,
  type SyncPort,
  type Unsubscribe,
} from '@docedit/protocol';
import type { MockChannel } from './channel.ts';
import type { MockDocument } from './document.ts';

export interface MockToken {
  /** Issue order, compared with the revocation watermark (05 §3.3). */
  serial: number;
  jti: string;
  sub: string;
  name?: string;
  grp: readonly string[];
  docs: Readonly<Record<string, DocRole>>;
  /** The roles the user may fill (the mock's stand-in for a fill claim; see `MockUser.fill`). */
  fill?: { readonly roles: readonly string[]; readonly active: boolean };
  /** Unix milliseconds on the service clock. */
  iat: number;
  exp: number;
}

/** What the backend needs from the service. */
export interface BackendHost {
  now(): number;
  features: readonly string[];
  limits: Session['limits'];
  presence: boolean;
  document(id: string): MockDocument | undefined;
  verify(token: MockToken): 'ok' | 'revoked' | 'token_expired' | 'unauthenticated';
  register(b: MockBackend): void;
  unregister(b: MockBackend): void;
}

export interface MockBackendOptions {
  /** Features the client asks for; the negotiated set is their intersection with the service's (05 §1 rule 4). */
  features?: readonly string[];
}

/** Calls listeners in a later microtask, never synchronously. */
class Listeners<T> {
  private readonly set = new Set<(v: T) => void>();
  add(cb: (v: T) => void): Unsubscribe {
    this.set.add(cb);
    return () => {
      this.set.delete(cb);
    };
  }
  emit(v: T): void {
    for (const cb of [...this.set]) void Promise.resolve().then(() => cb(v));
  }
}

export class MockBackend implements Backend {
  features: ReadonlySet<string> = new Set();
  readonly auth: AuthPort;
  readonly sync: SyncPort;
  readonly permissions: PermissionsPort;
  readonly presence?: PresencePort;

  private readonly host: BackendHost;
  private readonly tokenSource: () => Promise<MockToken>;
  private readonly requested: ReadonlySet<string> | null;
  private token: MockToken | null = null;
  private current: Session | null = null;
  private warned = false;
  private readonly channels = new Map<string, MockChannel>();
  /** Backend-level subscriptions: `access:<doc>` and `presence:<doc>`. */
  private readonly portDelivery = new OrderedDelivery();
  private readonly expiring = new Listeners<{ inMs: number }>();
  private readonly revoked = new Listeners<{ reason: string }>();
  private readonly authRequired = new Listeners<{ code: ErrorCode; message: string }>();

  constructor(
    host: BackendHost,
    tokenSource: () => Promise<MockToken>,
    opts: MockBackendOptions = {},
  ) {
    this.host = host;
    this.tokenSource = tokenSource;
    this.requested = opts.features ? new Set(opts.features) : null;
    const session = () => this.current;
    this.auth = {
      get session() {
        return session();
      },
      refresh: () => this.refresh(),
      onExpiring: (cb) => this.expiring.add(cb),
      onRevoked: (cb) => this.revoked.add(cb),
      onAuthRequired: (cb) => this.authRequired.add(cb),
    };
    this.sync = {
      loadContent: (docId, seq) => this.loadContent(docId, seq),
      open: (docId, opts) => this.open(docId, opts.resume),
    };
    this.permissions = {
      current: (docId) => {
        const ch = this.channels.get(docId);
        return ch && !ch.isClosed ? ch.access : null;
      },
      onAccess: (docId, cb) => this.portDelivery.subscribe<Access>(`access:${docId}`, cb),
      regions: async (docId) => this.doc(docId).regions(),
      grants: async (docId) => this.doc(docId).grants(),
      updateGrants: async (docId, patch, o) => {
        const d = this.doc(docId);
        this.requireManage(docId);
        return d.updateGrants(patch, o.ifMatch);
      },
      setRegionState: async (docId, regionId, state) => {
        const d = this.doc(docId);
        this.requireManage(docId);
        return d.setRegionState(regionId, state);
      },
    };
    if (host.presence)
      this.presence = {
        update: (docId, update) => {
          const ch = this.channels.get(docId);
          if (ch && !ch.isClosed) this.host.document(docId)?.presence(ch, update);
        },
        onPeers: (docId, cb) => this.portDelivery.subscribe<PresencePeers>(`presence:${docId}`, cb),
      };
  }

  // --- Backend -----------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (this.current) return;
    const token = await this.obtain();
    this.token = token;
    this.warned = false;
    const features = this.host.features.filter((f) => !this.requested || this.requested.has(f));
    this.current = {
      version: '1.0',
      session: uuid7(),
      user: token.name === undefined ? { id: token.sub } : { id: token.sub, name: token.name },
      features: [...this.host.features],
      limits: this.host.limits,
      tokenExp: formatTimestamp(token.exp),
    };
    this.features = new Set(features);
    this.host.register(this);
  }

  async close(): Promise<void> {
    for (const ch of this.channels.values()) ch.close();
    this.channels.clear();
    this.end();
  }

  private end(): void {
    this.current = null;
    this.token = null;
    this.features = new Set();
    this.host.unregister(this);
  }

  // --- AuthPort ----------------------------------------------------------------------------

  /** Gets a token from the token source and checks it as the server would on `hello`. */
  private async obtain(): Promise<MockToken> {
    let token: MockToken;
    try {
      token = await this.tokenSource();
    } catch (e) {
      const message = `the token source failed: ${(e as Error).message}`;
      this.authRequired.emit({ code: 'unauthenticated', message });
      throw new PortError('unauthenticated', message);
    }
    const verdict = this.host.verify(token);
    if (verdict !== 'ok') {
      this.authRequired.emit({ code: verdict, message: `the token was refused: ${verdict}` });
      throw new PortError(verdict, `the token was refused: ${verdict}`);
    }
    return token;
  }

  private async refresh(): Promise<{ tokenExp: string }> {
    if (!this.current) throw new PortError('unauthenticated', 'not connected');
    const token = await this.obtain();
    if (token.sub !== this.token?.sub)
      throw new PortError('forbidden', 'a refreshed token must carry the same sub (05 §3.1)');
    this.token = token;
    this.warned = false;
    const tokenExp = formatTimestamp(token.exp);
    this.current = { ...this.current, tokenExp };
    return { tokenExp };
  }

  /** The service clock moved (test mode): `auth.expiring` about 60 seconds before `tokenExp`. */
  tick(): void {
    if (!this.token || this.warned) return;
    const inMs = this.token.exp - this.host.now();
    if (inMs <= 60_000) {
      this.warned = true;
      this.expiring.emit({ inMs: Math.max(0, inMs) });
    }
  }

  get sub(): string | null {
    return this.token?.sub ?? null;
  }

  /** `auth.revoked`, then close 4401: every channel is closed by the server (05 §3.3). */
  revoke(reason: string): void {
    if (!this.current) return;
    for (const docId of this.channels.keys())
      this.host.document(docId)?.closeChannelsOf(this.token!.sub, reason);
    this.channels.clear();
    this.revoked.emit({ reason });
    this.end();
  }

  // --- SyncPort ----------------------------------------------------------------------------

  private role(docId: string): DocRole {
    if (!this.current || !this.token) throw new PortError('unavailable', 'not connected');
    const role = this.token.docs[docId];
    if (!role) throw new PortError('forbidden', 'the token does not cover this document (05 §6.1)');
    return role;
  }

  private doc(docId: string): MockDocument {
    this.role(docId);
    const d = this.host.document(docId);
    if (!d) throw new PortError('not_found', `no document ${docId}`);
    return d;
  }

  private requireManage(docId: string): void {
    if (this.role(docId) !== 'owner')
      throw new PortError('forbidden', 'manage is required (07 §12)');
  }

  private async loadContent(docId: string, seq?: number): Promise<Content> {
    return this.doc(docId).content(seq);
  }

  private async open(docId: string, resume: Resume | undefined): Promise<SyncChannel> {
    const role = this.role(docId);
    const d = this.doc(docId);
    const existing = this.channels.get(docId);
    if (existing && !existing.isClosed)
      throw new PortError(
        'already_open',
        'a channel for this document is open on this connection (05 §4)',
      );
    const open = [...this.channels.values()].filter((c) => !c.isClosed).length;
    if (open >= this.host.limits.maxChannels)
      throw new PortError('channel_limit', `at most ${this.host.limits.maxChannels} channels`);
    const conn: Connection = {
      sub: this.token!.sub,
      session: this.current!.session,
      role,
      groups: this.token!.grp,
      participantRoles: this.token!.fill?.roles ?? [],
      participantActive: this.token!.fill?.active ?? false,
    };
    const channel = d.open(conn, this.current!.user, resume, {
      access: (a) => this.portDelivery.push(`access:${docId}`, a),
      presence: (p) => this.portDelivery.push(`presence:${docId}`, p),
    });
    this.channels.set(docId, channel);
    return channel;
  }
}
