/**
 * The egress of webhook deliveries (06 §1; 05 §7; 10 §3.2; PRO-071; BE-056). Every request the
 * dispatcher makes goes through `EgressProxy.deliver`, which:
 *
 * - refuses a target whose address is not public, for IPv4 and IPv6, and records the refusal
 *   reason; the one classifier is `egress-address.ts` (PRO-071), which fails closed (loopback,
 *   private, CGNAT, link-local, the cloud metadata address, unspecified, multicast, documentation,
 *   6to4, Teredo, NAT64 and other reserved space; IPv4-mapped forms by the address they carry);
 *   the names `localhost` and `*.localhost` are refused as loopback without being resolved;
 * - resolves the host once, checks every address it returns, and connects to the address that
 *   passed; the connector reports the address it actually connected to, and a mismatch is refused,
 *   so a name that changes its address between the check and the connection is not followed;
 * - checks each redirect target again as a new request, so a public target that redirects to a
 *   private address is refused before any second request is sent; the number of redirects is
 *   bounded by an option that has no default (the spec gives no number).
 *
 * The network policy that makes this proxy the only route out (BE-056 criterion 4) is deployment
 * infrastructure and is not built here. `nodeConnector` is the Node.js connector; tests use fakes.
 * This module is not a universal package and may use Node.js APIs.
 */
import { isIP, type LookupFunction } from 'node:net';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { classifyAddress, classifyHost, parseIPv6, type HostClass } from './egress-address.ts';

/** Why a target was refused. Identifiers only; never the address-based content of a request. */
export type RefusalReason =
  | 'malformed_url'
  | 'bad_scheme'
  | 'credentials_in_url'
  | 'unresolved'
  | 'not_an_address'
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'metadata'
  | 'multicast'
  | 'reserved'
  | 'address_unverified'
  | 'address_changed'
  | 'too_many_redirects'
  | 'timeout'
  | 'transport_error';

export type TransportResult =
  { ok: true; status: number; hops: number } | { ok: false; reason: RefusalReason };

/** What the dispatcher uses to send one request. `EgressProxy` is the only implementation. */
export interface Transport {
  deliver(request: {
    url: string;
    headers: Readonly<Record<string, string>>;
    body: string;
  }): Promise<TransportResult>;
}

export interface Resolver {
  /** The addresses a host name resolves to. */
  resolve(host: string): Promise<readonly string[]>;
}

export interface ConnectInput {
  /** The address to connect to: the one the policy checked. */
  address: string;
  url: URL;
  headers: Readonly<Record<string, string>>;
  body: string;
}

export interface ConnectResult {
  /** The address the socket is connected to, as the connector observed it. */
  remoteAddress: string | undefined;
  status: number;
  location: string | undefined;
}

export interface Connector {
  send(input: ConnectInput): Promise<ConnectResult>;
}

const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** The refusal reason for a class from `egress-address.ts`, or null for a public address. */
function reasonForClass(kind: Exclude<HostClass, 'name'>): RefusalReason | null {
  switch (kind) {
    case 'public':
      return null;
    case 'link-local':
      return 'link_local';
    case 'invalid':
      return 'not_an_address';
    default:
      return kind;
  }
}

/**
 * The reason an address is refused, or null when it is a public address. A text that is not an IP
 * address (including an IPv6 address with a zone identifier) is refused as `not_an_address`.
 */
export function refusedAddressReason(address: string): RefusalReason | null {
  const bare = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  return reasonForClass(classifyAddress(bare));
}

/** A canonical text of an address, so that two spellings of one IPv6 address compare equal. */
function canonical(address: string): string {
  const bare = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const v6 = isIP(bare) === 6 ? parseIPv6(bare) : null;
  if (v6 !== null) return v6.map((x) => x.toString(16)).join(':');
  return bare.toLowerCase();
}

export function sameAddress(a: string, b: string): boolean {
  return canonical(a) === canonical(b);
}

/** The system resolver: every address the host name has, IPv4 and IPv6. */
export const systemResolver: Resolver = {
  async resolve(host: string): Promise<readonly string[]> {
    const rows = await dnsLookup(host, { all: true, verbatim: true });
    return rows.map((r) => r.address);
  },
};

