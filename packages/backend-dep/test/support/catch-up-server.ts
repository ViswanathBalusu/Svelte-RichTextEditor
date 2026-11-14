/**
 * A DEP server for the resume tests of PRO-095 (lane U-PRO-086-102). It wraps MockDepServer and
 * changes only what a test needs to choose: the catch-up mode of each resumed `ch.opened` (the
 * second and later opens on the server; the first is untouched), the commits that `GET
 * /documents/{id}/commits` serves for `catchUp: "page"`, and whether `sync.submit` frames are
 * swallowed before the server sees them (so the commit is unknown to the server on resume).
 * Universal: it uses no Node.js or browser API.
 */
import type { RemoteCommit } from '@docedit/protocol';
import type { HttpRequest, HttpResponse, MemoryServer, ServerSocket } from './memory-network.ts';
import type { MockDepServer } from './mock-server.ts';

export type CatchUpMode = 'stream' | 'page' | 'reload';

const json = (body: unknown): HttpResponse => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** The socket the mock server sees: frames are rewritten on the way out, submits dropped on the way in. */
class RewritingSocket implements ServerSocket {
  readonly id: number;
  readonly url: string;
  readonly protocols: readonly string[];
  private readonly real: ServerSocket;
  private readonly owner: CatchUpServer;
  private onMessageFn: ((text: string) => void) | null = null;

  constructor(real: ServerSocket, owner: CatchUpServer) {
    this.real = real;
    this.owner = owner;
    this.id = real.id;
    this.url = real.url;
    this.protocols = real.protocols;
  }

  get onMessage(): ((text: string) => void) | null {
    return this.onMessageFn;
  }

  set onMessage(fn: ((text: string) => void) | null) {
    this.onMessageFn = fn;
    this.real.onMessage = fn
      ? (text: string) => {
          if (this.owner.swallowSubmit(text)) return;
          fn(text);
        }
      : null;
  }

  get onClose(): ((code: number, reason: string) => void) | null {
    return this.real.onClose;
  }

  set onClose(fn: ((code: number, reason: string) => void) | null) {
    this.real.onClose = fn;
  }

  send(text: string): void {
    if (!text.includes('"t":"ch.opened"')) {
      this.real.send(text);
      return;
    }
    this.owner.rewriteOpened(this.real, text);
  }

  close(code: number, reason: string): void {
    this.real.close(code, reason);
  }
}

export class CatchUpServer implements MemoryServer {
  /** The catch-up modes for the resumed opens, in order; an empty queue leaves the mock's answer. */
  readonly modes: CatchUpMode[];
  /** The commits `catchUp: "page"` reads over REST, and that `stream` sends after `ch.opened`. */
  pageCommits: RemoteCommit[] = [];
  /** The `after` cursors of the page requests, in order. */
  readonly pageRequests: number[] = [];
  /** The catch-up mode of every `ch.opened` the server sent after the first, as the client saw it. */
  readonly openedModes: string[] = [];
  /** How many `sync.submit` frames are still to be swallowed before the server sees them. */
  swallowBudget = 0;
  private readonly inner: MockDepServer;
  private opens = 0;

  constructor(inner: MockDepServer, modes: CatchUpMode[] = []) {
    this.inner = inner;
    this.modes = [...modes];
  }

  accept(socket: ServerSocket): string | null {
    return this.inner.accept(new RewritingSocket(socket, this));
  }

  /** True when this frame from the client must not reach the server (a lost submit). */
  swallowSubmit(text: string): boolean {
    if (this.swallowBudget <= 0 || !text.includes('"t":"sync.submit"')) return false;
    this.swallowBudget -= 1;
    return true;
  }

  /** Sends a `ch.opened`, with its catch-up mode changed when the test asked for one. */
  rewriteOpened(real: ServerSocket, text: string): void {
    this.opens += 1;
    const frame = JSON.parse(text) as { t: string; ch: number; d: Record<string, unknown> };
    if (this.opens === 1) {
      real.send(text);
      return;
    }
    const mode = this.modes.shift();
    if (mode !== undefined) {
      frame.d['catchUp'] = mode;
      if (mode === 'page') {
        const last = this.pageCommits.at(-1);
        if (last) frame.d['head'] = last.seq;
      }
    }
    this.openedModes.push(String(frame.d['catchUp']));
    real.send(JSON.stringify(frame));
    if (mode === 'stream') {
      for (const c of this.pageCommits)
        real.send(JSON.stringify({ t: 'sync.commit', ch: frame.ch, d: { commits: [c] } }));
    }
  }

  async http(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(req.url);
    const m = /^\/v1\/documents\/([^/]+)\/commits$/.exec(url.pathname);
    if (m && req.method === 'GET') {
      const after = Number(url.searchParams.get('after') ?? '0');
      this.pageRequests.push(after);
      return json({
        items: this.pageCommits.filter((c) => c.seq > after),
        nextCursor: null,
      });
    }
    return this.inner.http(req);
  }
}
