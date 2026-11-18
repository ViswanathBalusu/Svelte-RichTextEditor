/**
 * What the host does with documents (13 §11.1 item 4; UX-094): create one through the service with
 * the host's `externalId`, keep its title and the people's roles in the host's catalogue, rename,
 * delete (a soft delete in both places), and change roles and region grants. Every call to the
 * service uses the host's service credential and names the acting person with `DEP-Actor`.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CdmEnvelope, DocRole, Restriction, RegionGrant } from '@docedit/protocol';
import type { Catalogue, CatalogueEntry, CatalogueTemplate } from './catalogue.ts';
import { ServiceError, type ServiceClient } from './service.ts';

export interface Template {
  key: string;
  title: string;
  /** A file next to documents.json with the CDM content (03). */
  content: string;
  /** Roles the template gives besides its creator, who becomes the owner. */
  roles: Record<string, DocRole>;
  /** Region grants applied after creation (07 §1). */
  grants: RegionGrant[];
}

export interface SeedDocument {
  externalId: string;
  template: string;
  title: string;
  creator: string;
}

/** A template of the gallery (UX-100): a document the host marks through `POST /templates`. */
export interface SeedServiceTemplate {
  key: string;
  name: string;
  description: string;
  /** A file next to documents.json with the CDM content of the template document (03). */
  content: string;
  creator: string;
}

export interface DocumentsSeed {
  templates: Template[];
  documents: SeedDocument[];
  /** Absent in seeds written before the gallery; read as none. */
  serviceTemplates?: SeedServiceTemplate[];
}

export async function loadDocumentsSeed(seedDir: string): Promise<DocumentsSeed> {
  return JSON.parse(await readFile(join(seedDir, 'documents.json'), 'utf8')) as DocumentsSeed;
}

export async function templateContent(seedDir: string, template: Template): Promise<CdmEnvelope> {
  return JSON.parse(await readFile(join(seedDir, template.content), 'utf8')) as CdmEnvelope;
}

/** The CDM content of a gallery template's document, from its seed file. */
export async function serviceTemplateContent(
  seedDir: string,
  template: SeedServiceTemplate,
): Promise<CdmEnvelope> {
  return JSON.parse(await readFile(join(seedDir, template.content), 'utf8')) as CdmEnvelope;
}

export interface HostDocuments {
  service: ServiceClient;
  catalogue: Catalogue;
  seedDir: string;
  now?: () => Date;
}

/** 05 §6.2: the title is metadata, at most 1,000 characters. */
export const MAX_TITLE = 1000;

export function cleanTitle(title: unknown): string {
  const t = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
  if (t === '') throw new RangeError('a title is needed');
  if (t.length > MAX_TITLE) throw new RangeError(`a title has at most ${MAX_TITLE} characters`);
  return t;
}

/**
 * Creates a document from a template (UX-094 criterion 2): the service creates it with the host's
 * `externalId` and the template's content, the template's region grants are stored, and the
 * catalogue records the title and the roles. Creating again with the same `externalId` finds the
 * existing document instead of making a second one, so seeding can be repeated.
 */
export async function createFromTemplate(
  h: HostDocuments,
  input: { template: Template; title: string; creator: string; externalId?: string },
): Promise<CatalogueEntry> {
  const now = (h.now ?? (() => new Date()))();
  const title = cleanTitle(input.title);
  const externalId = input.externalId ?? `refhost-${randomUUID()}`;
  const existing = await h.service.findByExternalId(externalId);
  const doc =
    existing ??
    (await h.service.createDocument(
      { content: await templateContent(h.seedDir, input.template), externalId, title },
      externalId,
      input.creator,
    ));
  if (input.template.grants.length > 0) {
    const { grants, etag } = await h.service.getGrants(doc.id);
    const missing = input.template.grants.filter(
      (g) => !grants.grants.some((x) => x.region === g.region && x.principal === g.principal),
    );
    if (missing.length > 0)
      await h.service.replaceGrants(doc.id, [...grants.grants, ...missing], etag, input.creator);
  }
  // A catalogue entry for another document with this externalId is stale (the service's data was
  // reset): the service's document wins.
  const known = h.catalogue.byExternalId(externalId);
  if (known && known.id === doc.id) return known;
  const roles: Record<string, DocRole> = { ...input.template.roles, [input.creator]: 'owner' };
  const entry: CatalogueEntry = {
    id: doc.id,
    externalId,
    title: doc.title ?? title,
    template: input.template.key,
    createdBy: input.creator,
    createdAt: now.toISOString(),
    roles,
    accessSince: Object.fromEntries(Object.keys(roles).map((sub) => [sub, now.toISOString()])),
    deletedAt: null,
  };
  await h.catalogue.put(entry);
  return entry;
}

