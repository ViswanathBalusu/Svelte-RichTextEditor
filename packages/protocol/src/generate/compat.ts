// Backward compatibility between two sets of published DEP artifacts of one major version (05 §1
// rule 2; PRO-006 criterion 2). A later set may only add: optional fields, message types,
// resources, event types and feature names. The check reads the JSON the generator writes (the
// registry, the AsyncAPI and the OpenAPI document) and reports every removal or change it finds.
// It is a pure function over parsed JSON. The CI job that calls it on two published sets is the
// main session's (.github/); this module does not run it.
//
// Limits of the check: a parameter or response reached only through a `$ref` is compared as the
// reference it is, and prose annotations (title, description, $comment, summary, example and
// examples) are ignored, so editing a sentence never breaks compatibility.

type Obj = Record<string, unknown>;

/** The three documents the check reads, as parsed JSON. */
export interface ArtifactSetJson {
  registry: Obj;
  asyncapi: Obj;
  openapi: Obj;
}

const ANNOTATIONS = new Set(['title', 'description', '$comment', 'summary', 'example', 'examples']);
const HTTP_METHODS = ['get', 'put', 'post', 'patch', 'delete'] as const;

/** Registry lists: the key of each row, and the fields of a row that carry its contract. */
const REGISTRY_LISTS: ReadonlyArray<{ list: string; key: string; fields: readonly string[] }> = [
  { list: 'messages', key: 't', fields: ['direction', 'channelScoped', 'id', 're'] },
  {
    list: 'operations',
    key: 'operationId',
    fields: ['method', 'path', 'security', 'ifMatch', 'idempotencyKey', 'success'],
  },
  { list: 'errors', key: 'code', fields: ['surfaces', 'retryable', 'closeCode'] },
  { list: 'closeCodes', key: 'code', fields: [] },
  { list: 'features', key: 'name', fields: ['relayForbidden', 'port'] },
  { list: 'notifications', key: 'type', fields: ['resource'] },
  { list: 'webhooks', key: 'type', fields: [] },
];

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const rows = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

/** A canonical form for comparison: sorted keys, prose annotations removed. */
function canon(v: unknown): string {
  return JSON.stringify(strip(v));
}

function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (!isObj(v)) return v;
  const out: Obj = {};
  for (const k of Object.keys(v).sort()) {
    if (!ANNOTATIONS.has(k)) out[k] = strip(v[k]);
  }
  return out;
}

const same = (a: unknown, b: unknown): boolean => canon(a) === canon(b);

const major = (version: unknown): string => String(version ?? '').split('.')[0] ?? '';

function registryProblems(earlier: Obj, later: Obj): string[] {
  const problems: string[] = [];
  for (const { list, key, fields } of REGISTRY_LISTS) {
    const after = new Map(rows(later[list]).map((r) => [String(r[key]), r] as const));
    for (const before of rows(earlier[list])) {
      const id = String(before[key]);
      const next = after.get(id);
      if (!next) {
        problems.push(`${list} ${id} was removed`);
        continue;
      }
      for (const f of fields) {
        if (!same(before[f], next[f])) problems.push(`${list} ${id}: ${f} changed`);
      }
    }
  }
  return problems;
}

const schemasOf = (doc: Obj): Obj => {
  const components = isObj(doc['components']) ? doc['components'] : {};
  return isObj(components['schemas']) ? components['schemas'] : {};
};

/** Each schema of `where` keeps its properties, their shape and its required members. */
function schemaProblems(where: string, earlier: Obj, later: Obj): string[] {
  const problems: string[] = [];
  const before = schemasOf(earlier);
  const after = schemasOf(later);
  for (const name of Object.keys(before)) {
    const was = before[name];
    const now = after[name];
    if (!isObj(was)) continue;
    if (!isObj(now)) {
      problems.push(`${where} schema ${name} was removed`);
      continue;
    }
    const wasProps = isObj(was['properties']) ? was['properties'] : {};
    const nowProps = isObj(now['properties']) ? now['properties'] : {};
    for (const p of Object.keys(wasProps)) {
      if (!(p in nowProps)) problems.push(`${where} ${name}.${p} was removed`);
      else if (!same(wasProps[p], nowProps[p])) problems.push(`${where} ${name}.${p} changed`);
    }
    const wasReq = Array.isArray(was['required']) ? (was['required'] as string[]) : [];
    const nowReq = Array.isArray(now['required']) ? (now['required'] as string[]) : [];
    for (const r of wasReq) {
      if (!nowReq.includes(r)) problems.push(`${where} ${name}.${r} is no longer required`);
    }
    for (const r of nowReq) {
      if (!wasReq.includes(r)) problems.push(`${where} ${name}.${r} is newly required`);
    }
  }
  return problems;
}