/** A name lookup that answers with the checked address and nothing else (Node asks with `all` too). */
function lookupTo(address: string, family: number): LookupFunction {
  return (_host, options, callback) => {
    if (options.all === true) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

/**
 * The Node.js connector: one POST to `address` (the checked address), with the URL's host name in
 * the Host header and for TLS, and no redirect followed. It reports the address the socket reached.
 */
export function nodeConnector(timeoutMs: number): Connector {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new RangeError('timeout must be positive');
  return {
    send(input: ConnectInput): Promise<ConnectResult> {
      const { address, url, headers, body } = input;
      const family = isIP(address);
      return new Promise<ConnectResult>((resolve, reject) => {
        const options: RequestOptions = {
          method: 'POST',
          hostname: url.hostname.replace(/^\[|\]$/g, ''),
          ...(url.port === '' ? {} : { port: url.port }),
          path: `${url.pathname}${url.search}`,
          headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
          // Node asks for every address (`all`) on some paths; both answers are the checked one.
          lookup: lookupTo(address, family),
        };
        const send =
          url.protocol === 'https:'
            ? (o: RequestOptions, cb: (res: IncomingMessage) => void) => httpsRequest(o, cb)
            : (o: RequestOptions, cb: (res: IncomingMessage) => void) => httpRequest(o, cb);
        const req = send(options, (res) => {
          const remoteAddress = res.socket.remoteAddress;
          const location =
            typeof res.headers.location === 'string' ? res.headers.location : undefined;
          const status = res.statusCode ?? 0;
          res.resume();
          resolve({ remoteAddress, status, location });
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end(body);
      });
    },
  };
}

export interface EgressOptions {
  resolver: Resolver;
  connector: Connector;
  /** Redirects followed before the delivery is refused. No default: the spec gives no number. */
  maxRedirects: number;
}

/** Sends a delivery through the policy above. Each redirect target is checked as a new request. */
export class EgressProxy implements Transport {
  readonly #resolver: Resolver;
  readonly #connector: Connector;
  readonly #maxRedirects: number;

  constructor(options: EgressOptions) {
    if (!Number.isSafeInteger(options.maxRedirects) || options.maxRedirects < 0)
      throw new RangeError('maxRedirects is a non-negative integer');
    this.#resolver = options.resolver;
    this.#connector = options.connector;
    this.#maxRedirects = options.maxRedirects;
  }

  async deliver(request: {
    url: string;
    headers: Readonly<Record<string, string>>;
    body: string;
  }): Promise<TransportResult> {
    let current: URL;
    try {
      current = new URL(request.url);
    } catch {
      return { ok: false, reason: 'malformed_url' };
    }
    let hops = 0;
    for (;;) {
      const checked = await this.#check(current);
      if (!checked.ok) return checked;
      let answer: ConnectResult;
      try {
        answer = await this.#connector.send({
          address: checked.address,
          url: current,
          headers: request.headers,
          body: request.body,
        });
      } catch (error) {
        return { ok: false, reason: isTimeout(error) ? 'timeout' : 'transport_error' };
      }
      if (answer.remoteAddress === undefined) return { ok: false, reason: 'address_unverified' };
      if (!sameAddress(answer.remoteAddress, checked.address))
        return { ok: false, reason: 'address_changed' };
      if (REDIRECTS.has(answer.status) && answer.location !== undefined) {
        if (hops >= this.#maxRedirects) return { ok: false, reason: 'too_many_redirects' };
        hops += 1;
        try {
          current = new URL(answer.location, current);
        } catch {
          return { ok: false, reason: 'malformed_url' };
        }
        continue;
      }
      return { ok: true, status: answer.status, hops };
    }
  }

  /** The address to connect to, when every address of the host passes the policy. */
  async #check(
    url: URL,
  ): Promise<{ ok: true; address: string } | { ok: false; reason: RefusalReason }> {
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      return { ok: false, reason: 'bad_scheme' };
    if (url.username !== '' || url.password !== '')
      return { ok: false, reason: 'credentials_in_url' };
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const hostClass = classifyHost(url.hostname);
    let addresses: readonly string[];
    if (hostClass !== 'name') {
      // An IP literal, `localhost` or an empty host: decided without asking the resolver.
      const reason = reasonForClass(hostClass);
      if (reason !== null) return { ok: false, reason };
      addresses = [host];
    } else {
      try {
        addresses = await this.#resolver.resolve(host);
      } catch {
        return { ok: false, reason: 'unresolved' };
      }
    }
    if (addresses.length === 0) return { ok: false, reason: 'unresolved' };
    for (const address of addresses) {
      const reason = refusedAddressReason(address);
      // Any refused address refuses the target: the connector may pick any of them.
      if (reason !== null) return { ok: false, reason };
    }
    const first = addresses[0];
    if (first === undefined) return { ok: false, reason: 'unresolved' };
    return { ok: true, address: first };
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === 'timeout';
}
