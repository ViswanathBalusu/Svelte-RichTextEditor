/**
 * What a built bundle contains (SEC-051, SEC-054; ADR 0044 §3). Every file of the build output is
 * attributed to the packages it came from:
 *
 * - generated code through its source map: each source is resolved to the nearest package.json;
 * - any other file by identity: it equals, byte for byte, a file of a package the bundle uses or
 *   of the distributable's own dependencies (fonts, WebAssembly, data files, copied workers);
 * - files the bundler wrote from the distributable's own sources without a map (an HTML page, its
 *   stylesheet) by name, to the distributable's own package.
 *
 * A file that none of these explains is reported, so the bill of materials can be compared with
 * what really ships.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { decodeMappings, loadSourceMap, sourceAt, type Segment } from './source-map.ts';

export interface BundleFile {
  /** Relative to the bundle root, with forward slashes. */
  path: string;
  size: number;
  sha1: string;
  sha256: string;
}

export interface PackageInfo {
  /** `name@version`. */
  key: string;
  name: string;
  version: string;
  /** Absolute directory holding the package's package.json. */
  dir: string;
  /** True for a package of this workspace, false for one installed under node_modules. */
  workspace: boolean;
  /** The `license` field of its package.json, as written. */
  licence: string | undefined;
}

export type AttributionMethod = 'source-map' | 'identical-file' | 'own-name' | 'import-stub';

export interface FileAttribution {
  file: string;
  method: AttributionMethod;
  packages: string[];
  /** For an identical file: the package file it equals, relative to that package. */
  equals?: string;
}

export interface MappedFile {
  lines: Segment[][];
  /** The package key of each source of the map, or null when a source has none. */
  sourcePackages: (string | null)[];
}

export interface BundleContents {
  root: string;
  files: BundleFile[];
  packages: Map<string, PackageInfo>;
  attributions: FileAttribution[];
  unattributed: string[];
  problems: string[];
  maps: Map<string, MappedFile>;
}

export interface AnalyseOptions {
  /** The package directory of the distributable itself. */
  ownPackageDir: string;
  /** Build output that is not part of the artefact (for example a size report). */
  exclude?: (path: string) => boolean;
  /** Further package directories to search for identical files. */
  candidateDirs?: readonly string[];
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'coverage',
  'test-results',
  'playwright-report',
  '.vitest',
]);

const toPosix = (p: string) => p.split(sep).join('/');

export function walkFiles(dir: string, skip: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!skip.has(e.name)) visit(join(d, e.name));
      } else if (e.isFile()) out.push(join(d, e.name));
    }
  };
  visit(dir);
  return out.sort();
}

export function hashFile(file: string): { size: number; sha1: string; sha256: string } {
  const data = readFileSync(file);
  return {
    size: data.length,
    sha1: createHash('sha1').update(data).digest('hex'),
    sha256: createHash('sha256').update(data).digest('hex'),
  };
}

/** Finds the package a file belongs to: the nearest package.json with a name and a version. */
export class PackageResolver {
  private readonly cache = new Map<string, PackageInfo | null>();

  packageOf(path: string): PackageInfo | null {
    let dir = dirname(resolve(path));
    const visited: string[] = [];
    for (;;) {
      const cached = this.cache.get(dir);
      if (cached !== undefined) {
        for (const v of visited) this.cache.set(v, cached);
        return cached;
      }
      visited.push(dir);
      const file = join(dir, 'package.json');
      if (existsSync(file)) {
        const pkg = JSON.parse(readFileSync(file, 'utf8')) as {
          name?: string;
          version?: string;
          license?: string | { type?: string };
        };
        if (pkg.name && pkg.version) {
          const real = realpathSync(dir);
          const info: PackageInfo = {
            key: `${pkg.name}@${pkg.version}`,
            name: pkg.name,
            version: pkg.version,
            dir: real,
            workspace: !toPosix(real).includes('/node_modules/'),
            licence: typeof pkg.license === 'string' ? pkg.license : pkg.license?.type,
          };
          for (const v of visited) this.cache.set(v, info);
          return info;
        }
      }
      const parent = dirname(dir);
      if (parent === dir || basename(dir) === 'node_modules') {
        for (const v of visited) this.cache.set(v, null);
        return null;
      }
      dir = parent;
    }
  }

