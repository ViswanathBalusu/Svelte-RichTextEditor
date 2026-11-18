/**
 * What a release ships (FND-012; ADR 0044 §1): the element bundle as an npm package, and each
 * service with its container image. A distributable whose package does not exist yet is reported
 * as missing; a service image is built when its Containerfile exists.
 *
 * Usage: node scripts/release/distributables.ts images   (JSON for the release workflow's matrix)
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Distributable {
  id: string;
  packageName: string;
  dir: string;
  kind: 'bundle' | 'service';
  /** Bundle: the build output that is published, relative to the repository. */
  output?: string;
  /** Bundle: build output that is not published (reports). */
  exclude?: string[];
  /** Service: its image definition and build context, relative to the repository. */
  containerfile?: string;
  /** Null while the Containerfile does not exist: its author sets it with the file. */
  context?: string | null;
  /**
   * Service: the build context is staged by a function of the service's own build script, which
   * returns the staged directory with its own copy of the Containerfile (used instead of context).
   */
  stage?: { module: string; export: string };
  /** Service: the image's repository name. */
  image?: string;
  /** Service: the image carries TeX Live and fonts, listed from inside the image. */
  texlive?: boolean;
  /**
   * Service: the image runs the service's own Node.js code, so its npm packages must equal the
   * service's bill. False for a sandbox image whose code runs elsewhere (the export worker's).
   */
  serviceInImage?: boolean;
  /**
   * Service: the build context already writes NOTICE and THIRD-PARTY-NOTICES.md into the image
   * (the asset worker's does), so the release adds no notices layer (scripts/release/image-notices.ts).
   */
  noticesInContext?: boolean;
}

export const DISTRIBUTABLES: readonly Distributable[] = [
  {
    id: 'element',
    packageName: '@docedit/element',
    dir: 'packages/element',
    kind: 'bundle',
    output: 'packages/element/dist/lib',
    exclude: ['bundle-report.json'],
  },
  {
    id: 'document-service',
    packageName: '@docedit/document-service',
    dir: 'services/document-service',
    kind: 'service',
    containerfile: 'services/document-service/Containerfile',
    context: null,
    image: 'docedit-document-service',
    serviceInImage: true,
  },
  {
    id: 'export-worker',
    packageName: '@docedit/export-worker',
    dir: 'services/export-worker',
    kind: 'service',
    containerfile: 'services/export-worker/Containerfile',
    context: 'services/export-worker/image',
    image: 'docedit-export-worker',
    texlive: true,
  },
  {
    id: 'asset-worker',
    packageName: '@docedit/asset-worker',
    dir: 'services/asset-worker',
    kind: 'service',
    containerfile: 'services/asset-worker/Containerfile',
    context: null,
    // Only the sandbox and its three decoders go into the context (BE-043; ADR 0043).
    stage: { module: 'services/asset-worker/scripts/build-image.ts', export: 'stageContext' },
    image: 'docedit-asset-worker',
    noticesInContext: true,
  },
];

export interface Presence {
  present: Distributable[];
  /** Images that can be built: the Containerfile exists and has a context or a staging function. */
  images: Array<Distributable & { containerfile: string; context: string | null; image: string }>;
  missing: string[];
}

export function presence(root: string, list: readonly Distributable[] = DISTRIBUTABLES): Presence {
  const out: Presence = { present: [], images: [], missing: [] };
  for (const d of list) {
    if (!existsSync(join(root, d.dir, 'package.json'))) {
      out.missing.push(`${d.id}: ${d.dir} does not exist yet`);
      continue;
    }
    out.present.push(d);
    if (d.kind !== 'service' || !d.containerfile || !d.image) continue;
    if (!existsSync(join(root, d.containerfile)))
      out.missing.push(`${d.id} image: ${d.containerfile} does not exist yet`);
    else if (!d.context && !d.stage)
      out.missing.push(
        `${d.id} image: ${d.containerfile} exists, but its build context is not set in scripts/release/distributables.ts`,
      );
    else
      out.images.push({
        ...d,
        containerfile: d.containerfile,
        context: d.context ?? null,
        image: d.image,
      });
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
  if (process.argv[2] === 'images') {
    const p = presence(root);
    const matrix = p.images.map((i) => ({
      id: i.id,
      containerfile: i.containerfile,
      context: i.context ?? `staged by ${i.stage!.module}`,
      image: i.image,
      texlive: i.texlive === true,
      serviceInImage: i.serviceInImage === true,
    }));
    console.log(JSON.stringify(matrix));
    for (const m of p.missing) console.error(`not built: ${m}`);
  } else {
    console.error('usage: node scripts/release/distributables.ts images');
    process.exitCode = 2;
  }
}
