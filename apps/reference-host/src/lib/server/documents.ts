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
import type { Catalogue, CatalogueEntry } from './catalogue.ts';
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

export interface DocumentsSeed {
  templates: Template[];
  documents: SeedDocument[];
}

export async function loadDocumentsSeed(seedDir: string): Promise<DocumentsSeed> {
  return JSON.parse(await readFile(join(seedDir, 'documents.json'), 'utf8')) as DocumentsSeed;
}

export async function templateContent(seedDir: string, template: Template): Promise<CdmEnvelope> {
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
