/**
 * The engine extension point (04 §15; ADR 0001; SYN-046). DEP negotiates the engine per channel
 * (`hello.engines`, `ch.open.engine`; 05 §5.1, §5.2). Any engine must provide a resume token,
 * server attribution of every change, a way for the server to refuse a change, and either JSON or
 * opaque binary payloads. Each of the four is a required member of `EngineDefinition`, so an
 * engine without one does not type-check, and `engineContractFailures` checks them at run time.
 *
 * Nothing in this file names a ProseMirror type: the layer that picks an engine for a channel
 * needs none. `pm-steps/1` is registered through it like any other engine.
 */
import { DEFAULT_ACTION, type RejectAction, type RejectCode } from '../codes.ts';
import { ENGINE, type CommitInput, type Resume } from './types.ts';

/** How an engine's changes travel (05 §4): JSON in text frames, or opaque bytes in binary frames. */
export type PayloadKind = 'json' | 'binary';

/** Who made a change and when, as the server stamps it (04 G6): never the change's own claim. */
export interface Attribution {
  user: string;
  /** Null for a change the server authored (05 §5.3, `author.session`). */
  session: string | null;
  agent?: string;
  /** Server time, Unix milliseconds. */
  time: number;
}

/** A refusal (04 §8): a code from the registry, the client's next action and a reason. */
export interface Refusal {
  refused: true;
  code: RejectCode;
  action: RejectAction;
  reason: string;
}

export interface EngineDefinition<Position = unknown, Change = unknown> {
  /** The identifier negotiated in `hello.engines` and `ch.open.engine`. */
  readonly id: string;
  /** (4) JSON or opaque binary payloads. */
  readonly payloads: PayloadKind;
  /** (1) The resume token: the client's position read from `ch.open.resume`, or null. */
  readResume(token: unknown): Position | null;
  /** (1) The token a client presents to resume from a position. */
  resumeToken(position: Position): unknown;
  /** Reads a submitted change; what it cannot read is refused, never thrown. */
  readChange(payload: unknown): Change | Refusal;
  /** (2) Server attribution: the stamp a stored change carries comes from the server only. */
  attribute(change: Change, stamp: Attribution): { change: Change; attribution: Attribution };
  /** (3) The server's way to refuse a change. */
  refuse(code: RejectCode, reason: string, action?: RejectAction): Refusal;
}

