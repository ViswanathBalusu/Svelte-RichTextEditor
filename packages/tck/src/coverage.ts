/**
 * What a run actually exercised, recorded from the traffic: message types and optional payload
 * members in both directions, operations, close codes and registry codes. The kit's self-tests
 * compare it with what each scenario declares (PRO-117), so a declaration cannot claim coverage the
 * scenario does not have.
 */
import { DEP1, type DepMessage } from '@docedit/protocol';
import { isObject } from './assert.ts';

interface CompiledOp {
  key: string;
  re: RegExp;
  base: 'rest' | 'endpoint';
}

const OPS: CompiledOp[] = DEP1.operations
  .map((o) => ({
    key: `${o.method} ${o.path}`,
    base: o.base === 'endpoint' ? ('endpoint' as const) : ('rest' as const),
    weight: (o.path.match(/\{/g) ?? []).length,
    re: new RegExp(
      `^${o.path
        .split('/')
        .map((seg) =>
          /^\{\w+\}$/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        )
        .join('/')}$`,
    ),
  }))
  .sort((a, b) => a.weight - b.weight);

/** The operation of 05 §6.2 a request addresses, as `METHOD /path`, or null. */
export function operationOf(method: string, url: string, restBase: string): string | null {
  const u = new URL(url);
  const rest = new URL(restBase);
  const restPath = rest.pathname.replace(/\/$/, '');
  const inRest = u.origin === rest.origin && u.pathname.startsWith(`${restPath}/`);
  const path = inRest ? u.pathname.slice(restPath.length) : u.pathname;
  for (const op of OPS)
    if (
      op.base === (inRest ? 'rest' : 'endpoint') &&
      op.key.startsWith(`${method} `) &&
      op.re.test(path)
    )
      return op.key;
  return null;
}

/** Optional payload members per message type, from the definition (PRO-117 field coverage). */
export function optionalMembers(): Map<string, string[]> {
  const named = new Map(DEP1.shapes.map((s) => [s.name, s.shape]));
  const out = new Map<string, string[]>();
  for (const m of DEP1.messages) {
    let shape = m.payload;
    if (shape?.kind === 'ref') shape = named.get(shape.name) ?? null;
    if (!shape || shape.kind !== 'object') continue;
    out.set(
      m.t,
      Object.entries(shape.props)
        .filter(([, p]) => p.required !== true)
        .map(([k]) => k),
    );
  }
  return out;
}

export class Observed {
  readonly messages = new Set<string>();
  readonly fields = new Set<string>();
  readonly operations = new Set<string>();
  readonly closeCodes = new Set<number>();
  readonly errors = new Set<string>();
  readonly events = new Set<string>();

  message(m: unknown): void {
    if (!isObject(m) || typeof m['t'] !== 'string') return;
    const t = m['t'];
    this.messages.add(t);
    const d = m['d'];
    if (isObject(d)) for (const k of Object.keys(d)) this.fields.add(`${t}.${k}`);
    const msg = m as unknown as DepMessage;
    if (msg.t === 'error') this.errors.add(msg.d.code);
    if (msg.t === 'sync.reject') this.errors.add(msg.d.code);
    if (msg.t === 'ch.rejected') this.errors.add(msg.d.code);
    if (msg.t === 'ch.closed') this.errors.add(msg.d.code);
    if (msg.t === 'event') this.events.add(msg.d.type);
  }

  private readonly parts = new Map<string, string[]>();

  /** Records a frame; a chunked message is recorded once its last chunk is seen (05 §4). */
  text(text: string, direction: 'in' | 'out' = 'in'): void {
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch {
      return; // not JSON: nothing to record
    }
    this.message(m);
    const d = isObject(m) && m['t'] === 'chunk' && isObject(m['d']) ? m['d'] : null;
    if (!d || typeof d['of'] !== 'string' || typeof d['part'] !== 'string') return;
    const key = `${direction}:${d['of']}`;
    const parts = this.parts.get(key) ?? [];
    parts.push(d['part']);
    this.parts.set(key, parts);
    if (parts.length === d['n']) {
      this.parts.delete(key);
      this.text(parts.join(''), direction);
    }
  }

  operation(key: string | null, status: number, body: unknown): void {
    if (key) this.operations.add(key);
    if (status >= 400 && isObject(body) && typeof body['code'] === 'string')
      this.errors.add(body['code']);
  }

  merge(o: Observed): void {
    for (const k of ['messages', 'fields', 'operations', 'errors', 'events'] as const)
      for (const v of o[k]) (this[k] as Set<string>).add(v);
    for (const c of o.closeCodes) this.closeCodes.add(c);
  }
}
