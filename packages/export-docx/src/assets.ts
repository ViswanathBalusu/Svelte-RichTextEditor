/**
 * Assets the importer creates: fragments of preserved content, pictures and fallback pictures.
 * Assets are immutable and content-addressed (06 §4.4): equal bytes get the same asset.
 *
 * A fragment (ADR 0017, part 3) is a small ZIP: `fragment.json` (metadata), `fragment.xml` (the
 * original element, byte for byte) and `parts/...` (the parts it relates to, copied raw from the
 * package, with their own relationship parts). Nothing in it is parsed beyond the package
 * structure, and external targets are kept as data (EXP-117).
 */
import { sha256HexBytes, utf8, uuid7 } from '@docedit/model';
import { decodeUtf8 } from './utf8.ts';
import {
  type ZipArchive,
  type ZipEntry,
  entryData,
  readZip,
  writeZip,
  type ZipWriteEntry,
} from './zip.ts';

/**
 * - `original`: the imported package itself (EXP-108).
 * - `source-map`: the source map as JSON (EXP-116).
 * - `fragment`: preserved content with the parts it relates to (EXP-117).
 * - `image`: a picture the document shows.
 */
export type AssetRole = 'fragment' | 'image' | 'fallback' | 'original' | 'source-map';

/**
 * Roles kept on the server (owner decision 1, default; second review SR-C1): they hold content a
 * reader with a partial view must not see, so the service serves them to nobody and uses them only
 * for lossless exports to requesters who see the whole document.
 */
export const SERVER_ONLY_ROLES: ReadonlySet<AssetRole> = new Set([
  'fragment',
  'original',
  'source-map',
]);

export const SOURCE_MAP_CONTENT_TYPE = 'application/vnd.docedit.docx-source-map+json';

export interface Asset {
  readonly id: string;
  /**
   * The asset's content. From an {@link AssetStore} this is a fresh copy on every read, so a caller
   * that changes it changes only its own copy, never the stored asset.
   */
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** The SHA-256 of `bytes`, in lower-case hexadecimal: the asset's content address. */
  readonly sha256: string;
  readonly role: AssetRole;
  /** True for the roles of {@link SERVER_ONLY_ROLES}. */
  readonly serverOnly: boolean;
}

/**
 * The importer's in-memory asset store (06 §4.4: assets are immutable and content-addressed).
 * Immutable here means that nothing outside the store can change a stored asset: `add` copies the
 * caller's bytes before hashing them, so changing the input buffer afterwards changes nothing;
 * the assets handed out are frozen; and their `bytes` is a new copy on each read. There is no
 * operation that replaces or removes an asset. The production object store is BE-003.
 */
export class AssetStore {
  /** The stored bytes, private to the store and never handed out. */
  readonly #content = new Map<string, Uint8Array>();
  /** The frozen view of each asset, whose `bytes` copies from {@link #content}. */
  readonly #assets = new Map<string, Asset>();
  readonly #byHash = new Map<string, string>();

  async add(bytes: Uint8Array, contentType: string, role: AssetRole): Promise<string> {
    // Copy first, and hash the copy: the digest is always the digest of the bytes kept. The copy is
    // made with the constructor, not `slice`, because a Node.js Buffer's `slice` is a view.
    const own = new Uint8Array(bytes);
    const sha256 = await sha256HexBytes(own);
    const known = this.#byHash.get(`${role}:${sha256}`);
    if (known) return known;
    const id = uuid7();
    this.#content.set(id, own);
    this.#assets.set(
      id,
      Object.freeze({
        id,
        get bytes(): Uint8Array {
          return new Uint8Array(own);
        },
        contentType,
        sha256,
        role,
        serverOnly: SERVER_ONLY_ROLES.has(role),
      }),
    );
    this.#byHash.set(`${role}:${sha256}`, id);
    return id;
  }

  get(id: string): Asset | undefined {
    return this.#assets.get(id);
  }

  ids(): Set<string> {
    return new Set(this.#assets.keys());
  }

  /** Every asset, in the order they were added. */
  all(): Asset[] {
    return [...this.#assets.values()];
  }

  /** The assets of one role. */
  ofRole(role: AssetRole): Asset[] {
    return this.all().filter((a) => a.role === role);
  }

  totalBytes(role?: AssetRole): number {
    let n = 0;
    for (const a of this.#assets.values())
      if (!role || a.role === role) n += this.#content.get(a.id)!.length;
    return n;
  }
}

export const FRAGMENT_CONTENT_TYPE = 'application/vnd.docedit.fragment+zip';

export interface FragmentRel {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

export interface FragmentMeta {
  v: 1;
  label: string;
  /**
   * `run`: the element is run content, and the writer puts it in a `w:r` whose properties come
   * from the atom's marks (inline atoms carry marks, CDM-051). `none`: the element is written as
   * it is (a hyperlink, a content control, a whole run whose properties the model cannot hold, a
   * block).
   */
  wrap: 'run' | 'none';
  /** The part the element came from. */
  part: string;
  /** Prefix bindings in scope at the element, so it can be re-parsed or moved to another part. */
  namespaces: Record<string, string>;
  /** Relationships of the source part that the element refers to. */
  rels: FragmentRel[];
  /** Parts copied into the fragment, under `parts/`. */
  parts: Array<{ name: string; contentType: string | null }>;
}

export function buildFragment(
  meta: FragmentMeta,
  xml: Uint8Array,
  zip: ZipArchive,
  parts: Array<{ entry: ZipEntry }>,
): Uint8Array {
  const entries: ZipWriteEntry[] = [
    { name: 'fragment.json', data: utf8(JSON.stringify(meta)) },
    { name: 'fragment.xml', data: xml },
    ...parts.map((p) => ({ name: `parts/${p.entry.name}`, copyOf: p.entry, from: zip })),
  ];
  return writeZip(entries);
}

export interface Fragment {
  meta: FragmentMeta;
  xml: string;
}

const fragmentCache = new WeakMap<Uint8Array, Fragment>();

export function readFragment(bytes: Uint8Array): Fragment {
  const cached = fragmentCache.get(bytes);
  if (cached) return cached;
  const zip = readZip(bytes);
  const metaEntry = zip.byName.get('fragment.json');
  const xmlEntry = zip.byName.get('fragment.xml');
  if (!metaEntry || !xmlEntry) throw new Error('not a fragment asset');
  const f: Fragment = {
    meta: JSON.parse(decodeUtf8(entryData(zip, metaEntry))) as FragmentMeta,
    xml: decodeUtf8(entryData(zip, xmlEntry)),
  };
  fragmentCache.set(bytes, f);
  return f;
}