/** A parameter as written, or the parameter a component reference names in `doc`. */
function resolveParameter(doc: Obj, p: unknown): Obj | undefined {
  if (!isObj(p)) return undefined;
  const ref = p['$ref'];
  if (typeof ref !== 'string') return p;
  const prefix = '#/components/parameters/';
  if (!ref.startsWith(prefix)) return undefined;
  const components = isObj(doc['components']) ? doc['components'] : {};
  const params = isObj(components['parameters']) ? components['parameters'] : {};
  const hit = params[ref.slice(prefix.length)];
  return isObj(hit) ? hit : undefined;
}

function openapiProblems(earlier: Obj, later: Obj): string[] {
  const problems: string[] = [];
  const paths = (doc: Obj): Obj => (isObj(doc['paths']) ? doc['paths'] : {});
  const before = paths(earlier);
  const after = paths(later);
  for (const path of Object.keys(before)) {
    const item = before[path];
    if (!isObj(item)) continue;
    for (const method of HTTP_METHODS) {
      const was = item[method];
      if (!isObj(was)) continue;
      const label = `${method.toUpperCase()} ${path}`;
      const nowItem = after[path];
      const now = isObj(nowItem) ? nowItem[method] : undefined;
      if (!isObj(now)) {
        problems.push(`${label} was removed`);
        continue;
      }
      const wasResp = isObj(was['responses']) ? was['responses'] : {};
      const nowResp = isObj(now['responses']) ? now['responses'] : {};
      for (const code of Object.keys(wasResp)) {
        if (!(code in nowResp)) problems.push(`${label}: response ${code} was removed`);
      }
      if (!same(was['security'] ?? [], now['security'] ?? [])) {
        problems.push(`${label}: security changed`);
      }
      if (was['requestBody'] !== undefined) {
        if (!same(was['requestBody'], now['requestBody'])) {
          problems.push(`${label}: request body changed`);
        }
      } else if (isObj(now['requestBody']) && now['requestBody']['required'] === true) {
        problems.push(`${label}: now requires a request body`);
      }
      const wasParams = Array.isArray(was['parameters']) ? was['parameters'] : [];
      const nowParams = Array.isArray(now['parameters']) ? now['parameters'] : [];
      const resolvedNow = nowParams.map((p) => resolveParameter(later, p));
      const resolvedWas = wasParams.map((p) => resolveParameter(earlier, p));
      for (const p of resolvedWas) {
        if (!p) continue;
        if (!resolvedNow.some((q) => q && same(p, q))) {
          problems.push(`${label}: parameter ${String(p['name'])} was removed or changed`);
        }
      }
      for (const q of resolvedNow) {
        if (!q || q['required'] !== true) continue;
        if (!resolvedWas.some((p) => p && same(p, q))) {
          problems.push(`${label}: new required parameter ${String(q['name'])}`);
        }
      }
    }
  }
  return problems;
}

/**
 * Every way the later set breaks compatibility with the earlier set of the same major version.
 * An empty list means the later set only adds (05 §1 rule 2).
 */
export function compatibilityProblems(earlier: ArtifactSetJson, later: ArtifactSetJson): string[] {
  const problems: string[] = [];
  if (major(earlier.registry['protocol']) !== major(later.registry['protocol'])) {
    problems.push(
      `protocol major version differs: ${String(earlier.registry['protocol'])} against ${String(later.registry['protocol'])}`,
    );
    return problems;
  }
  problems.push(...registryProblems(earlier.registry, later.registry));
  problems.push(...schemaProblems('asyncapi', earlier.asyncapi, later.asyncapi));
  problems.push(...schemaProblems('openapi', earlier.openapi, later.openapi));
  problems.push(...openapiProblems(earlier.openapi, later.openapi));
  return problems;
}
