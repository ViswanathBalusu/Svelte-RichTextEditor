/**
 * An in-memory network for backend-dep tests: a WebSocket and a `fetch` that reach a server in the
 * same process. Every frame and request is recorded in order, and faults are injected on demand:
 * a frame dropped or delivered twice, a connection cut. It uses no Node.js or browser API, so the
 * tests built on it run in Node.js and in every browser engine.
 */
import type {
  FetchLike,
  Platform,
  RequestInitLike,
  ResponseLike,
  SocketCloseEvent,
  SocketMessageEvent,
  WebSocketConstructor,
  WebSocketLike,
} from '../../src/platform.ts';

/** The server's side of one socket. */
export interface ServerSocket {
  readonly id: number;
  readonly url: string;
  readonly protocols: readonly string[];
  /** Sends a text frame to the client. */
  send(text: string): void;
  /** Closes the connection from the server's side. */
  close(code: number, reason: string): void;
  /** Set by the server: a text frame from the client. */
  onMessage: ((text: string) => void) | null;
  /** Set by the server: the connection closed. */
  onClose: ((code: number, reason: string) => void) | null;
}

export interface HttpRequest {
  method: string;
  url: string;
  headers: Readonly<Record<string, string>>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers?: Readonly<Record<string, string>>;
  body?: string;
}

export interface MemoryServer {
  /** A client opens a socket: the subprotocol the server selects, or null to refuse the upgrade. */
  accept(socket: ServerSocket): string | null;
  http(req: HttpRequest): Promise<HttpResponse>;
}

export interface FrameRecord {
  dir: 'c2s' | 's2c';
  socket: number;
  text: string;
}

/** What the network does with a frame from the server: deliver it, lose it or deliver it twice. */
export type Fate = 'deliver' | 'drop' | 'duplicate';

export interface MemoryNetworkOptions {
  /** Runs a callback later; a microtask by default. Property tests pass a virtual scheduler. */
  defer?: (fn: () => void) => void;
}

const microtask = (fn: () => void): void => {
  void Promise.resolve().then(fn);
};

/** A WebSocket constructor whose sockets connect on `net`. */
function socketClass(net: MemoryNetwork): WebSocketConstructor {
  return function (url: string, protocols: string[]) {
    return net.connect(url, protocols);
  } as unknown as WebSocketConstructor;
}

class MemorySocket implements WebSocketLike {
  protocol = '';
  readyState = 0;
  readonly id: number;
  private readonly net: MemoryNetwork;
  private readonly listeners: Record<string, Array<(e: never) => void>> = {
    open: [],
    message: [],
    close: [],
    error: [],
  };
  peer: ServerSocketImpl | null = null;

  constructor(net: MemoryNetwork, id: number) {
    this.net = net;
    this.id = id;
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('the socket is not open');
    this.net.clientSent(this, data);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.net.clientClosed(this, code, reason);
  }

  addEventListener(type: string, listener: (e: never) => void): void {
    this.listeners[type]?.push(listener);
  }

  emit(
    type: 'open' | 'message' | 'close' | 'error',
    e?: SocketMessageEvent | SocketCloseEvent,
  ): void {
    for (const l of [...(this.listeners[type] ?? [])]) (l as (x: unknown) => void)(e);
  }
}

class ServerSocketImpl implements ServerSocket {
  readonly id: number;
  readonly url: string;
  readonly protocols: readonly string[];
  onMessage: ((text: string) => void) | null = null;
  onClose: ((code: number, reason: string) => void) | null = null;
  closed = false;
  private readonly net: MemoryNetwork;
  readonly client: MemorySocket;

  constructor(net: MemoryNetwork, client: MemorySocket, url: string, protocols: readonly string[]) {
    this.net = net;
    this.client = client;
    this.id = client.id;
    this.url = url;
    this.protocols = protocols;
  }

  send(text: string): void {
    if (this.closed) return;
    this.net.serverSent(this, text);
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.net.serverClosed(this, code, reason);
  }
}

export class MemoryNetwork {
  readonly frames: FrameRecord[] = [];
  readonly requests: HttpRequest[] = [];
  readonly sockets: Array<{ id: number; url: string; protocols: readonly string[] }> = [];
  /** Decides the fate of each frame from the server (default: deliver). */
  fate: (text: string, socket: number) => Fate = () => 'deliver';
  /** While false, new sockets fail to connect, as with no network (close 1006). */
  online = true;
  private readonly server: MemoryServer;
  private readonly defer: (fn: () => void) => void;
  private readonly open = new Set<ServerSocketImpl>();
  private counter = 0;