export function isRefusal(v: unknown): v is Refusal {
  return typeof v === 'object' && v !== null && (v as Record<string, unknown>)['refused'] === true;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function refusal(code: RejectCode, reason: string, action?: RejectAction): Refusal {
  return { refused: true, code, action: action ?? DEFAULT_ACTION[code], reason };
}

/**
 * `pm-steps/1` (04 §3 to §9) as an engine: JSON payloads, `{ seq, incarnation, inflight, view }`
 * as the resume token, commits stamped by the room from the connection and its clock, and the
 * rejections of 04 §8. The room itself does the work; this is what the protocol layer sees.
 */
export const PM_STEPS_1: EngineDefinition<Resume, CommitInput> = {
  id: ENGINE,
  payloads: 'json',
  readResume(token) {
    if (!isObject(token)) return null;
    const { seq, incarnation, inflight, view } = token;
    if (!Number.isSafeInteger(seq) || (seq as number) < 0 || typeof incarnation !== 'string')
      return null;
    if (inflight !== undefined && inflight !== null && typeof inflight !== 'string') return null;
    if (view !== undefined && typeof view !== 'string') return null;
    return {
      seq: seq as number,
      incarnation,
      inflight: typeof inflight === 'string' ? inflight : null,
      ...(typeof view === 'string' ? { view } : {}),
    };
  },
  resumeToken(p) {
    return {
      seq: p.seq,
      incarnation: p.incarnation,
      ...(p.inflight !== null ? { inflight: p.inflight } : {}),
      ...(p.view !== undefined ? { view: p.view } : {}),
    };
  },
  readChange(payload) {
    if (!isObject(payload)) return refusal('invalid_op', 'a commit is an object');
    const { id, base, steps, origin } = payload;
    if (typeof id !== 'string') return refusal('invalid_op', 'a commit needs an id');
    if (!Number.isSafeInteger(base)) return refusal('invalid_op', 'base must be a sequence number');
    if (!Array.isArray(steps)) return refusal('invalid_op', 'steps must be an array');
    if (origin !== undefined && typeof origin !== 'string')
      return refusal('invalid_op', 'origin must be a string');
    return {
      id,
      base: base as number,
      steps,
      ...(typeof origin === 'string' ? { origin } : {}),
    };
  },
  attribute(change, stamp) {
    // Steps carry no identity in pm-steps/1; whatever else the payload claims is not copied.
    const { id, base, steps, origin } = change;
    return {
      change: { id, base, steps, ...(origin !== undefined ? { origin } : {}) },
      attribution: { ...stamp },
    };
  },
  refuse: refusal,
};

/**
 * The engine contract test (SYN-046 criterion 3): what a registered engine must satisfy, checked
 * at run time with a sample position and change. Returns the failures; empty means it passes.
 */
export function engineContractFailures<P, C>(
  engine: EngineDefinition<P, C>,
  sample: { position: P; change: unknown },
): string[] {
  const out = missingMembers(engine);
  if (out.length) return out;
  try {
    const back = engine.readResume(engine.resumeToken(sample.position));
    if (JSON.stringify(back) !== JSON.stringify(sample.position))
      out.push('a resume token does not read back as the position it was made from');
    for (const junk of [null, 42, 'x', [], { seq: -1 }])
      if (engine.readResume(junk) !== null)
        out.push(`a junk resume token was read: ${JSON.stringify(junk)}`);
  } catch (e2) {
    out.push(`resume tokens throw: ${(e2 as Error).message}`);
  }
  try {
    for (const junk of [null, 42, 'x', [], {}]) {
      const r = engine.readChange(junk);
      if (!isRefusal(r)) out.push(`a junk change was read: ${JSON.stringify(junk)}`);
      else if (!(r.code in DEFAULT_ACTION)) out.push(`a refusal carries an unknown code ${r.code}`);
    }
  } catch (e2) {
    out.push(`reading a junk change throws: ${(e2 as Error).message}`);
  }
  try {
    const change = engine.readChange(sample.change);
    if (isRefusal(change)) out.push(`the sample change is refused: ${change.reason}`);
    else {
      const stamp: Attribution = { user: 'u-server', session: 's-server', time: 1 };
      const a = engine.attribute(change, stamp);
      if (JSON.stringify(a.attribution) !== JSON.stringify(stamp))
        out.push('the attribution is not the server stamp');
      if (JSON.stringify(a.change).includes('mallory'))
        out.push('a claim of the change survives attribution');
    }
  } catch (e2) {
    out.push(`attribution throws: ${(e2 as Error).message}`);
  }
  try {
    const r = engine.refuse('invalid_op', 'test');
    if (!isRefusal(r) || r.code !== 'invalid_op') out.push('refuse does not return a refusal');
  } catch (e2) {
    out.push(`refuse throws: ${(e2 as Error).message}`);
  }
  return out;
}

/** The four obligations of 04 §15 and the identifier, as members of the definition. */
function missingMembers(engine: unknown): string[] {
  const out: string[] = [];
  const e = (typeof engine === 'object' && engine !== null ? engine : {}) as Record<
    string,
    unknown
  >;
  if (typeof e['id'] !== 'string' || e['id'] === '') out.push('no engine identifier');
  if (e['payloads'] !== 'json' && e['payloads'] !== 'binary')
    out.push('payloads must be "json" or "binary"');
  for (const m of ['readResume', 'resumeToken', 'readChange', 'attribute', 'refuse'])
    if (typeof e[m] !== 'function') out.push(`no ${m}: the engine cannot ${purpose(m)}`);
  return out;
}

function purpose(member: string): string {
  switch (member) {
    case 'readResume':
    case 'resumeToken':
      return 'resume a channel';
    case 'readChange':
      return 'read a change';
    case 'attribute':
      return 'attribute a change';
    default:
      return 'refuse a change';
  }
}

/** The engines a server offers, and the negotiation of 05 §5.1 and §5.2. */
export class EngineRegistry {
  private readonly engines = new Map<string, EngineDefinition>();

  /** Registers an engine; one that lacks any of the four obligations is refused. */
  register(engine: EngineDefinition): void {
    const failures = missingMembers(engine);
    if (failures.length)
      throw new TypeError(`engine ${String(engine?.id)}: ${failures.join('; ')}`);
    this.engines.set(engine.id, engine);
  }

  /** `hello.engines`: the client's engines the server also offers, in the client's order. */
  negotiate(offered: readonly unknown[]): string[] {
    return offered.filter((e): e is string => typeof e === 'string' && this.engines.has(e));
  }

  /** `ch.open.engine`: the engine for a channel, or `unsupported_engine` (05 §5.2). */
  forChannel(
    engine: unknown,
    negotiated?: readonly string[],
  ):
    | { ok: true; engine: EngineDefinition }
    | { ok: false; code: 'unsupported_engine'; reason: string } {
    const found = typeof engine === 'string' ? this.engines.get(engine) : undefined;
    if (!found || (negotiated && !negotiated.includes(found.id)))
      return {
        ok: false,
        code: 'unsupported_engine',
        reason: `engine ${JSON.stringify(engine)} is not offered on this session`,
      };
    return { ok: true, engine: found };
  }

  get ids(): string[] {
    return [...this.engines.keys()];
  }
}
