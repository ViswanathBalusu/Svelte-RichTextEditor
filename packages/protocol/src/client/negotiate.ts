/**
 * Version and feature negotiation (05 §1 rules 1, 2, 4 and 5, §2; PRO-005, PRO-006), shared by
 * every DEP client so that they all choose the same way.
 */
import { DEP1_WIRE, type WireDefinition } from '../definition/wire.ts';
import { PROTOCOL_VERSION } from '../definition/common.ts';
import type { CdmRange, Discovery, ErrorCode } from '../generated/types.ts';

/** Experimental feature and message names start with `x-` (05 §1 rule 5). */
export const isExperimental = (name: string): boolean => name.startsWith('x-');

/** `MAJOR.MINOR` (05 §1 rule 1), or null for anything else. */
export function parseVersion(v: string): { major: number; minor: number } | null {
  const m = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(v);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

/**
 * The version a client expects for a session: the highest version both lists contain, or null.
 * 05 does not say how a server picks when several are common (PRO-006 notes); clients accept any
 * offered version in `welcome` and use this one only to predict and to check discovery (D82).
 */
export function chooseVersion(
  offered: readonly string[],
  supported: readonly string[],
): string | null {
  const common = offered.filter((v) => supported.includes(v) && parseVersion(v) !== null);
  common.sort((a, b) => {
    const x = parseVersion(a)!;
    const y = parseVersion(b)!;
    return y.major - x.major || y.minor - x.minor;
  });
  return common[0] ?? null;
}

/**
 * The major version in the WebSocket subprotocol (`dep.v1`) and in the REST base path (`/v1`);
 * the minor version appears only in `hello` and `welcome` (05 §1 rule 1).
 */
export function subprotocolFor(version: string = PROTOCOL_VERSION): string {
  const v = parseVersion(version);
  if (!v) throw new RangeError(`not a protocol version: ${version}`);
  return `dep.v${v.major}`;
}

/**
 * The features a client may use: those it asked for that the server announced (05 §1 rule 4), in
 * the order asked, without repeats. An experimental `x-` name counts only when both sides named it,
 * exactly like any other name; an unknown name announced by the server is ignored (PRO-005).
 */
export function negotiateFeatures(
  requested: readonly string[],
  announced: readonly string[],
): string[] {
  const offered = new Set(announced);
  const out: string[] = [];
  for (const f of requested) if (offered.has(f) && !out.includes(f)) out.push(f);
  return out;
}

/** What a client implements, checked against discovery before it opens the socket. */
export interface ClientCapabilities {
  versions: readonly string[];
  engines: readonly string[];
  cdm: CdmRange;
}

/** The client capabilities of this package: DEP 1.0, the engines and the CDM range of the definition. */
export function clientCapabilities(def: WireDefinition = DEP1_WIRE): ClientCapabilities {
  return { versions: [def.version], engines: [...def.engines], cdm: { ...def.cdm } };
}

/**
 * The features a relay announces that a relay may never announce (05 §2, §9; 04 §14; PRO-101): the
 * names the definition marks `relayForbidden` (`regions`, `suggest-enforced`, `fields`). A relay
 * cannot enforce them, because it does not run the document semantics. Empty for an authority, or
 * for a discovery document without `mode`.
 */
export function relayForbiddenAnnounced(
  d: Pick<Discovery, 'features'> & { mode?: Discovery['mode'] },
  def: WireDefinition = DEP1_WIRE,
): string[] {
  if (d.mode !== 'relay') return [];
  const forbidden = new Set(def.features.filter((f) => f.relayForbidden).map((f) => f.name));
  return [...new Set(d.features.filter((f) => forbidden.has(f)))];
}

/**
 * Whether a server's discovery document (05 §2) leaves something to talk about: a common version,
 * the engine and an overlapping CDM range, and a relay that announces none of the features a relay
 * may not announce. Null when it does, otherwise the registry code a client reports
 * (`unsupported_version`, `unsupported_engine`, `unsupported_cdm`, or `unsupported_feature` for a
 * relay that claims enforcement it cannot do; ADR 0154, proposed).
 */
export function checkDiscovery(
  d: Discovery,
  client: ClientCapabilities = clientCapabilities(),
  def: WireDefinition = DEP1_WIRE,
): { code: ErrorCode; message: string } | null {
  if (chooseVersion(client.versions, d.versions) === null)
    return {
      code: 'unsupported_version',
      message: `no common protocol version: the server offers ${d.versions.join(', ')}, this client ${client.versions.join(', ')}`,
    };
  if (!client.engines.some((e) => d.engines.includes(e)))
    return {
      code: 'unsupported_engine',
      message: `the server runs none of the engines ${client.engines.join(', ')}`,
    };
  if (d.cdm.max < client.cdm.min || d.cdm.min > client.cdm.max)
    return {
      code: 'unsupported_cdm',
      message: `the server's CDM versions ${d.cdm.min} to ${d.cdm.max} do not meet ${client.cdm.min} to ${client.cdm.max}`,
    };
  const claimed = relayForbiddenAnnounced(d, def);
  if (claimed.length)
    return {
      code: 'unsupported_feature',
      message: `a relay may not announce ${claimed.join(', ')} (05 §2): it cannot enforce them`,
    };
  return null;
}

/** The CDM major version a client uses with a server: the highest both support. */
export function chooseCdm(server: CdmRange, client: CdmRange): number | null {
  const v = Math.min(server.max, client.max);
  return v >= Math.max(server.min, client.min) ? v : null;
}

/**
 * Problems in the feature namespace of a definition (05 §1 rule 4): a name registered twice, or a
 * stable name with the experimental prefix (05 §1 rule 5). Protocol and CDM features share the
 * namespace; `cdmFeatures` are the CDM's names, which must be registered in it exactly once.
 */
export function featureNamespaceProblems(
  def: WireDefinition,
  cdmFeatures: readonly string[] = [],
): string[] {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  for (const f of def.features) seen.set(f.name, (seen.get(f.name) ?? 0) + 1);
  for (const [name, n] of seen)
    if (n > 1) problems.push(`feature ${name} is registered ${n} times`);
  for (const name of seen.keys())
    if (isExperimental(name)) problems.push(`stable feature ${name} uses the x- prefix`);
  for (const name of cdmFeatures)
    if (!seen.has(name)) problems.push(`CDM feature ${name} is not registered in the namespace`);
  for (const m of def.messages)
    if (isExperimental(m.t)) problems.push(`stable message type ${m.t} uses the x- prefix`);
  return problems;
}
