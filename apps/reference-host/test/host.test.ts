// The reference host's server logic against the real document service in memory (UX-092, UX-094):
// the token endpoint with both issuers, the catalogue and the service calls behind it, role changes
// that revoke, and the seed files.
import { afterEach, describe, expect, it } from 'vitest';
import { Directory, isOpaqueSub } from '../src/lib/server/directory.ts';
import {
  changeRole,
  createFromTemplate,
  deleteDocument,
  renameDocument,
  OwnerOnlyError,
  setRegionGrant,
  setRestrictions,
  setRestrictionsAs,
  templateContent,
} from '../src/lib/server/documents.ts';
import { SEED_DIR } from '../src/lib/server/config.ts';
import { ServiceError } from '../src/lib/server/service.ts';
import { grantFor, tokenFor } from '../src/lib/server/tokens.ts';
import { decodeJws, HOST_ISSUER, SERVICE_ID, startHarness, type Harness } from './support.ts';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const template = (x: Harness) => x.host.seed.templates.find((t) => t.key === 'two-regions')!;

async function demoDocument(x: Harness, externalId?: string) {
  return createFromTemplate(x.host, {
    template: template(x),
    title: 'A test agreement',
    creator: 'u-olivia',
    ...(externalId !== undefined ? { externalId } : {}),
  });
}

describe('the seeded directory (UX-092 criterion 2, `sub` opaque; UX-093 criterion 1)', () => {
  it('has opaque subs that are not e-mail addresses, and refuses one that is', async () => {
    const d = await Directory.load(SEED_DIR);
    expect(d.users.length).toBeGreaterThanOrEqual(3);
    for (const u of d.users) expect(isOpaqueSub(u.sub) && !u.sub.includes('@')).toBe(true);
    expect(
      () => new Directory([{ sub: 'ada@example.org', name: 'A', groups: [], about: '' }], []),
    ).toThrow(/opaque/);
  });

  it('resolves identifiers in order and finds users and groups', async () => {
    const d = await Directory.load(SEED_DIR);
    expect(d.resolve(['u-bob', 'nobody', 'u-ada'])).toEqual([
      { id: 'u-bob', name: 'Bob Mensah' },
      null,
      { id: 'u-ada', name: 'Ada Lindqvist' },
    ]);
    expect(d.search('bo', ['user'], 10)).toEqual([{ principal: 'user:u-bob', name: 'Bob Mensah' }]);
    expect(d.search('fin', ['group'], 10).map((p) => p.principal)).toEqual(['group:g-finance']);
    expect(d.search('', ['user', 'group'], 2)).toHaveLength(2);
  });
});

describe('the token endpoint (UX-092 criteria 2 and 5)', () => {
  for (const mode of ['service-minted', 'host-signed'] as const)
    it(`issues ${mode} tokens with the claims of 05 §3.1, which the service accepts`, async () => {
      h = await startHarness({ tokenMode: mode, tokenSeconds: 300 });
      const entry = await demoDocument(h);
      const ada = h.host.directory.user('u-ada')!;
      const issued = await h.host.tokens.issue({
        user: ada,
        doc: entry.id,
        role: 'editor',
        accessSince: entry.accessSince['u-ada']!,
      });
      const { header, payload } = decodeJws(issued.token);
      // An algorithm of the allow-list (05 §3.1): EdDSA for the service's key, ES256 for the host's.
      expect(header['alg']).toBe(mode === 'host-signed' ? 'ES256' : 'EdDSA');
      expect(payload['iss']).toBe(mode === 'host-signed' ? HOST_ISSUER : SERVICE_ID);
      expect(payload['aud']).toBe(SERVICE_ID);
      expect(payload['tid']).toBe(h.tenant);
      expect(payload['sub']).toBe('u-ada');
      expect(String(payload['sub'])).not.toContain('@');
      expect(payload['name']).toBe('Ada Lindqvist');
      expect(payload['grp']).toEqual(['g-finance']);
      expect(payload['docs']).toEqual({ [entry.id]: 'editor' });
      expect(Object.keys(payload['docs'] as object).length).toBeLessThanOrEqual(20);
      expect(payload['access_since']).toBe(entry.accessSince['u-ada']);
      expect(typeof payload['jti']).toBe('string');
      const iat = payload['iat'] as number;
      const exp = payload['exp'] as number;
      expect(exp - iat).toBe(300);
      expect(exp - iat).toBeLessThanOrEqual(15 * 60);
      expect(Date.parse(issued.expiresAt)).toBe(exp * 1000);
      // The service verifies it against the tenant's keys (PRO-009, PRO-010, PRO-011).
      const identity = await h.service.tokens.verifyUser(issued.token);
      expect(identity.sub).toBe('u-ada');
      expect(identity.docs[entry.id]).toBe('editor');
      // Renewal: every call issues a new token (criterion 5).
      const again = await h.host.tokens.issue({ user: ada, doc: entry.id, role: 'editor' });
      expect(decodeJws(again.token).payload['jti']).not.toBe(payload['jti']);
      await expect(h.service.tokens.verifyUser(again.token)).resolves.toMatchObject({
        sub: 'u-ada',
      });
    });
});

