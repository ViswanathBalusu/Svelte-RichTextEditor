/**
 * Assets attached to documents (BE-044; 06 §4.1 `doc_assets`, §4.4; 03 §8 I4). A document may
 * reference only assets that were uploaded for it, so nobody reads another document's image by
 * guessing its identifier.
 *
 * The room checks the result of every commit against the set of assets the document may
 * reference (the invariant I4 of the model: `asset_not_attached` is refused as `invalid_op`). That
 * set is, for one submitter, the assets already attached to the document plus the ready assets
 * that this user uploaded for this document. An asset of another tenant, of another document, or
 * uploaded by someone else is in neither, so the commit that references it is refused.
 *
 * The first commit that references an asset attaches it: one `doc_assets` row with that commit's
 * `seq` as `first_seq`, written in the transaction that stores the commit (`AppendOptions.attachments`).
 * A row is never removed (BE-044 criterion 5), so earlier versions still render.
 */
import { CDM1 } from '@docedit/model/definition';
import type { AssetRecord } from '../control-plane/assets.ts';
import { isUuid } from '../storage/ids.ts';
import type { DocRef, LogStore } from '../storage/types.ts';

/** The assets a document may reference (BE-044). Absent from a composition: references are not checked. */
export interface AssetAttachments {
  /** The assets attached to the document so far, each with the `seq` of the commit that first referenced it. */
  attached(ref: DocRef): Promise<ReadonlyMap<string, number>>;
  /**
   * Of `candidates`, the assets that are ready, were uploaded for this document of this tenant, and
   * were uploaded by `user` (a surrogate), or by anyone when `user` is null (a snapshot the control
   * plane authored for a caller it authorised). Anything else is left out.
   */
  uploadedBy(
    ref: DocRef,
    user: string | null,
    candidates: readonly string[],
  ): Promise<ReadonlySet<string>>;
}

/** The asset attributes by node type, from the CDM definition (I4). */
const ASSET_ATTRIBUTES: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const out = new Map<string, Set<string>>();
  for (const n of CDM1.nodes)
    for (const [name, a] of Object.entries(n.attrs))
      if (a.grammar.kind === 'ref' && a.grammar.to === 'asset') {
        let s = out.get(n.name);
        if (!s) out.set(n.name, (s = new Set()));
        s.add(name);
      }
  return out;
})();

const ASSET_ATTRIBUTE_NAMES: ReadonlySet<string> = new Set(
  [...ASSET_ATTRIBUTES.values()].flatMap((s) => [...s]),
);

/** The asset a signature or initials value names, or undefined (`{ asset, mode }`, 12 §3.3). */
function signatureAsset(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const asset = (value as { asset?: unknown }).asset;
  return typeof asset === 'string' ? asset : undefined;
}

/**
 * The asset identifiers named in a piece of JSON: a document, a step, a slice. A node of a type
 * with an asset attribute names its value; a step that sets an attribute with an asset attribute's
 * name names its value. The value of a signature or initials field is `{ asset, mode }` (12 §3.3):
 * a form field whose `value` has an `asset`, and a step that sets `value` to such an object, name
 * that asset too, so that a signing commit attaches the image (FRW-046). The result can hold more than the commit references (a value that is not an
 * asset): the caller keeps only identifiers it knows.
 */
export function assetRefsIn(json: unknown): Set<string> {
  const out = new Set<string>();
  const stack: unknown[] = [json];
  while (stack.length) {
    const v = stack.pop();
    if (Array.isArray(v)) {
      stack.push(...v);
      continue;
    }
    if (!v || typeof v !== 'object') continue;
    const n = v as {
      type?: unknown;
      attrs?: unknown;
      attr?: unknown;
      value?: unknown;
      [k: string]: unknown;
    };
    const names = typeof n.type === 'string' ? ASSET_ATTRIBUTES.get(n.type) : undefined;
    if (names && n.attrs && typeof n.attrs === 'object')
      for (const name of names) {
        const x = (n.attrs as Record<string, unknown>)[name];
        if (typeof x === 'string') out.add(x);
      }
    if (
      typeof n.attr === 'string' &&
      ASSET_ATTRIBUTE_NAMES.has(n.attr) &&
      typeof n.value === 'string'
    )
      out.add(n.value);
    if (n.type === 'form_field' && n.attrs && typeof n.attrs === 'object') {
      const a = signatureAsset((n.attrs as Record<string, unknown>)['value']);
      if (a !== undefined) out.add(a);
    }
    if (n.attr === 'value') {
      const a = signatureAsset(n.value);
      if (a !== undefined) out.add(a);
    }
    for (const x of Object.values(n)) if (x && typeof x === 'object') stack.push(x);
  }
  return out;
}

/** The registry and the log of a service as `AssetAttachments`. */
export class RegistryAssetAttachments implements AssetAttachments {
  readonly #logs: Pick<LogStore, 'attachedAssets'>;
  readonly #registry: { many(tenant: string, ids: readonly string[]): Promise<AssetRecord[]> };

  constructor(
    logs: Pick<LogStore, 'attachedAssets'>,
    registry: { many(tenant: string, ids: readonly string[]): Promise<AssetRecord[]> },
  ) {
    this.#logs = logs;
    this.#registry = registry;
  }

  async attached(ref: DocRef): Promise<ReadonlyMap<string, number>> {
    return (await this.#logs.attachedAssets?.(ref)) ?? new Map();
  }

  async uploadedBy(
    ref: DocRef,
    user: string | null,
    candidates: readonly string[],
  ): Promise<ReadonlySet<string>> {
    // A value that is not an identifier is no asset; the registry is not asked about it.
    const ids = candidates.filter((c) => isUuid(c));
    if (ids.length === 0) return new Set();
    // The registry reads under the tenant, so an asset of another tenant is not found.
    const rows = await this.#registry.many(ref.tenant, ids);
    return new Set(
      rows
        .filter(
          (a) =>
            a.tenant === ref.tenant &&
            a.doc === ref.doc &&
            (user === null || a.createdBy === user) &&
            a.state === 'ready',
        )
        .map((a) => a.id),
    );
  }
}
