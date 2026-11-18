/**
 * The templates of a tenant (12 §9; FRW-062; docs/adr/0406-w4-FRW-062-templates.md, proposed). A
 * template is a document marked as one: the record names the document and gives it a name.
 * `TemplateStore` is the port; `MemoryTemplateStore` keeps the records in a map (tests and the
 * memory composition) and `PgTemplateStore` (template-store-pg.ts) is the PostgreSQL one.
 */
export interface TemplateRecord {
  readonly id: string;
  /** The document that is the template. */
  readonly doc: string;
  readonly name: string;
  /** The surrogate of the person or service that marked the document. */
  readonly createdBy: string;
  readonly createdAtMs: number;
}

export interface TemplateStore {
  /** Stores the record; a document that is a template already is refused as `exists`. */
  create(tenant: string, record: TemplateRecord): Promise<'created' | 'exists'>;
  /** The templates of the tenant, oldest first. */
  list(tenant: string): Promise<readonly TemplateRecord[]>;
  get(tenant: string, id: string): Promise<TemplateRecord | null>;
}

export class MemoryTemplateStore implements TemplateStore {
  readonly #rows = new Map<string, TemplateRecord[]>();

  create(tenant: string, record: TemplateRecord): Promise<'created' | 'exists'> {
    const rows = this.#rows.get(tenant) ?? [];
    if (rows.some((r) => r.doc === record.doc || r.id === record.id))
      return Promise.resolve('exists');
    this.#rows.set(tenant, [...rows, record]);
    return Promise.resolve('created');
  }

  list(tenant: string): Promise<readonly TemplateRecord[]> {
    return Promise.resolve(
      [...(this.#rows.get(tenant) ?? [])].sort(
        (a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : 1),
      ),
    );
  }

  get(tenant: string, id: string): Promise<TemplateRecord | null> {
    return Promise.resolve((this.#rows.get(tenant) ?? []).find((r) => r.id === id) ?? null);
  }
}