/**
 * The kinds of field the service sets itself, so that no prefill may carry them (12 §9; the same
 * list as `SERVER_SET_FIELD_KINDS` of the model). The gallery never offers them, and a test checks
 * that the service refuses what the gallery leaves out.
 */
export const SERVER_SET_KINDS: readonly string[] = [
  'signature',
  'initials',
  'dateSigned',
  'formula',
];

/** A field of a template that the author may give a value when starting from it. */
export interface PrefillField {
  key: string;
  label: string;
  kind: 'text' | 'number' | 'date' | 'checkbox' | 'choice';
  /** The role placeholder the field belongs to, or null. */
  assignee: string | null;
}

/**
 * Registers a template of the gallery (UX-100): the document is created through the service, marked
 * with `POST /templates`, and the host's catalogue records what its gallery shows. Registering the
 * same `key` again finds the template instead of making a second one, so seeding can be repeated.
 */
export async function registerTemplate(
  h: HostDocuments,
  input: {
    key: string;
    name: string;
    description: string;
    content: CdmEnvelope;
    creator: string;
  },
): Promise<CatalogueTemplate> {
  const known = h.catalogue.templateByKey(input.key);
  if (known) return known;
  const now = (h.now ?? (() => new Date()))();
  const externalId = `refhost-template-${input.key}`;
  const doc =
    (await h.service.findByExternalId(externalId)) ??
    (await h.service.createDocument(
      { content: input.content, externalId, title: input.name },
      externalId,
      input.creator,
    ));
  // A document is the template of at most one row: when the host was reset but the service was
  // not, the row exists and is found by its document.
  const existing = (await h.service.listTemplates()).find((t) => t.document === doc.id);
  const template =
    existing ??
    (await h.service.createTemplate({ document: doc.id, name: input.name }, input.creator));
  const entry: CatalogueTemplate = {
    id: template.id,
    document: doc.id,
    key: input.key,
    name: input.name,
    description: input.description,
    createdBy: input.creator,
    createdAt: now.toISOString(),
  };
  await h.catalogue.putTemplate(entry);
  return entry;
}

/** Registers every template of the seed's gallery (UX-100); repeating it changes nothing. */
export async function registerSeedTemplates(
  h: HostDocuments,
  seed: DocumentsSeed,
): Promise<CatalogueTemplate[]> {
  const out: CatalogueTemplate[] = [];
  for (const t of seed.serviceTemplates ?? [])
    out.push(
      await registerTemplate(h, {
        key: t.key,
        name: t.name,
        description: t.description,
        content: await serviceTemplateContent(h.seedDir, t),
        creator: t.creator,
      }),
    );
  return out;
}

/** The fields of a template that may be prefilled: the kinds the author can set (12 §9). */
export async function prefillableFields(
  h: HostDocuments,
  template: CatalogueTemplate,
): Promise<PrefillField[]> {
  const fields = await h.service.listFields(template.document);
  return fields
    .filter((f) => !SERVER_SET_KINDS.includes(f.kind) && !f.readOnly)
    .map((f) => ({
      key: f.key,
      label: f.label,
      kind: f.kind as PrefillField['kind'],
      assignee: f.assignee,
    }));
}

/**
 * Starts a document from a template of the gallery (UX-100 criteria 2 and 3). The service forks
 * the template at a pinned `seq` and prefills the values in the same call (`POST /documents` with
 * `template`, 12 §9); the host then records the new document in its catalogue, with the person
 * who started it as its owner. A value for a key the gallery does not offer is refused here, and a
 * kind the service sets itself is refused by the service too.
 */
export async function createFromGalleryTemplate(
  h: HostDocuments,
  input: {
    template: CatalogueTemplate;
    title: string;
    creator: string;
    values?: Record<string, unknown>;
    externalId?: string;
  },
): Promise<CatalogueEntry> {
  const now = (h.now ?? (() => new Date()))();
  const title = cleanTitle(input.title);
  const values = input.values ?? {};
  const offered = new Set((await prefillableFields(h, input.template)).map((f) => f.key));
  for (const key of Object.keys(values))
    if (!offered.has(key))
      throw new RangeError(`the field "${key}" cannot be filled in at the start`);
  const externalId = input.externalId ?? `refhost-${randomUUID()}`;
  const doc = await h.service.createDocument(
    {
      template: input.template.id,
      title,
      externalId,
      ...(Object.keys(values).length > 0 ? { values } : {}),
    },
    externalId,
    input.creator,
  );
  const entry: CatalogueEntry = {
    id: doc.id,
    externalId,
    title: doc.title ?? title,
    template: input.template.key,
    ...(doc.template ? { templateSeq: doc.template.seq } : {}),
    createdBy: input.creator,
    createdAt: now.toISOString(),
    roles: { [input.creator]: 'owner' },
    accessSince: { [input.creator]: now.toISOString() },
    deletedAt: null,
  };
  await h.catalogue.put(entry);
  return entry;
}