  /** The installed directory of a dependency as seen from a package directory. */
  dependencyDir(fromDir: string, name: string): string | null {
    let dir = resolve(fromDir);
    for (;;) {
      const candidate = join(dir, 'node_modules', ...name.split('/'));
      if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

/** Index of package files by size and hash, built only for the sizes asked for. */
class IdenticalFiles {
  private readonly bySize = new Map<number, Array<{ file: string; dir: string }>>();
  private readonly hashes = new Map<string, string>();
  private readonly indexed = new Set<string>();

  add(dir: string): void {
    if (this.indexed.has(dir) || !existsSync(dir)) return;
    this.indexed.add(dir);
    for (const file of walkFiles(dir, SKIP_DIRS)) {
      const size = statSync(file).size;
      const list = this.bySize.get(size) ?? [];
      list.push({ file, dir });
      this.bySize.set(size, list);
    }
  }

  find(size: number, sha256: string): Array<{ file: string; dir: string }> {
    return (this.bySize.get(size) ?? []).filter(({ file }) => {
      let h = this.hashes.get(file);
      if (!h) {
        h = hashFile(file).sha256;
        this.hashes.set(file, h);
      }
      return h === sha256;
    });
  }
}

const VITE_HASH = /^(.*)-[A-Za-z0-9_-]{8}(\.[^.]+)$/;
const CODE = new Set(['.js', '.mjs', '.cjs', '.css']);

/** One statement of an import stub: a bare import, or a re-export, of a relative file. */
const STUB_STATEMENT =
  /^(?:import\s+(?:[\w*\s{},$]+\s+from\s+)?|export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+)(["'])\.{1,2}\/[^"']+\1\s*;?$/;

/** Whether a script is nothing but static imports and re-exports of relative files (and comments). */
export function isImportStub(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('//'));
  return lines.length > 0 && lines.every((l) => STUB_STATEMENT.test(l));
}

export function analyseBundle(root: string, options: AnalyseOptions): BundleContents {
  const resolver = new PackageResolver();
  const own = resolver.packageOf(join(options.ownPackageDir, 'package.json'));
  if (!own) throw new Error(`${options.ownPackageDir}: no package.json with a name and a version`);
  const contents: BundleContents = {
    root,
    files: [],
    packages: new Map(),
    attributions: [],
    unattributed: [],
    problems: [],
    maps: new Map(),
  };
  const all = walkFiles(root).map((f) => ({ abs: f, rel: toPosix(relative(root, f)) }));
  const files = all.filter((f) => !options.exclude?.(f.rel));
  const remember = (p: PackageInfo) => contents.packages.set(p.key, p);
  const pending: Array<{ abs: string; rel: string } & BundleFile> = [];
  const mapAttribution = new Map<string, string[]>();

  for (const f of files) {
    const h = hashFile(f.abs);
    const file: BundleFile = { path: f.rel, ...h };
    contents.files.push(file);
    if (f.rel.endsWith('.map')) continue;
    const ext = extname(f.rel);
    if (CODE.has(ext)) {
      const loaded = loadSourceMap(f.abs, readFileSync(f.abs, 'utf8'));
      if (loaded) {
        const keys = new Set<string>();
        const sourcePackages = loaded.map.sources.map((source, i) => {
          if (source.startsWith('\u0000')) {
            contents.problems.push(
              `${f.rel}: source "${source.slice(1)}" is a bundler module that belongs to no package`,
            );
            return null;
          }
          const pkg = resolver.packageOf(loaded.paths[i]!);
          if (!pkg) {
            contents.problems.push(`${f.rel}: source ${source} belongs to no package`);
            return null;
          }
          remember(pkg);
          keys.add(pkg.key);
          return pkg.key;
        });
        contents.maps.set(f.rel, { lines: decodeMappings(loaded.map.mappings), sourcePackages });
        const list = [...keys].sort();
        contents.attributions.push({ file: f.rel, method: 'source-map', packages: list });
        if (loaded.file) mapAttribution.set(toPosix(relative(root, loaded.file)), list);
        continue;
      }
    }
    pending.push({ ...f, ...file });
  }

  for (const f of contents.files)
    if (f.path.endsWith('.map')) {
      const packages = mapAttribution.get(f.path);
      if (packages) contents.attributions.push({ file: f.path, method: 'source-map', packages });
      else pending.push({ abs: join(root, f.path), rel: f.path, ...f });
    }

  // Identical files: the packages already found, the distributable's own dependencies and itself.
  const index = new IdenticalFiles();
  const ownManifest = JSON.parse(
    readFileSync(join(options.ownPackageDir, 'package.json'), 'utf8'),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const dirs = new Set<string>([...contents.packages.values()].map((p) => p.dir));
  for (const name of Object.keys({ ...ownManifest.dependencies, ...ownManifest.devDependencies })) {
    const d = resolver.dependencyDir(options.ownPackageDir, name);
    if (d) dirs.add(d);
  }
  for (const d of options.candidateDirs ?? []) dirs.add(resolve(d));
  dirs.add(own.dir);
  for (const d of [...dirs].sort()) index.add(d);
  const mapped = new Set([...contents.packages.keys()]);

  const ownFiles = walkFiles(own.dir, SKIP_DIRS).map((f) => basename(f));
  for (const f of pending) {
    const matches = index
      .find(f.size, f.sha256)
      .map((m) => ({ ...m, pkg: resolver.packageOf(m.file) }))
      .filter((m): m is typeof m & { pkg: PackageInfo } => m.pkg !== null);
    if (matches.length) {
      const preferred = matches.filter((m) => mapped.has(m.pkg.key));
      const chosen = (preferred.length ? preferred : matches).sort((a, b) =>
        a.file < b.file ? -1 : 1,
      );
      for (const m of chosen) remember(m.pkg);
      contents.attributions.push({
        file: f.rel,
        method: 'identical-file',
        packages: [...new Set(chosen.map((m) => m.pkg.key))].sort(),
        equals: toPosix(relative(chosen[0]!.pkg.dir, chosen[0]!.file)),
      });
      continue;
    }
    const name = basename(f.rel);
    const hashed = VITE_HASH.exec(name);
    const plain = hashed ? `${hashed[1]}${hashed[2]}` : name;
    const stem = plain.slice(0, plain.length - extname(plain).length);
    const byName =
      ownFiles.includes(plain) ||
      (['.css', '.html'].includes(extname(plain)) &&
        ownFiles.some((o) => o.slice(0, o.length - extname(o).length) === stem));
    if (byName) {
      remember(own);
      contents.attributions.push({ file: f.rel, method: 'own-name', packages: [own.key] });
      continue;
    }
    // A script of nothing but static imports and re-exports of sibling files, which the bundler writes
    // for an entry whose code sits in a shared chunk. It holds no code of its own, so it is the
    // distributable's: the code it pulls in is attributed through its own file.
    if (CODE.has(extname(name)) && isImportStub(readFileSync(f.abs, 'utf8'))) {
      remember(own);
      contents.attributions.push({ file: f.rel, method: 'import-stub', packages: [own.key] });
      continue;
    }
    contents.unattributed.push(f.rel);
  }
  contents.attributions.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  contents.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return contents;
}

/** The packages a generated position comes from, through the file's source map. */
export function packageAt(
  contents: BundleContents,
  file: string,
  line: number,
  column: number,
): string | null {
  const mapped = contents.maps.get(file);
  if (mapped) {
    const source = sourceAt(mapped.lines, line, column);
    return source === null ? null : (mapped.sourcePackages[source] ?? null);
  }
  const whole = contents.attributions.find((a) => a.file === file);
  return whole?.packages.length === 1 ? whole.packages[0]! : null;
}
