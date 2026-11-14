/**
 * The host's own document catalogue (13 §11.1 item 4; UX-094): titles, who has which role, and the
 * `externalId` the host set at creation, keyed by the document identifier. The document service
 * keeps the content and its history; the host keeps the list. The editor never lists documents.
 *
 * Demo only: one JSON file, written whole and atomically (a temporary file, then a rename), by one
 * process. A real host keeps this in its own database.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DocRole, Restriction } from '@docedit/protocol';

export interface CatalogueEntry {
  /** The document service's identifier. */
  id: string;
  /** The host's identifier for the document, set at creation (05 §6.2 `externalId`). */
  externalId: string;
  title: string;
  /** The template it was made from, if any. */
  template: string | null;
  createdBy: string;
  createdAt: string;
  /** The host's sharing decisions: the role of each user, which goes into the token's `docs`. */
  roles: Record<string, DocRole>;
  /** When each user was first given access (the optional `access_since` claim, 05 §3.1). */
  accessSince: Record<string, string>;
  /**
   * The output restrictions the owner set on each user (UX-095 criterion 5; the `restrict` claim of
   * 05 §3.1). Absent in catalogues written before the share dialog; read as none.
   */
  restrict?: Record<string, Restriction[]>;
  /** Set by a delete: the host keeps the row, as the service keeps the document (soft delete). */
  deletedAt: string | null;
}

interface CatalogueFile {
  version: 1;
  documents: CatalogueEntry[];
}

export class Catalogue {
  readonly #file: string;
  #documents: CatalogueEntry[];
  #writing: Promise<void> = Promise.resolve();

  private constructor(file: string, documents: CatalogueEntry[]) {
    this.#file = file;
    this.#documents = documents;
  }

  /** Opens the catalogue at `file`, or an empty one when the file does not exist yet. */
  static async open(file: string): Promise<Catalogue> {
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as CatalogueFile;
      if (raw.version !== 1 || !Array.isArray(raw.documents))
        throw new Error(`${file} is not a catalogue of version 1`);
      return new Catalogue(file, raw.documents);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new Catalogue(file, []);
      throw e;
    }
  }

  /** The documents `sub` has a role on, newest first, without deleted ones. */
  listFor(sub: string): CatalogueEntry[] {
    return this.#documents
      .filter((d) => d.deletedAt === null && d.roles[sub] !== undefined)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .map((d) => structuredClone(d));
  }

  /** A document that is not deleted, or null. */
  get(id: string): CatalogueEntry | null {
    const d = this.#documents.find((x) => x.id === id && x.deletedAt === null);
    return d ? structuredClone(d) : null;
  }

  byExternalId(externalId: string): CatalogueEntry | null {
    const d = this.#documents.find((x) => x.externalId === externalId);
    return d ? structuredClone(d) : null;
  }

  /** The role `sub` has on a live document, or null. */
  roleOf(id: string, sub: string): DocRole | null {
    return this.get(id)?.roles[sub] ?? null;
  }

  /** Adds an entry, replacing one with the same identifier or the same `externalId`. */
  async put(entry: CatalogueEntry): Promise<void> {
    this.#documents = [
      ...this.#documents.filter((d) => d.id !== entry.id && d.externalId !== entry.externalId),
      structuredClone(entry),
    ];
    await this.#save();
  }

  async rename(id: string, title: string): Promise<CatalogueEntry> {
    return this.#change(id, (d) => {
      d.title = title;
    });
  }

  /** Gives `sub` a role, or takes it away with null. */
  async setRole(id: string, sub: string, role: DocRole | null, now: Date): Promise<CatalogueEntry> {
    return this.#change(id, (d) => {
      if (role === null) {
        d.roles = Object.fromEntries(Object.entries(d.roles).filter(([k]) => k !== sub));
        return;
      }
      d.roles[sub] = role;
      d.accessSince[sub] ??= now.toISOString();
    });
  }

  /** Sets the output restrictions of `sub` on a live document; an empty list removes them all. */
  async setRestrict(
    id: string,
    sub: string,
    restrict: readonly Restriction[],
  ): Promise<CatalogueEntry> {
    return this.#change(id, (d) => {
      const others = Object.entries(d.restrict ?? {}).filter(([k]) => k !== sub);
      d.restrict = Object.fromEntries(
        restrict.length === 0 ? others : [...others, [sub, [...restrict]]],
      );
    });
  }

  async remove(id: string, now: Date): Promise<CatalogueEntry> {
    return this.#change(id, (d) => {
      d.deletedAt = now.toISOString();
    });
  }

  async #change(id: string, change: (d: CatalogueEntry) => void): Promise<CatalogueEntry> {
    const current = this.#documents.find((x) => x.id === id && x.deletedAt === null);
    if (!current) throw new Error(`no document ${id} in the catalogue`);
    const next = structuredClone(current);
    change(next);
    this.#documents = this.#documents.map((d) => (d === current ? next : d));
    await this.#save();
    return structuredClone(next);
  }

  /** Writes the whole file; writes run one after another, each with the state of its time. */
  #save(): Promise<void> {
    const body: CatalogueFile = { version: 1, documents: this.#documents };
    const text = `${JSON.stringify(body, null, 2)}\n`;
    const write = async () => {
      await mkdir(dirname(this.#file), { recursive: true });
      const temp = `${this.#file}.${randomUUID()}.tmp`;
      await writeFile(temp, text, 'utf8');
      await rename(temp, this.#file);
    };
    this.#writing = this.#writing.then(write, write);
    return this.#writing;
  }
}