/** Renames in the catalogue and in the service's metadata (UX-094 criterion 3). */
export async function renameDocument(
  h: HostDocuments,
  id: string,
  title: string,
  actor: string,
): Promise<CatalogueEntry> {
  const clean = cleanTitle(title);
  const { etag } = await h.service.getDocument(id);
  await h.service.updateDocument(id, { title: clean }, etag, actor);
  return h.catalogue.rename(id, clean);
}

/** A soft delete in the service and in the catalogue (UX-094 criterion 3; 05 §6.2). */
export async function deleteDocument(h: HostDocuments, id: string, actor: string): Promise<void> {
  try {
    await h.service.deleteDocument(id, actor);
  } catch (e) {
    // Already gone in the service: the catalogue follows.
    if (!(e instanceof ServiceError && e.code === 'not_found')) throw e;
  }
  await h.catalogue.remove(id, (h.now ?? (() => new Date()))());
}

/**
 * Changes a person's role in the host (UX-092 criterion 4). When a role is taken away or lowered,
 * the host revokes that person's sessions on the document (05 §3.3), so that they are cut off now
 * and not only when their token expires.
 */
export async function changeRole(
  h: HostDocuments,
  id: string,
  sub: string,
  role: DocRole | null,
): Promise<CatalogueEntry> {
  const before = h.catalogue.roleOf(id, sub);
  const entry = await h.catalogue.setRole(id, sub, role, (h.now ?? (() => new Date()))());
  if (before !== null && before !== role) await h.service.revoke(sub, id);
  return entry;
}

/** The output restrictions the share dialog may set (05 §3.1 `restrict`; 13 §5). */
export const RESTRICTION_NAMES: readonly Restriction[] = ['no-export', 'no-copy', 'no-print'];

/**
 * Sets the output restrictions of a person on a document (UX-095 criterion 5). They go into the
 * person's next token as `restrict`, so the change takes effect at the next token (at most 15
 * minutes later, or at once when the host revokes the sessions). Values outside the list are refused.
 */
export async function setRestrictions(
  h: HostDocuments,
  id: string,
  sub: string,
  restrict: readonly string[],
): Promise<CatalogueEntry> {
  const unique = [...new Set(restrict)];
  const bad = unique.filter((r) => !RESTRICTION_NAMES.includes(r as Restriction));
  if (bad.length > 0) throw new RangeError(`unknown restriction: ${bad.join(', ')}`);
  return h.catalogue.setRestrict(id, sub, unique as Restriction[]);
}

/** A change only the document's owner may make was asked for by someone else. */
export class OwnerOnlyError extends Error {
  constructor(message = 'Only the owner can do this.') {
    super(message);
    this.name = 'OwnerOnlyError';
  }
}

/**
 * The owner's action behind the share dialog's output restrictions (UX-095 criterion 5): `actor`
 * must own the document and `sub` must have a role on it. Then as `setRestrictions`.
 */
export async function setRestrictionsAs(
  h: HostDocuments,
  actor: string,
  id: string,
  sub: string,
  restrict: readonly string[],
): Promise<CatalogueEntry> {
  if (h.catalogue.roleOf(id, actor) !== 'owner') throw new OwnerOnlyError();
  if (h.catalogue.roleOf(id, sub) === null)
    throw new RangeError('this person has no role on the document');
  return setRestrictions(h, id, sub, restrict);
}

/**
 * Gives `principal` a role on a region, or takes their grant away with null (07 §1, §9). Grants
 * take effect at once: the service raises the grants revision, records a control commit and tells
 * the open channels (`perm.changed`).
 */
export async function setRegionGrant(
  h: HostDocuments,
  id: string,
  actor: string,
  change: { region: string; principal: string; role: RegionGrant['role'] | null },
): Promise<RegionGrant[]> {
  const { grants, etag } = await h.service.getGrants(id);
  const others = grants.grants.filter(
    (g) => !(g.region === change.region && g.principal === change.principal),
  );
  const next =
    change.role === null
      ? others
      : [...others, { region: change.region, principal: change.principal, role: change.role }];
  return (await h.service.replaceGrants(id, next, etag, actor)).grants;
}
