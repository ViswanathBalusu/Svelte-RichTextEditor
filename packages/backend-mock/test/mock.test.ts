// backend-mock beyond the shared contract (SPK-019; PRO-099): it runs the real authority, refuses
// invalid content, keeps nothing outside memory and stays universal.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validate } from '@docedit/model/validate';
import { IDS, contractDocument } from '@docedit/protocol/contract';
import { isSyncReject, type Step } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { MockService } from '../src/index.ts';

const insert = (pos: number, text: string): Step => ({
  stepType: 'replace',
  from: pos,
  to: pos,
  slice: { content: [{ type: 'text', text }] },
});

async function open(
  service: MockService,
  docId: string,
  sub: string,
  role: 'editor' | 'suggester' | 'owner',
) {
  const b = service.backend({ sub }, { [docId]: role });
  await b.connect();
  const content = await b.sync.loadContent(docId);
  const ch = await b.sync.open(docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  return { b, ch, content };
}

describe('backend-mock', () => {
  it('starts from content that passes model.validate()', () => {
    expect(validate(contractDocument()).valid).toBe(true);
  });

  it('runs the real authority: the suggestion rule P4 and the step allow-list decide', async () => {
    const service = new MockService();
    const docId = service.createDocument(contractDocument());
    const { ch, content } = await open(service, docId, 'sam', 'suggester');
    // A suggester may not change text directly (07 §5.2 P4).
    const p4 = await ch
      .submit({
        id: '0192f0c4-7b1e-7c3a-9a54-000000000001',
        base: content.seq,
        steps: [insert(7, 'x')],
      })
      .catch((e: unknown) => e);
    expect(isSyncReject(p4) && [p4.code, p4.action]).toEqual(['permission_denied', 'drop']);
    // docAttr is refused by the authority (04 §4), not by the envelope.
    const editor = await open(service, docId, 'eddie', 'editor');
    const bad = await editor.ch
      .submit({
        id: '0192f0c4-7b1e-7c3a-9a54-000000000002',
        base: content.seq,
        steps: [{ stepType: 'docAttr', attr: 'x', value: 1 }],
      })
      .catch((e: unknown) => e);
    expect(isSyncReject(bad) && bad.code).toBe('invalid_op');
    await service.dispose();
  });

  it('refuses invalid CDM content with validation_failed', () => {
    const service = new MockService();
    const doc = contractDocument() as unknown as {
      doc: { content: Array<{ content: Array<{ attrs: Record<string, unknown> }> }> };
    };
    doc.doc.content[1]!.content[0]!.attrs['id'] = 'not-a-node-id';
    expect(() => service.createDocument(doc as never)).toThrow(/validation_failed|invalid CDM/);
  });

  it('keeps its data in memory only: a new service has none of it (PRO-099)', async () => {
    const first = new MockService();
    const docId = first.createDocument(contractDocument());
    const { ch, content } = await open(first, docId, 'olivia', 'owner');
    await ch.submit({
      id: '0192f0c4-7b1e-7c3a-9a54-000000000003',
      base: content.seq,
      steps: [insert(7, 'x')],
    });
    expect(first.document(docId)?.head).toBe(1);
    await first.dispose();
    const second = new MockService();
    expect(second.document(docId)).toBeUndefined();
  });

  it('maps the restricted region of the contract document to the scopes of 05 §5.5', async () => {
    const service = new MockService();
    const docId = service.createDocument(contractDocument(), {
      grants: [{ region: IDS.locked, principal: 'group:legal', role: 'editor' }],
    });
    const { ch } = await open(service, docId, 'eddie', 'editor');
    expect(Object.keys(ch.opened.access.scopes).sort()).toEqual(
      ['body', 'defs', 'doc', `region:${IDS.locked}`, `region:${IDS.open}`].sort(),
    );
    expect(ch.opened.access.scopes[`region:${IDS.locked}`]).toEqual(['view', 'comment']);
    expect(ch.opened.access.scopes[`region:${IDS.open}`]).toEqual([
      'view',
      'comment',
      'suggest',
      'edit',
    ]);
    await service.dispose();
  });

  it('lists who can edit each region, as the document service derives it (05 §6.2; PRM-032)', async () => {
    const service = new MockService();
    const docId = service.createDocument(contractDocument(), {
      grants: [
        { region: IDS.locked, principal: 'user:ada', role: 'editor' },
        { region: IDS.locked, principal: 'group:legal', role: 'editor' },
        // A grant that conveys no `edit`, and one that has expired, name nobody as an editor.
        { region: IDS.locked, principal: 'user:vic', role: 'commenter' },
        { region: IDS.open, principal: 'user:old', role: 'editor', expiresAt: service.now() - 1 },
      ],
    });
    const { b } = await open(service, docId, 'olivia', 'owner');
    const editors = async () =>
      Object.fromEntries((await b.permissions.regions!(docId)).map((r) => [r.id, r.editors]));
    expect(await editors()).toEqual({
      [IDS.open]: { roles: ['editor', 'owner'], principals: [] },
      [IDS.locked]: { roles: ['owner'], principals: ['group:legal', 'user:ada'] },
    });
    // A lease names its holder until it expires (07 §10).
    service.setLeases(docId, [
      { region: IDS.open, holder: 'bob', expiresAt: service.now() + 60_000 },
    ]);
    expect((await editors())[IDS.open]).toEqual({
      roles: ['editor', 'owner'],
      principals: [],
      leasedTo: 'bob',
    });
    service.advanceClock(60_001);
    expect((await editors())[IDS.open]).toEqual({ roles: ['editor', 'owner'], principals: [] });
    // Nobody can edit an approved region, or any region of a locked document (07 §4).
    await b.permissions.setRegionState!(docId, IDS.locked, 'approved', { ifMatch: '*' });
    expect((await editors())[IDS.locked]).toEqual({ roles: [], principals: [] });
    service.setDocumentState(docId, 'locked');
    expect((await editors())[IDS.open]).toEqual({ roles: [], principals: [] });
    await service.dispose();
  });

  it('is universal: no Node.js import, and type-checked without Node.js or DOM types (FND-004)', () => {
    const dir = resolve(import.meta.dirname, '../src');
    for (const f of readdirSync(dir)) {
      const text = readFileSync(resolve(dir, f), 'utf8');
      expect(/from\s+['"]node:|from\s+['"](fs|path|crypto|os|ws|http)['"]/.test(text), f).toBe(
        false,
      );
    }
    // Globals are caught by the compiler: the package's own config adds no lib and no types to the base.
    const config = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../tsconfig.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(config['extends']).toBe('../../tsconfig.base.json');
    expect(config['compilerOptions']).toBeUndefined();
  });
});
