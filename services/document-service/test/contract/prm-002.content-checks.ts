// PRM-002 criterion 3 (07 §3), the storage half: what the stores keep for a document holds no
// permission data but a region's `policy`. The schema half, which covers every attribute a document
// can hold, is prm-002.schema.test.ts.
//
// The check writes grants, a region state and a lease for the region of the model's kitchen-sink
// document (every construct of the CDM, a role placeholder and assigned fields included), appends
// a control commit and a step commit that carries the whole document, and reads everything back:
// every field of every stored commit and the document record are searched, not only the steps.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { StoredCommit } from '@docedit/authority';
import type { JsonEnvelope } from '@docedit/model';
import { expect } from 'vitest';
import { controlCommit, newDocument, stepCommit, write, type StoreHarness } from './checks.ts';
import {
  DOCUMENT_STATES,
  isPermissionName,
  keysOf,
  typedAttrs,
} from './prm-002.permission-vocabulary.ts';

/** Values the grant, state and lease writes below put into the permission tables. */
const GRANT_PRINCIPAL = 'group:prm002-counsel';
const LEASE_HOLDER = 'u-prm002-lease-holder';
/** The initial grants of `newDocument` (checks.ts) and the values written below. */
const PERMISSION_VALUES = [
  GRANT_PRINCIPAL,
  LEASE_HOLDER,
  'group:legal',
  'user:dave',
  'suggester',
  'editor',
  'in_review',
];

/** The model's kitchen-sink document: every node and mark type of the CDM in one document. */
export function kitchenSink(): JsonEnvelope {
  const url = import.meta.resolve('@docedit/model/fixtures/kitchen-sink.json');
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as JsonEnvelope;
}

/** Runs the criterion against the stores in `h`; throws (through expect) when it fails. */
export async function checkContentHoldsOnlyPolicy(h: StoreHarness): Promise<void> {
  const { ref, epoch } = await newDocument(h);
  const doc = kitchenSink();
  const regions = typedAttrs(doc.doc).filter((n) => n.type === 'region');
  expect(regions.length).toBeGreaterThan(0);
  const region = String(regions[0]!.attrs['id']);

  await h.grants.change(
    ref,
    {
      putGrants: [{ region, principal: GRANT_PRINCIPAL, role: 'editor', expiresAt: null }],
      setRegionStates: [{ region, state: 'in_review' }],
      putLeases: [{ region, holder: LEASE_HOLDER, expiresAt: Date.now() + 3_600_000 }],
    },
    { actor: 'u-owner' },
  );
  const perms = await h.grants.current(ref);
  expect(perms.revision).toBe(2);
  expect(perms.grants.some((g) => g.principal === GRANT_PRINCIPAL)).toBe(true);

  // The room records the grants change as a control commit, then content follows under revision 2.
  // The step carries the whole document (definitions and body), as an import or a paste would.
  const steps = [
    { stepType: 'replace', from: 0, to: 0, slice: { content: doc.doc.content } },
  ] as unknown as StoredCommit['steps'];
  const written = [
    controlCommit(1, 2),
    stepCommit(2, { steps, revision: 2, scopes: ['body', `region:${region}`] }),
  ];
  expect(await h.logs.append(ref, write(epoch, written, 2))).toEqual({ status: 'ok' });

  const stored = await h.logs.read(ref);
  expect(stored.map((c) => c.seq)).toEqual([1, 2]);
  // The stores keep the content as written: nothing added, nothing dropped.
  expect(stored[1]!.steps).toEqual(steps);

  // 1. Every field of every stored commit, at any depth: the only permission-named key is the
  // `policy` of a region node.
  const commitKeys = new Set(keysOf(stored).filter(isPermissionName));
  expect([...commitKeys]).toEqual(['policy']);
  const withPolicy = typedAttrs(stored).filter((n) => 'policy' in n.attrs);
  expect(withPolicy.length).toBeGreaterThan(0);
  expect(new Set(withPolicy.map((n) => n.type))).toEqual(new Set(['region']));

  // 2. The document record: its only permission-named key is the document's `state`, which 07 §3
  // and §9 keep in the database row beside the grants, never in the content.
  const record = await h.docs.get(ref);
  expect(record).not.toBeNull();
  expect([...new Set(keysOf(record).filter(isPermissionName))]).toEqual(['state']);
  expect(DOCUMENT_STATES).toContain(record!.state);

  // 3. None of the grant, region-state or lease values appears in the commits or the record: no
  // string equals one, and the principals and the lease holder appear nowhere, not even inside a
  // longer string. (`historyVisibility: "editors"` is a word, not the role `editor`.)
  const strings = stringsOf({ stored, record });
  for (const v of PERMISSION_VALUES) expect(strings, v).not.toContain(v);
  const text = JSON.stringify({ stored, record });
  for (const v of PERMISSION_VALUES.filter((p) => p.includes(':') || p.startsWith('u-')))
    expect(text, v).not.toContain(v);
}

/** Every string reachable from `value`, keys excluded. */
function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, out);
  else if (value !== null && typeof value === 'object')
    for (const v of Object.values(value)) stringsOf(v, out);
  return out;
}
