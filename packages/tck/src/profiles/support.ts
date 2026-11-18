/**
 * Steps shared by the scenarios: joining a document the way 05 §5.2 describes (content over REST,
 * then the channel with `resume`), submitting commits, reading content.
 */
import { uuid7 } from '@docedit/model';
import type {
  ChannelOpened,
  Content,
  DocRole,
  ServerMessage,
  Step,
  SyncCommit,
  Welcome,
} from '@docedit/protocol';
import { KitFailure, check, isObject } from '../assert.ts';
import type { ScenarioContext } from '../context.ts';
import { expectStatus, type HttpResponse } from '../rest.ts';
import type { Wire } from '../wire.ts';

export interface OpenOptions {
  resume?: { seq: number; incarnation: string; inflight?: string; view?: string };
  features?: readonly string[];
  engine?: string;
  cdm?: number;
  token?: string;
}

/** Sends `ch.open` and resolves its reply, whatever it is. */
export async function openChannel(
  ctx: ScenarioContext,
  wire: Wire,
  ch: number,
  doc: string,
  opts: OpenOptions = {},
): Promise<ServerMessage> {
  const d: Record<string, unknown> = {
    kind: 'doc',
    doc,
    engine: opts.engine ?? 'pm-steps/1',
    cdm: opts.cdm ?? 1,
    features: [...(opts.features ?? ctx.clientFeatures())],
  };
  if (opts.resume) d['resume'] = opts.resume;
  if (opts.token) d['token'] = opts.token;
  const { reply } = await wire.request({ t: 'ch.open', ch, d });
  return reply;
}

/** `ch.open` that must succeed; resolves the `ch.opened` payload. */
export async function opened(
  ctx: ScenarioContext,
  wire: Wire,
  ch: number,
  doc: string,
  opts: OpenOptions = {},
): Promise<ChannelOpened> {
  const reply = await openChannel(ctx, wire, ch, doc, opts);
  if (reply.t !== 'ch.opened') throw new KitFailure('the channel did not open', 'ch.opened', reply);
  check(reply.ch === ch, 'ch.opened carries the channel number of ch.open', ch, reply.ch);
  return reply.d;
}

/** Reads content as a user (`GET /documents/{id}/content`, optionally pinned). */
export async function readContent(
  ctx: ScenarioContext,
  token: string,
  doc: string,
  seq?: number,
): Promise<Content> {
  const res = await ctx.service.as(
    token,
    'GET',
    `/documents/${doc}/content`,
    seq === undefined ? {} : { query: { seq } },
  );
  expectStatus(res, 200, `reading the content${seq === undefined ? '' : ` at ${seq}`}`);
  check(isObject(res.json), 'the content is a JSON object', 'an object', res.text);
  return res.json as unknown as Content;
}

export interface Member {
  sub: string;
  token: string;
  wire: Wire;
  welcome: Welcome;
  content: Content;
  opened: ChannelOpened;
  ch: number;
  doc: string;
}

/** Joins as a new user with a role: content at the head over REST, then the channel resumed at it. */
export async function join(
  ctx: ScenarioContext,
  name: string,
  doc: string,
  role: DocRole,
  opts: { ch?: number; token?: Record<string, unknown> } = {},
): Promise<Member> {
  const s = await ctx.session(name, { [doc]: role }, opts.token ? { token: opts.token } : {});
  const content = await readContent(ctx, s.token, doc);
  const ch = opts.ch ?? 1;
  const resume: OpenOptions['resume'] = { seq: content.seq, incarnation: content.incarnation };
  if (content.view !== undefined) resume.view = content.view;
  const o = await opened(ctx, s.wire, ch, doc, { resume });
  return { ...s, content, opened: o, ch, doc };
}

/** Sends `sync.submit` and resolves its reply (`sync.ack`, `sync.reject` or `error`). */
export async function submit(
  wire: Wire,
  ch: number,
  commit: { id?: string; base: number; steps: Step[]; origin?: string },
  opts: { timeoutMs?: number } = {},
): Promise<ServerMessage> {
  const d: Record<string, unknown> = {
    id: commit.id ?? uuid7(),
    base: commit.base,
    steps: commit.steps,
  };
  if (commit.origin !== undefined) d['origin'] = commit.origin;
  const { reply } = await wire.request({ t: 'sync.submit', ch, d }, opts);
  return reply;
}

/** A submit that must be acknowledged; resolves the `sync.ack` payload. */
export async function acked(
  wire: Wire,
  ch: number,
  commit: { id?: string; base: number; steps: Step[]; origin?: string },
) {
  const reply = await submit(wire, ch, commit);
  if (reply.t !== 'sync.ack')
    throw new KitFailure('the commit was not acknowledged', 'sync.ack', reply);
  return reply.d;
}