describe("the host's catalogue and the service (UX-094)", () => {
  it('creates a document from a template with the externalId, title, roles and grants (criterion 2)', async () => {
    h = await startHarness();
    const entry = await demoDocument(h, 'refhost-test-1');
    expect(entry.externalId).toBe('refhost-test-1');
    expect(entry.roles).toEqual({
      'u-olivia': 'owner',
      'u-ada': 'editor',
      'u-bob': 'editor',
      'u-vic': 'viewer',
    });
    const { doc } = await h.host.service.getDocument(entry.id);
    expect(doc).toMatchObject({ externalId: 'refhost-test-1', title: 'A test agreement' });
    const { grants } = await h.host.service.getGrants(entry.id);
    expect(grants.grants).toEqual(
      expect.arrayContaining([
        { region: 'rAdaSection00001', principal: 'user:u-ada', role: 'editor', expiresAt: null },
        { region: 'rBobSection00001', principal: 'user:u-bob', role: 'editor', expiresAt: null },
      ]),
    );
    // The list shows the documents a user has a role on, with the host's titles (criterion 1).
    expect(h.host.catalogue.listFor('u-ada').map((d) => d.title)).toEqual(['A test agreement']);
    expect(h.host.catalogue.listFor('u-nobody')).toEqual([]);
    // Again with the same externalId: the same document, nothing new (seeding is repeatable).
    const again = await demoDocument(h, 'refhost-test-1');
    expect(again.id).toBe(entry.id);
    expect((await h.host.service.listDocuments()).items).toHaveLength(1);
  });

  it('renames in both places and deletes softly (criterion 3)', async () => {
    h = await startHarness();
    const entry = await demoDocument(h);
    await renameDocument(h.host, entry.id, '  Renamed   agreement ', 'u-olivia');
    expect(h.host.catalogue.get(entry.id)?.title).toBe('Renamed agreement');
    expect((await h.host.service.getDocument(entry.id)).doc.title).toBe('Renamed agreement');
    await deleteDocument(h.host, entry.id, 'u-olivia');
    expect(h.host.catalogue.listFor('u-olivia')).toEqual([]);
    // Soft: the catalogue keeps the row with the time of deletion, the service refuses the document.
    expect(h.host.catalogue.byExternalId(entry.externalId)?.deletedAt).toEqual(expect.any(String));
    await expect(h.host.service.getDocument(entry.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('looks documents up by externalId with { items, nextCursor } and at most 200; a user token is refused (criterion 4)', async () => {
    h = await startHarness();
    const a = await demoDocument(h, 'refhost-page-a');
    await demoDocument(h, 'refhost-page-b');
    expect((await h.host.service.findByExternalId('refhost-page-a'))?.id).toBe(a.id);
    expect(await h.host.service.findByExternalId('refhost-none')).toBeNull();
    const first = await h.host.service.listDocuments({ limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await h.host.service.listDocuments({ limit: 1, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    expect(second.nextCursor).toBeNull();
    // The client never asks for more than 200 (05 §6.1).
    const asked: string[] = [];
    const spy = new (await import('../src/lib/server/service.ts')).ServiceClient({
      rest: h.rest,
      apiKey: h.apiKey,
      fetch: (input, init) => {
        asked.push(String(input));
        return fetch(input, init);
      },
    });
    await spy.listDocuments({ limit: 5000 });
    expect(new URL(asked[0]!).searchParams.get('limit')).toBe('200');
    // A user token cannot list documents: only the host's service credential can.
    const token = (
      await h.host.tokens.issue({
        user: h.host.directory.user('u-olivia')!,
        doc: a.id,
        role: 'owner',
      })
    ).token;
    const res = await fetch(`${h.rest}/documents`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect([401, 403]).toContain(res.status);
  });
});

describe('output restrictions in the next token (UX-095 criterion 5)', () => {
  for (const mode of ['service-minted', 'host-signed'] as const)
    it(`puts the restrictions the owner set into the ${mode} token, which the service reads back`, async () => {
      h = await startHarness({ tokenMode: mode });
      const entry = await demoDocument(h);
      const set = await setRestrictions(h.host, entry.id, 'u-ada', [
        'no-export',
        'no-copy',
        'no-export',
      ]);
      expect(set.restrict?.['u-ada']).toEqual(['no-export', 'no-copy']);
      // The token endpoint's own logic builds the grant from the catalogue (`tokenFor`, `grantFor`).
      const issued = (await tokenFor(h.host, h.host.directory.user('u-ada')!, entry.id))!;
      expect(decodeJws(issued.token).payload['restrict']).toEqual(['no-export', 'no-copy']);
      expect(decodeJws(issued.token).payload['docs']).toEqual({ [entry.id]: 'editor' });
      const identity = await h.service.tokens.verifyUser(issued.token);
      expect(identity.restrict).toEqual(['no-export', 'no-copy']);
    });

  it('builds the grant from the catalogue, and none for a person without a role', async () => {
    h = await startHarness();
    const entry = await demoDocument(h);
    const ada = h.host.directory.user('u-ada')!;
    await setRestrictionsAs(h.host, 'u-olivia', entry.id, 'u-ada', ['no-print']);
    expect(grantFor(h.host.catalogue.get(entry.id), ada)).toEqual({
      user: ada,
      doc: entry.id,
      role: 'editor',
      accessSince: entry.accessSince['u-ada'],
      restrict: ['no-print'],
    });
    const outsider = { sub: 'u-nobody', name: 'Nobody', groups: [], about: '' };
    expect(grantFor(h.host.catalogue.get(entry.id), outsider)).toBeNull();
    expect(await tokenFor(h.host, outsider, entry.id)).toBeNull();
    expect(await tokenFor(h.host, ada, 'no-such-document')).toBeNull();
  });

  it('lets only the owner set restrictions, and only on a person with a role', async () => {
    h = await startHarness();
    const entry = await demoDocument(h);
    // u-bob is an editor, not the owner.
    await expect(
      setRestrictionsAs(h.host, 'u-bob', entry.id, 'u-ada', ['no-copy']),
    ).rejects.toBeInstanceOf(OwnerOnlyError);
    await expect(
      setRestrictionsAs(h.host, 'u-nobody', entry.id, 'u-ada', ['no-copy']),
    ).rejects.toBeInstanceOf(OwnerOnlyError);
    expect(h.host.catalogue.get(entry.id)?.restrict?.['u-ada']).toBeUndefined();
    await expect(
      setRestrictionsAs(h.host, 'u-olivia', entry.id, 'u-nobody', ['no-copy']),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('refuses a restriction outside the three names and clears all of them with an empty list', async () => {
    h = await startHarness();
    const entry = await demoDocument(h);
    await expect(setRestrictions(h.host, entry.id, 'u-ada', ['no-share'])).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(h.host.catalogue.get(entry.id)?.restrict?.['u-ada']).toBeUndefined();
    await setRestrictions(h.host, entry.id, 'u-ada', ['no-print']);
    await setRestrictions(h.host, entry.id, 'u-ada', []);
    const issued = (await tokenFor(h.host, h.host.directory.user('u-ada')!, entry.id))!;
    expect(decodeJws(issued.token).payload['restrict']).toBeUndefined();
    await expect(h.service.tokens.verifyUser(issued.token)).resolves.toMatchObject({
      restrict: [],
    });
  });
});

describe('service calls and the attribution named by DEP-Actor (UX-097 criterion 2; UX-096)', () => {
  it('attributes a service call without DEP-Actor to system, and one with it to the named user surrogate', async () => {
    h = await startHarness();
    const content = await templateContent(SEED_DIR, template(h));
    const anonymous = await h.host.service.createDocument(
      { content, externalId: 'refhost-attr-anon', title: 'No actor' },
      'refhost-attr-anon',
    );
    const named = await h.host.service.createDocument(
      { content, externalId: 'refhost-attr-named', title: 'Named actor' },
      'refhost-attr-named',
      'u-olivia',
    );
    const anonRow = await h.service.parts.documents.get({ tenant: h.tenant, doc: anonymous.id });
    const namedRow = await h.service.parts.documents.get({ tenant: h.tenant, doc: named.id });
    expect(anonRow?.createdBy).toBe('system');
    const olivia = (await h.service.parts.users.resolve(h.tenant, 'u-olivia')).surrogate;
    expect(namedRow?.createdBy).toBe(olivia);
    expect(olivia).not.toBe('u-olivia');
  });

  it('a user token with DEP-Actor acts for the token holder only: the header has no effect (UX-097 criterion 3)', async () => {
    h = await startHarness();
    const entry = await demoDocument(h);
    const bob = h.host.directory.user('u-bob')!;
    const { doc, etag } = await h.host.service.getDocument(entry.id);
    const rest = h.rest;
    const patch = (token: string, actor: string, title: string, ifMatch: string) =>
      fetch(`${rest}/documents/${doc.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'DEP-Actor': actor,
          'Content-Type': 'application/json',
          'If-Match': ifMatch,
        },
        body: JSON.stringify({ title }),
      });

    // Bob is an editor: he may not manage the document. If DEP-Actor named Olivia (the owner) and
    // the header counted, the call would succeed; with a user token it is ignored, so it is refused.
    const bobToken = (await h.host.tokens.issue({ user: bob, doc: entry.id, role: 'editor' }))
      .token;
    const refused = await patch(bobToken, 'u-olivia', 'Changed by Bob naming Olivia', etag);
    expect(refused.status).toBe(403);
    const unchanged = await h.host.service.getDocument(entry.id);
    expect(unchanged.doc.title).toBe('A test agreement');

    // The owner's token with a DEP-Actor naming someone else acts as the owner, and the change applies.
    const olivia = h.host.directory.user('u-olivia')!;
    const ownerToken = (await h.host.tokens.issue({ user: olivia, doc: entry.id, role: 'owner' }))
      .token;
    const allowed = await patch(ownerToken, 'u-bob', 'Changed by the owner', etag);
    expect(allowed.status).toBe(200);
    expect((await h.host.service.getDocument(entry.id)).doc.title).toBe('Changed by the owner');
  });
});

describe('roles and region grants (UX-092 criterion 4; the live grant change of 11 §3)', () => {
  it('revokes the sessions of a user whose role is taken away, so that their token stops working', async () => {
    h = await startHarness();
    const entry = await demoDocument(h);
    const bob = h.host.directory.user('u-bob')!;
    const token = (await h.host.tokens.issue({ user: bob, doc: entry.id, role: 'editor' })).token;
    await expect(h.service.tokens.verifyUser(token)).resolves.toMatchObject({ sub: 'u-bob' });
    // The watermark is to the second (D73): a token issued in the same second would still work.
    await new Promise((r) => setTimeout(r, 1100));
    await changeRole(h.host, entry.id, 'u-bob', null);
    expect(h.host.catalogue.roleOf(entry.id, 'u-bob')).toBeNull();
    await expect(h.service.tokens.verifyUser(token)).rejects.toMatchObject({ code: 'revoked' });
  });

  it('gives and takes region grants through the service', async () => {
    h = await startHarness();
    const entry = await demoDocument(h);
    const after = await setRegionGrant(h.host, entry.id, 'u-olivia', {
      region: 'rBobSection00001',
      principal: 'user:u-ada',
      role: 'editor',
    });
    expect(after).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          region: 'rBobSection00001',
          principal: 'user:u-ada',
          role: 'editor',
        }),
      ]),
    );
    const removed = await setRegionGrant(h.host, entry.id, 'u-olivia', {
      region: 'rBobSection00001',
      principal: 'user:u-ada',
      role: null,
    });
    expect(
      removed.some((g) => g.region === 'rBobSection00001' && g.principal === 'user:u-ada'),
    ).toBe(false);
  });

  it('reports a refusal of the service as a ServiceError with the registry code', async () => {
    h = await startHarness();
    await expect(
      h.host.service.getDocument('0192f0c1-0000-7000-8000-000000000000'),
    ).rejects.toBeInstanceOf(ServiceError);
  });
});
