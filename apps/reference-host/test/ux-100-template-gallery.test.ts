// The template gallery of the reference host (UX-100), through the host's own routes and the real
// document service in memory. The gallery lists the templates of the host's catalogue; using one
// goes through the service's templates resource (a fork at a pinned seq, with the values prefilled
// in the same call); the new document appears in the document list; the kinds of field the service
// sets itself are not offered, and the service refuses them when they are sent.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Catalogue } from '../src/lib/server/catalogue.ts';
import {
  registerSeedTemplates,
  SERVER_SET_KINDS,
  prefillableFields,
} from '../src/lib/server/documents.ts';
import type * as HostModule from '../src/lib/server/host.ts';
import { SESSION_COOKIE } from '../src/lib/server/sessions.ts';
import { startHarness, type Harness } from './support.ts';

const current = vi.hoisted(() => ({ host: null as unknown }));

vi.mock('../src/lib/server/host.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof HostModule>()),
  host: async () => current.host,
}));

// Loaded by path at run time: the `./$types` imports are SvelteKit's generated types.
const GALLERY = '../src/routes/as/[user]/templates/+page.server.ts';

interface Gallery {
  load(event: unknown): Promise<{
    templates: Array<{
      id: string;
      key: string;
      name: string;
      fields: Array<{ key: string; kind: string; label: string }>;
    }>;
  }>;
  actions: Record<string, (event: unknown) => Promise<unknown>>;
}

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
  current.host = null;
});

const cookiesFor = (session: string) => ({
  get: (name: string) => (name === SESSION_COOKIE ? session : undefined),
});

async function start() {
  const harness = await startHarness();
  h = harness;
  current.host = harness.host;
  await registerSeedTemplates(harness.host, harness.host.seed);
  const route = (await import(/* @vite-ignore */ GALLERY)) as Gallery;
  const cookies = cookiesFor(harness.host.sessions.create('u-olivia'));
  interface Outcome {
    status?: number | undefined;
    data?: { problem?: string };
    redirect?: string;
  }
  const use = async (fields: Record<string, string>): Promise<Outcome> => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    try {
      return (await route.actions['use']!({
        params: { user: 'u-olivia' },
        cookies,
        request: new Request('http://host.test/templates?/use', { method: 'POST', body: form }),
      })) as Outcome;
    } catch (e) {
      // SvelteKit's `redirect()` throws a Redirect with a status and a location.
      const r = e as { status?: number; location?: string };
      if (typeof r.location === 'string') return { redirect: r.location, status: r.status };
      throw e;
    }
  };
  return { harness, route, use };
}