  constructor(server: MemoryServer, opts: MemoryNetworkOptions = {}) {
    this.server = server;
    this.defer = opts.defer ?? microtask;
  }

  /** The platform parts for `createDepBackend({ platform })`. */
  platform(): Partial<Platform> {
    const fetch: FetchLike = (url, init) => this.fetch(url, init);
    return { WebSocket: socketClass(this), fetch };
  }

  /** The frames of one direction, decoded. */
  decoded(dir: 'c2s' | 's2c'): Array<Record<string, unknown>> {
    return this.frames
      .filter((f) => f.dir === dir)
      .map((f) => JSON.parse(f.text) as Record<string, unknown>);
  }

  /** Cuts every open connection, as a broken network would: both sides see close 1006. */
  cut(): void {
    for (const s of [...this.open]) this.drop(s, 1006, '');
  }

  get openSockets(): number {
    return this.open.size;
  }

  // --- Sockets ---------------------------------------------------------------------------------

  /** @internal What `new WebSocket(url, protocols)` does on this network. */
  connect(url: string, protocols: string[]): MemorySocket {
    const client = new MemorySocket(this, ++this.counter);
    this.sockets.push({ id: client.id, url, protocols: [...protocols] });
    this.defer(() => {
      if (client.readyState !== 0) return;
      if (!this.online) {
        client.readyState = 3;
        client.emit('error');
        client.emit('close', { code: 1006, reason: '' });
        return;
      }
      const peer = new ServerSocketImpl(this, client, url, protocols);
      const selected = this.server.accept(peer);
      if (selected === null) {
        client.readyState = 3;
        client.emit('error');
        client.emit('close', { code: 1006, reason: '' });
        return;
      }
      client.peer = peer;
      client.protocol = selected;
      client.readyState = 1;
      this.open.add(peer);
      client.emit('open');
    });
    return client;
  }

  /** @internal */
  clientSent(client: MemorySocket, text: string): void {
    const peer = client.peer;
    if (!peer || peer.closed) return;
    this.frames.push({ dir: 'c2s', socket: client.id, text });
    this.defer(() => {
      if (!peer.closed) peer.onMessage?.(text);
    });
  }

  /** @internal */
  serverSent(peer: ServerSocketImpl, text: string): void {
    const fate = this.fate(text, peer.id);
    if (fate === 'drop') return;
    this.frames.push({ dir: 's2c', socket: peer.id, text });
    const times = fate === 'duplicate' ? 2 : 1;
    for (let i = 0; i < times; i++)
      this.defer(() => {
        if (peer.client.readyState === 1) peer.client.emit('message', { data: text });
      });
  }

  /** @internal */
  clientClosed(client: MemorySocket, code: number, reason: string): void {
    const peer = client.peer;
    this.defer(() => {
      if (peer && !peer.closed) {
        peer.closed = true;
        this.open.delete(peer);
        peer.onClose?.(code, reason);
      }
      if (client.readyState !== 3) {
        client.readyState = 3;
        client.emit('close', { code, reason });
      }
    });
  }

  /** @internal */
  serverClosed(peer: ServerSocketImpl, code: number, reason: string): void {
    peer.closed = true;
    this.open.delete(peer);
    this.defer(() => {
      peer.onClose?.(code, reason);
      if (peer.client.readyState !== 3) {
        peer.client.readyState = 3;
        peer.client.emit('close', { code, reason });
      }
    });
  }

  private drop(peer: ServerSocketImpl, code: number, reason: string): void {
    if (peer.closed) return;
    peer.closed = true;
    this.open.delete(peer);
    this.defer(() => {
      peer.onClose?.(code, reason);
      if (peer.client.readyState !== 3) {
        peer.client.readyState = 3;
        peer.client.emit('close', { code, reason });
      }
    });
  }

  // --- HTTP ------------------------------------------------------------------------------------

  private async fetch(url: string, init: RequestInitLike): Promise<ResponseLike> {
    const req: HttpRequest = {
      method: init.method,
      url,
      headers: Object.fromEntries(
        Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      ...(init.body !== undefined
        ? { body: typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body) }
        : {}),
    };
    this.requests.push(req);
    if (!this.online) throw new TypeError('fetch failed: the network is down');
    await new Promise<void>((resolve) => this.defer(resolve));
    const res = await this.server.http(req);
    const headers = Object.fromEntries(
      Object.entries(res.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    return {
      status: res.status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      text: async () => res.body ?? '',
    };
  }
}
