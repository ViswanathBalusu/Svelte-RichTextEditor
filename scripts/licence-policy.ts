/**
 * Evaluates SPDX licence expressions against the licence gate's policy (FND-011).
 * `A OR B` passes when one option is allowed; the gate then requires the chosen option to be
 * recorded (borrow list §15). `A AND B` passes when both are allowed. `X WITH exception` is
 * judged by `X`.
 */

export interface Policy {
  allow: string[];
  fontsOnly: string[];
  dataOnly: string[];
  deny: string[];
}

export interface Exception {
  package: string;
  version?: string;
  licence: string;
  option?: string;
  reason: string;
  decision: string;
  expires: string;
}

export type Verdict = { ok: true; dual: boolean } | { ok: false; reason: string };

type Expr = { t: 'id'; id: string } | { t: 'and' | 'or'; a: Expr; b: Expr };

export function parseSpdx(text: string): Expr | null {
  const tokens = text.replace(/[()]/g, ' $& ').split(/\s+/).filter(Boolean);
  let pos = 0;
  const parseOr = (): Expr | null => {
    let left = parseAnd();
    while (left && tokens[pos]?.toUpperCase() === 'OR') {
      pos++;
      const right = parseAnd();
      if (!right) return null;
      left = { t: 'or', a: left, b: right };
    }
    return left;
  };
  const parseAnd = (): Expr | null => {
    let left = parseAtom();
    while (left && tokens[pos]?.toUpperCase() === 'AND') {
      pos++;
      const right = parseAtom();
      if (!right) return null;
      left = { t: 'and', a: left, b: right };
    }
    return left;
  };
  const parseAtom = (): Expr | null => {
    const tok = tokens[pos++];
    if (!tok) return null;
    if (tok === '(') {
      const e = parseOr();
      if (tokens[pos++] !== ')') return null;
      return e;
    }
    if (tokens[pos]?.toUpperCase() === 'WITH') pos += 2; // the exception does not change the verdict here
    return { t: 'id', id: tok.replace(/\+$/, '') };
  };
  const e = parseOr();
  return e && pos === tokens.length ? e : null;
}

function denied(id: string, policy: Policy): boolean {
  const upper = id.toUpperCase();
  return policy.deny.some(
    (d) => upper.startsWith(d.toUpperCase()) || upper.includes(d.toUpperCase()),
  );
}

export function evaluate(
  licence: string | undefined,
  policy: Policy,
  kind: 'code' | 'font' | 'data' = 'code',
): Verdict {
  if (!licence || licence === 'UNKNOWN' || licence === 'UNLICENSED')
    return { ok: false, reason: `no licence stated (${licence ?? 'missing'})` };
  const expr = parseSpdx(licence);
  if (!expr) return { ok: false, reason: `not an SPDX expression: ${licence}` };
  const allowed = new Set([
    ...policy.allow,
    ...(kind === 'font' ? policy.fontsOnly : []),
    ...(kind === 'data' ? policy.dataOnly : []),
  ]);
  let dual = false;
  const ok = (e: Expr): boolean => {
    if (e.t === 'id') return allowed.has(e.id) && !denied(e.id, policy);
    if (e.t === 'and') return ok(e.a) && ok(e.b);
    const r = ok(e.a) || ok(e.b);
    if (r) dual = true;
    return r;
  };
  return ok(expr)
    ? { ok: true, dual }
    : { ok: false, reason: `licence ${licence} is not on the allow-list` };
}

export function activeException(
  list: readonly Exception[],
  name: string,
  version: string,
  today: string,
): Exception | null {
  for (const e of list) {
    if (e.package !== name) continue;
    if (e.version && e.version !== version) continue;
    if (e.expires < today) continue;
    return e;
  }
  return null;
}