/** A read of the service with the host's credential, for what the host's client does not expose. */
async function serviceGet(harness: Harness, path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${harness.rest}${path}`, {
    headers: { Authorization: `Bearer ${harness.apiKey}`, Accept: 'application/json' },
  });
  expect(res.status, path).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe('the template gallery (UX-100)', () => {
  it('lists the templates of the host catalogue (criterion 1)', async () => {
    const { harness, route } = await start();
    const page = await route.load({ parent: async () => ({}) });
    expect(page.templates.map((t) => [t.key, t.name])).toEqual([['lease', 'Lease agreement']]);
    // They are the catalogue's, and the service holds them as templates of the tenant.
    const catalogued = harness.host.catalogue.listTemplates();
    expect(catalogued).toHaveLength(1);
    const listed = (await harness.host.service.listTemplates()).map((t) => t.id);
    expect(listed).toEqual([catalogued[0]!.id]);
    // Registering again changes nothing (seeding can be repeated).
    await registerSeedTemplates(harness.host, harness.host.seed);
    expect(harness.host.catalogue.listTemplates()).toHaveLength(1);
    expect(await harness.host.service.listTemplates()).toHaveLength(1);
  });

  it('survives a restart of the host: the catalogue file keeps the templates', async () => {
    const { harness } = await start();
    const file = `${harness.host.config.dataDir}/catalogue.json`;
    const reopened = await Catalogue.open(file);
    expect(reopened.listTemplates().map((t) => t.key)).toEqual(['lease']);
  });

  it('offers only the kinds that may be prefilled (criterion 3)', async () => {
    const { harness, route } = await start();
    const page = await route.load({ parent: async () => ({}) });
    const fields = page.templates[0]!.fields;
    expect(fields.map((f) => [f.key, f.kind])).toEqual([
      ['tenant.name', 'text'],
      ['lease.rent', 'number'],
      ['lease.start', 'date'],
    ]);
    // The template does hold fields of the kinds the service sets itself: they are left out.
    const all = await harness.host.service.listFields(
      harness.host.catalogue.listTemplates()[0]!.document,
    );
    expect(all.map((f) => f.kind).sort()).toEqual(
      ['date', 'dateSigned', 'number', 'signature', 'text'].sort(),
    );
    for (const f of all.filter((x) => SERVER_SET_KINDS.includes(x.kind)))
      expect(fields.map((x) => x.key)).not.toContain(f.key);
  });

  it('the service refuses what the gallery leaves out, and nothing is created', async () => {
    const { harness } = await start();
    const t = harness.host.catalogue.listTemplates()[0]!;
    const before = (await harness.host.service.listDocuments()).items.length;
    const res = await fetch(`${harness.rest}/documents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${harness.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'ux-100-signature',
      },
      body: JSON.stringify({ template: t.id, values: { 'tenant.signature': 'Olivia' } }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('field_invalid');
    expect((await harness.host.service.listDocuments()).items.length).toBe(before);
  });

  it('uses a template: a fork at a pinned seq with the values prefilled, listed and opened (criteria 2 and 3)', async () => {
    const { harness, use } = await start();
    const t = harness.host.catalogue.listTemplates()[0]!;
    const result = await use({
      template: t.id,
      title: 'Lease for Flat 4',
      'value:tenant.name': 'Ada Lovelace',
      'value:lease.rent': '1200.50',
      'value:lease.start': '2027-01-01',
    });
    expect(result.status).toBe(303);
    const created = harness.host.catalogue
      .listFor('u-olivia')
      .find((d) => d.title === 'Lease for Flat 4');
    expect(created).toBeDefined();
    expect((result as { redirect?: string }).redirect).toBe(`/as/u-olivia/docs/${created!.id}`);
    expect(created!.template).toBe('lease');
    expect(created!.roles).toEqual({ 'u-olivia': 'owner' });

    // The service forked the template document at a pinned seq, and the host kept that seq.
    expect(created!.templateSeq).toBeTypeOf('number');
    const templateHead = (await serviceGet(harness, `/documents/${t.document}`))['seq'];
    if (typeof templateHead === 'number') expect(created!.templateSeq).toBe(templateHead);
    // The values were prefilled in the same call.
    const values = (await serviceGet(harness, `/documents/${created!.id}/field-values`))[
      'values'
    ] as Record<string, unknown>;
    expect(values).toMatchObject({
      'tenant.name': 'Ada Lovelace',
      'lease.rent': '1200.50',
      'lease.start': '2027-01-01',
    });
    // The fields the service sets itself are empty.
    expect(values['tenant.signature'] ?? null).toBeNull();
    expect(values['tenant.signed'] ?? null).toBeNull();
  });

  it('refuses a value for a field the gallery does not offer, and creates nothing', async () => {
    const { harness, use } = await start();
    const t = harness.host.catalogue.listTemplates()[0]!;
    const before = harness.host.catalogue.listFor('u-olivia').length;
    // The form can only carry offered keys; a forged one for a signature is ignored by the action
    // (it reads only the offered fields), so a title alone creates a plain copy.
    const forged = await use({
      template: t.id,
      title: 'Forged',
      'value:tenant.signature': 'Olivia',
    });
    expect(forged.status).toBe(303);
    const doc = harness.host.catalogue.listFor('u-olivia').find((d) => d.title === 'Forged')!;
    const values = (await serviceGet(harness, `/documents/${doc.id}/field-values`))[
      'values'
    ] as Record<string, unknown>;
    expect(values['tenant.signature'] ?? null).toBeNull();
    expect(harness.host.catalogue.listFor('u-olivia').length).toBe(before + 1);
    // A value that does not fit its field is refused by the service and nothing is created.
    const bad = await use({ template: t.id, title: 'Bad date', 'value:lease.start': 'next week' });
    expect(bad.status).toBe(400);
    expect(bad.data?.problem).toMatch(/does not fit/);
    expect(harness.host.catalogue.listFor('u-olivia').some((d) => d.title === 'Bad date')).toBe(
      false,
    );
  });

  it('a template that is not in the catalogue is refused', async () => {
    const { use } = await start();
    const result = await use({ template: 'no-such-template', title: 'x' });
    expect(result.status).toBe(400);
    expect(result.data?.problem).toMatch(/Choose a template/);
  });

  it('prefillableFields reads the kinds from the service, not from a list in the page', async () => {
    const { harness } = await start();
    const t = harness.host.catalogue.listTemplates()[0]!;
    const fields = await prefillableFields(harness.host, t);
    expect(fields.map((f) => f.kind)).toEqual(['text', 'number', 'date']);
  });
});
