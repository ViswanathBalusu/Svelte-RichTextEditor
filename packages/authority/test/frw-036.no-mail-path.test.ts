// FRW-036 criterion 3 (part): the document service and the packages it runs hold no e-mail or
// text-message client, so no code path of theirs can send one. The scan covers every package
// manifest and every non-test source file under packages/, services/ and apps/. The other half of
// the criterion (the only outbound workflow traffic is webhook delivery through the egress proxy)
// is the service's and is not tested here.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Names of mail, SMS and voice clients and of their cloud APIs (matched case-insensitively). */
const FORBIDDEN =
  /nodemailer|smtp|sendgrid|mailgun|postmark|mailjet|sparkpost|sendmail|twilio|vonage|messagebird|plivo|client-ses|client-sns|aws-sdk\/client-ses/i;

/** Import, export-from, require and dynamic-import specifiers in a source file. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\(\s*)['"]([^'"]+)['"]/g;

/**
 * The reference host's own client for the development mail sink of its demo stack (UX-098; owner
 * decision 131): a host sends its own mail, which is the half of the criterion that the platform does
 * not. It is a module of the reference host, reached only by relative import, and it speaks to a
 * relay on the local machine. Nothing else may name one.
 */
const HOST_MAIL_CLIENTS = new Set(['apps/reference-host/src/lib/server/smtp.ts']);

const SOURCE_EXT = /\.(?:ts|tsx|js|mjs|cjs|mts|cts)$/;
const IS_TEST = /\.test\.[cm]?[jt]sx?$|[/\\]test[/\\]|[/\\]__tests__[/\\]/;

function sourceFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir, { recursive: true }).map(String);
  } catch {
    return [];
  }
  return names
    .map((n) => join(dir, n))
    .filter(
      (f) =>
        !f.includes('node_modules') &&
        SOURCE_EXT.test(f) &&
        !IS_TEST.test(relative(ROOT, f)) &&
        statSync(f).isFile(),
    );
}

/** The manifests and source files of every workspace package, service and app. */
function scanned(): { manifests: string[]; sources: string[] } {
  const manifests: string[] = [];
  const sources: string[] = [];
  for (const area of ['packages', 'services', 'apps']) {
    let dirs: string[];
    try {
      dirs = readdirSync(join(ROOT, area));
    } catch {
      continue;
    }
    for (const d of dirs) {
      const pkg = join(ROOT, area, d);
      const manifest = join(pkg, 'package.json');
      try {
        if (statSync(manifest).isFile()) manifests.push(manifest);
      } catch {
        // not a package
      }
      sources.push(...sourceFiles(join(pkg, 'src')));
    }
  }
  return { manifests, sources };
}

describe('no mail or SMS path in the workflow service (FRW-036 criterion 3)', () => {
  const { manifests, sources } = scanned();

  it('scans a real set of files, so the check cannot pass on an empty tree', () => {
    expect(manifests.length).toBeGreaterThanOrEqual(3);
    expect(sources.length).toBeGreaterThan(100);
  });

  it('declares no mail, SMS or voice client in any package manifest', () => {
    const hits: string[] = [];
    for (const file of manifests) {
      const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      for (const field of [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies',
      ]) {
        const deps = json[field];
        if (deps && typeof deps === 'object')
          for (const name of Object.keys(deps))
            if (FORBIDDEN.test(name)) hits.push(`${relative(ROOT, file)}: ${name}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('imports no mail, SMS or voice client in any non-test source file', () => {
    const hits: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(SPECIFIER)) {
        if (!FORBIDDEN.test(m[1]!)) continue;
        const target = m[1]!.startsWith('.') ? resolve(dirname(file), m[1]!) : null;
        if (target !== null && HOST_MAIL_CLIENTS.has(relative(ROOT, target).replaceAll('\\', '/')))
          continue;
        hits.push(`${relative(ROOT, file)}: ${m[1]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('would catch a planted import (the pattern is not vacuous)', () => {
    const planted = `import { send } from 'nodemailer';\nconst x = require('twilio');`;
    const found = [...planted.matchAll(SPECIFIER)].map((m) => m[1]);
    expect(found).toEqual(['nodemailer', 'twilio']);
    expect(found.every((s) => FORBIDDEN.test(s!))).toBe(true);
  });
});