/**
 * A submit that must end acknowledged, for a scenario that makes many commits. A refusal with the
 * action `retry` (`rate_limited`, `busy`) is what a client resubmits after `retryAfterMs`
 * (04 §8), the same commit under the same id; any other reply is a failure. At most `attempts`
 * tries, so a server that never lets the commit through fails the scenario.
 */
export async function ackedWithRetry(
  wire: Wire,
  ch: number,
  commit: { id?: string; base: number; steps: Step[]; origin?: string },
  attempts = 50,
) {
  const sent = { ...commit, id: commit.id ?? uuid7() };
  for (let i = 1; ; i++) {
    const reply = await submit(wire, ch, sent);
    if (reply.t === 'sync.ack') return reply.d;
    if (reply.t === 'sync.reject' && reply.d.action === 'retry' && i < attempts) {
      const wait = Math.min(Math.max(reply.d.retryAfterMs ?? 10, 1), 2000);
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
      continue;
    }
    throw new KitFailure('the commit was not acknowledged', 'sync.ack', reply);
  }
}

/** A submit that must be rejected; resolves the `sync.reject` payload. */
export async function rejected(
  wire: Wire,
  ch: number,
  commit: { id?: string; base: number; steps: Step[]; origin?: string },
) {
  const reply = await submit(wire, ch, commit);
  if (reply.t !== 'sync.reject')
    throw new KitFailure('the commit was not rejected', 'sync.reject', reply);
  return reply.d;
}

/** Every commit received on a channel, in order of arrival. */
export function commitsOn(wire: Wire, ch: number): SyncCommit['commits'] {
  return wire.messages.flatMap((m) => (m.t === 'sync.commit' && m.ch === ch ? m.d.commits : []));
}

/** Waits for a commit with this `seq` on a channel. */
export function untilSeq(wire: Wire, ch: number, seq: number, what = `commit ${seq}`) {
  return wire.next(
    (m) => m.t === 'sync.commit' && m.ch === ch && m.d.commits.some((c) => c.seq === seq),
    what,
  );
}

/** The highest `seq` a member knows: content, commits and acknowledgements on its channel. */
export function knownSeq(m: Member): number {
  let seq = Math.max(m.content.seq, m.opened.catchUp === 'reload' ? m.opened.head : 0);
  for (const msg of m.wire.messages) {
    if (msg.t === 'sync.commit' && msg.ch === m.ch)
      for (const c of msg.d.commits) seq = Math.max(seq, c.seq);
    if (msg.t === 'sync.ack' && msg.ch === m.ch) seq = Math.max(seq, msg.d.seq);
    if (msg.t === 'sync.reset' && msg.ch === m.ch) seq = Math.max(seq, msg.d.seq);
  }
  return seq;
}

/** A problem document's members, checked against 05 §6.1 (RFC 9457 with `code`). */
export function problemOf(
  res: HttpResponse,
  what: string,
): { code: string; status: number; requestId?: string } {
  check(res.status >= 400, `${what}: a problem response`, 'HTTP 4xx or 5xx', res.status);
  const type = res.headers.get('content-type') ?? '';
  check(
    type.startsWith('application/problem+json'),
    `${what}: the Content-Type of a problem document (RFC 9457; 05 §6.1)`,
    'application/problem+json',
    type,
  );
  const j = res.json;
  check(isObject(j), `${what}: a JSON problem document`, 'an object', res.text);
  check(
    typeof j['code'] === 'string',
    `${what}: the problem has a code (05 §6.1)`,
    'a registry code',
    j,
  );
  check(
    j['status'] === res.status,
    `${what}: the problem's status equals the HTTP status`,
    res.status,
    j['status'],
  );
  check(
    typeof j['title'] === 'string' && typeof j['type'] === 'string',
    `${what}: type and title (RFC 9457)`,
    'strings',
    j,
  );
  const out: { code: string; status: number; requestId?: string } = {
    code: j['code'] as string,
    status: res.status,
  };
  if (typeof j['requestId'] === 'string') out.requestId = j['requestId'];
  return out;
}

/** A user token's claims, decoded without verification (the scenario verifies separately). */
export function claimsOf(token: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  const parts = token.split('.');
  check(parts.length === 3, 'a JWS in compact form (three parts)', 3, parts.length);
  const decode = (s: string) =>
    JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Record<string, unknown>;
  return { header: decode(parts[0]!), payload: decode(parts[1]!) };
}

export const newId = (): string => uuid7();
