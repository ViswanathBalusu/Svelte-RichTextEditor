/**
 * Pinned base images whose tag has moved upstream (SEC-052; ADR 0044 §5). A digest pin never
 * changes by itself, so security fixes in a base image arrive only when someone moves the pin.
 * This lists every image pinned with both a tag and a digest (Containerfiles and compose files),
 * asks the registry for the tag's current manifest with skopeo (Apache-2.0; SKOPEO overrides the
 * command), and reports each pin whose tag now points elsewhere. It changes nothing.
 *
 * Usage: node scripts/supply-chain/base-drift.ts [--root <dir>]   (Markdown for the job summary)
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkFiles } from './bundle.ts';
import { composeServices, isContainerDefinition, parseContainerfile } from './pin-check.ts';

export interface Pin {
  file: string;
  line: number;
  /** Registry, repository and tag, without the digest. */
  tagged: string;
  digest: string;
}

const PINNED = /^(\S+:[\w][\w.-]*)@(sha256:[0-9a-f]{64})$/;

function pinOf(ref: string, file: string, line: number): Pin | null {
  const m = PINNED.exec(ref);
  if (!m || !m[1]!.split('/').at(-1)!.includes(':')) return null;
  return { file, line, tagged: m[1]!, digest: m[2]! };
}

const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'coverage',
  'test-results',
  'playwright-report',
  '.vitest',
]);

/** Every image pinned with a tag and a digest. */
export function pinnedImages(root: string): Pin[] {
  const pins: Pin[] = [];
  for (const abs of walkFiles(root, SKIP)) {
    const rel = relative(root, abs).split(sep).join('/');
    if (rel.startsWith('scripts/supply-chain/fixtures/')) continue;
    const name = basename(rel);
    if (isContainerDefinition(name)) {
      for (const ins of parseContainerfile(readFileSync(abs, 'utf8')).instructions) {
        if (ins.keyword !== 'FROM') continue;
        const ref = ins.args.split(/\s+/).find((w) => !w.startsWith('--'));
        const pin = ref ? pinOf(ref, rel, ins.line) : null;
        if (pin) pins.push(pin);
      }
    } else if (/^(?:podman-)?compose(?:\.[\w-]+)*\.(?:ya?ml|json)$/.test(name)) {
      for (const s of composeServices(readFileSync(abs, 'utf8'), name.endsWith('.json'))) {
        const pin = s.image ? pinOf(s.image, rel, s.line) : null;
        if (pin) pins.push(pin);
      }
    }
  }
  return pins;
}

/** The digest of a manifest as the registry serves it: SHA-256 of its exact bytes. */
export function manifestDigest(raw: Uint8Array): string {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

function main(argv: string[]): number {
  const i = argv.indexOf('--root');
  const root = resolve(
    i >= 0 ? argv[i + 1]! : join(fileURLToPath(new URL('.', import.meta.url)), '..', '..'),
  );
  const skopeo = process.env['SKOPEO'] || 'skopeo';
  const rows: string[] = [];
  let moved = 0;
  for (const p of pinnedImages(root)) {
    const r = spawnSync(skopeo, ['inspect', '--raw', `docker://${p.tagged}`], {
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.status !== 0) {
      rows.push(
        `| \`${p.file}:${p.line}\` | \`${p.tagged}\` | could not be read: ${String(r.stderr).trim().split('\n')[0]} |`,
      );
      console.log(
        `::warning file=${p.file},line=${p.line}::${p.tagged}: the registry could not be read`,
      );
      continue;
    }
    const current = manifestDigest(r.stdout);
    if (current === p.digest)
      rows.push(`| \`${p.file}:${p.line}\` | \`${p.tagged}\` | unchanged |`);
    else {
      moved++;
      rows.push(
        `| \`${p.file}:${p.line}\` | \`${p.tagged}\` | moved: pinned \`${p.digest}\`, now \`${current}\` |`,
      );
      console.log(
        `::warning file=${p.file},line=${p.line}::${p.tagged} now points to ${current}; review the new base and move the pin`,
      );
    }
  }
  console.log(
    [
      '## Pinned base images',
      '',
      '| Where | Image | Tag upstream |',
      '|---|---|---|',
      ...rows,
      '',
      `${moved} pin(s) behind their tag.`,
    ].join('\n'),
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
