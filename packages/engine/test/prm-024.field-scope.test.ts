/**
 * PRM-024 criterion 1 at the engine, for a `field:<id>` scope (lane PRM-015-028, round 2): the
 * recovered edits name the scope the field lies in on the confirmed document, not the field
 * itself. The mock service never refuses a commit for a field, so the refusal is played by the
 * channel: its first `submit` rejects with `permission_denied` and the scope the test names.
 * Everything else is the real room (authority, protocol bridge, sync session).
 */
import type { SyncChannel, SyncReject } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, microtask, newService, sleep, type, until } from './support.ts';

const FIELD_IN_REGION = 'fRegionField0001';
const FIELD_IN_BODY = 'fBodyField000001';
const FIELD_UNKNOWN = 'fNoSuchField0001';

/** Adds a form field to the paragraph with `paraId`, walking the CDM JSON in place. */
function addFieldTo(node: unknown, paraId: string, fieldId: string): boolean {
  if (typeof node !== 'object' || node === null) return false;
  const n = node as { type?: string; attrs?: { id?: unknown }; content?: unknown[] };
  if (n.type === 'paragraph' && n.attrs?.id === paraId) {
    n.content = [
      ...(n.content ?? []),
      {
        type: 'form_field',
        attrs: { id: fieldId, kind: 'text', key: fieldId, label: 'Field', value: 'v' },
      },
    ];
    return true;
  }
  return (n.content ?? []).some((c) => addFieldTo(c, paraId, fieldId));
}

/** The contract document with one form field in the restricted region and one in the body. */
function documentWithFields() {
  const env = structuredClone(contractDocument());
  const inRegion = addFieldTo(env.doc, IDS.lockedPara, FIELD_IN_REGION);
  const inBody = addFieldTo(env.doc, IDS.intro, FIELD_IN_BODY);
  if (!inRegion || !inBody) throw new Error('the contract document lost its paragraphs');
  return { ...env, requires: [...env.requires, 'fields' as const] };
}

/**
 * Runs one typed change in the restricted region whose first submit is refused with
 * `permission_denied` and the given scopes; returns the recovered item for that refusal.
 */
async function refusedWith(scopes: string[]) {
  const service = newService();
  const env = documentWithFields();
  const docId = service.createDocument(env, { grants: [LEGAL_GRANT_FOR_TESTS] });
  const backend = service.backend({ sub: 'grace', groups: ['legal'] }, { [docId]: 'editor' });
  await backend.connect();
  const content = await backend.sync.loadContent(docId);
  const core = new DocumentCore({ doc: content, schedule: microtask });
  const real = await backend.sync.open(docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  let refused = false;
  const channel: SyncChannel = {
    ...real,
    docId: real.docId,
    opened: real.opened,
    submit: (c) => {
      if (refused) return real.submit(c);
      refused = true;
      const reject: SyncReject = {
        id: c.id,
        code: 'permission_denied',
        message: 'No edit permission for the scopes named',
        action: 'drop',
        head: 0,
        scopes,
      };
      return Promise.reject(reject);
    },
    onCommits: (cb) => real.onCommits(cb),
    onReset: (cb) => real.onReset(cb),
    onAccess: (cb) => real.onAccess(cb),
    onEvent: (cb) => real.onEvent(cb),
    onState: (cb) => real.onState(cb),
    onCheck: (cb) => real.onCheck(cb),
    close: () => real.close(),
  };
  const limits = backend.auth.session?.limits;
  const detach = core.attach(channel, {
    seq: content.seq,
    incarnation: content.incarnation,
    sync: backend.sync,
    ...(limits ? { limits } : {}),
    batchMs: 0,
    retry: { minMs: 2, maxMs: 20 },
  });
  caret(core, IDS.lockedPara, 0);
  type(core, 'clause ');
  await until(() => refused, 'the first submit');
  await until(
    () => core.recovered.get().items.some((r) => r.reason === 'permission_denied'),
    'the rejection in recovered edits',
  );
  await sleep(1);
  const item = core.recovered.get().items.find((r) => r.reason === 'permission_denied');
  detach();
  await service.dispose();
  return item;
}

describe('a field scope names the scope the field lies in (PRM-024 criterion 1, round 2)', () => {
  it('names the region that holds a field the server refused', async () => {
    const item = await refusedWith([`field:${FIELD_IN_REGION}`]);
    expect(item).toMatchObject({
      reason: 'permission_denied',
      scope: `region:${IDS.locked}`,
      scopes: [`region:${IDS.locked}`],
    });
  });

  it('names the body for a field that lies in the body', async () => {
    const item = await refusedWith([`field:${FIELD_IN_BODY}`]);
    expect(item).toMatchObject({ scope: 'body', scopes: ['body'] });
  });

  it('names nothing for a field the confirmed document does not hold', async () => {
    const item = await refusedWith([`field:${FIELD_UNKNOWN}`]);
    expect(item).toBeDefined();
    expect(item!.scope).toBeNull();
    expect(item!.scopes).toEqual([]);
  });
});
