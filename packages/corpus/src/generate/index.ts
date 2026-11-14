/**
 * The corpus generator (FND-006). Universal code: it builds every document, image and the manifest
 * in memory, so the same bytes come out in Node.js and in a browser. `scripts/generate.ts` writes the
 * result to `out/`; `src/index.ts` uses the same builders to load a document by name.
 */
import {
  canonicalText,
  CANONICAL_FORM_VERSION,
  documentHash,
  jcsHash,
  sha256HexBytes,
  utf8,
  type JsonEnvelope,
} from '@docedit/model';
import { documentFeatures, documentStats, estimatePages, PAGE_ESTIMATE } from './analyse.ts';
import { RECIPES, type BuiltDocument, type DocumentRecipe } from './documents.ts';
import { corpusImages, IMAGE_LICENCE } from './images.ts';
import { formatJson } from './json.ts';
import type { CorpusManifest, ManifestAsset, ManifestDocument } from './manifest.ts';
import { MEASURED_PAGES } from './measured.ts';
import { RANDOM_ALGORITHM } from './random.ts';
import { CORPUS_LICENCE, SOURCES } from './sources.ts';
import { CORPUS_HISTORY, CURRENT } from './version.ts';

export { RECIPES } from './documents.ts';
export type { BuiltDocument, DocumentRecipe } from './documents.ts';
export { corpusImages } from './images.ts';
export { formatJson } from './json.ts';
export { CORPUS_HISTORY, CURRENT } from './version.ts';
export * from './analyse.ts';
export type * from './manifest.ts';

export interface GeneratedFile {
  /** Path relative to the package's `out/` directory, with forward slashes. */
  path: string;
  bytes: Uint8Array;
}

export interface GeneratedCorpus {
  manifest: CorpusManifest;
  /** The fingerprint of this output; equals CURRENT.fingerprint unless the output changed. */
  fingerprint: string;
  files: GeneratedFile[];
}

export function documentFileName(name: string): string {
  return `${name}.cdm.json`;
}

export function assetFileName(id: string): string {
  return `assets/${id}.png`;
}

export function recipe(name: string): DocumentRecipe {
  const r = RECIPES.find((x) => x.name === name);
  if (!r)
    throw new RangeError(
      `no corpus document "${name}"; the corpus has ${RECIPES.map((x) => x.name).join(', ')}`,
    );
  return r;
}

/** Builds one document in memory. */
export function buildDocument(name: string): BuiltDocument {
  return recipe(name).build();
}

function sourcesOf(features: readonly string[], assets: readonly string[]): string[] {
  const out = ['prose-en', 'written-en'];
  if (features.some((f) => f.startsWith('cjk.'))) out.push('written-cjk');
  if (features.some((f) => f.startsWith('math.'))) out.push('math');
  if (assets.length) out.push('images');
  return out;
}

async function describe(
  r: DocumentRecipe,
  built: BuiltDocument,
  fileText: string,
): Promise<ManifestDocument> {
  const env = built.envelope as unknown as JsonEnvelope;
  const stats = documentStats(env);
  const features = documentFeatures(env);
  const fileBytes = utf8(fileText);
  const measured = MEASURED_PAGES[r.name];
  return {
    name: r.name,
    file: documentFileName(r.name),
    inRepository: r.inRepository,
    description: r.description,
    requires: [...env.requires],
    pages: measured
      ? {
          target: r.targetPages,
          estimated: estimatePages(env),
          measured: measured.pages,
          measuredBy: measured.how,
          status: 'measured',
        }
      : {
          target: r.targetPages,
          estimated: estimatePages(env),
          measured: null,
          status: 'estimated',
        },
    documentHash: await documentHash(env),
    fileSha256: await sha256HexBytes(fileBytes),
    fileBytes: fileBytes.length,
    canonicalBytes: utf8(canonicalText(env)).length,
    nodes: stats.nodes,
    nodesByType: stats.nodesByType,
    characters: stats.text.characters,
    words: stats.text.words,
    cjkCharacters: stats.text.cjkCharacters,
    longestParagraph: stats.longestParagraph,
    features,
    assets: [...built.assets],
    sources: sourcesOf(features, built.assets),
  };
}

/** The manifest's fingerprint: its RFC 8785 hash without version, fingerprint and history. */
export function fingerprintOf(manifest: CorpusManifest): Promise<string> {
  const { version: _v, fingerprint: _f, history: _h, ...rest } = manifest;
  return jcsHash(rest);
}

/** Generates the whole corpus in memory. Two calls give byte-identical files. */
export async function generateCorpus(): Promise<GeneratedCorpus> {
  const files: GeneratedFile[] = [];
  const documents: ManifestDocument[] = [];
  for (const r of RECIPES) {
    const built = r.build();
    const fileText = formatJson(built.envelope);
    documents.push(await describe(r, built, fileText));
    files.push({ path: documentFileName(r.name), bytes: utf8(fileText) });
  }

  const assets: ManifestAsset[] = [];
  for (const image of corpusImages()) {
    files.push({ path: assetFileName(image.id), bytes: image.bytes });
    assets.push({
      id: image.id,
      file: assetFileName(image.id),
      mediaType: 'image/png',
      width: image.width,
      height: image.height,
      bytes: image.bytes.length,
      sha256: await sha256HexBytes(image.bytes),
      description: image.description,
      licence: IMAGE_LICENCE,
      source: 'images',
    });
  }

  const manifest: CorpusManifest = {
    corpus: 'docedit-corpus',
    version: CURRENT.version,
    fingerprint: '',
    history: [...CORPUS_HISTORY],
    generator: {
      command: 'pnpm --filter @docedit/corpus generate',
      random: RANDOM_ALGORITHM,
      note: 'Every document is built from its own seeded streams (seed text docedit-corpus/<name>/<stream>); nothing reads the clock or a platform random source.',
    },
    cdm: 1,
    canonicalFormVersion: CANONICAL_FORM_VERSION,
    licence: CORPUS_LICENCE,
    sources: [...SOURCES],
    pageEstimate: PAGE_ESTIMATE,
    documents,
    assets,
  };
  const fingerprint = await fingerprintOf(manifest);
  manifest.fingerprint = fingerprint;
  files.push({ path: 'manifest.json', bytes: utf8(formatJson(manifest)) });

  const ignored = RECIPES.filter((r) => !r.inRepository).map((r) => `/${documentFileName(r.name)}`);
  files.push({
    path: '.gitignore',
    bytes: utf8(
      `# Generated by scripts/generate.ts. These corpus documents are large, so they are generated on demand\n# (pnpm --filter @docedit/corpus generate) and not kept in the repository.\n${ignored.join('\n')}\n`,
    ),
  });
  return { manifest, fingerprint, files };
}
