/**
 * EXP-099 criterion 1, for real: the Word importer runs in a single-use Podman sandbox with no
 * network and no credentials (image of scripts/build-import-image.ts). Needs Podman and the image
 * (`DOCEDIT_IMPORT_IMAGE` names it; the default is localhost/docedit-import-worker:dev); skips
 * otherwise. Three groups: the sandbox gives the import the in-process importer gives; hostile
 * files are refused inside it; and probes with `node` in the same image show the network closed,
 * no environment of the supervisor, and nothing outside the image readable or writable.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  entryData,
  importDocx,
  readZip,
  writeZip,
} from '../../../packages/export-docx/src/index.ts';
import { corpusFiles, readFile } from '../../../packages/export-docx/test/corpus.ts';
import {
  IMPORT_IMAGE,
  importSandboxReady,
  podmanImportSandbox,
  sandboxedDocxImporter,
} from '../src/docx-import.ts';
import { podmanSandbox } from '../src/sandbox-podman.ts';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const sample = (name: string): Uint8Array => readFile(corpusFiles().find((f) => f.name === name)!);

const ready = await importSandboxReady();

const importer = sandboxedDocxImporter(podmanImportSandbox({ limits: { wallSeconds: 120 } }));
const signal = new AbortController().signal;

/** The text of every text node, in document order. */
function textsOf(node: unknown, out: string[] = []): string[] {
  const n = node as { type?: string; text?: string; content?: unknown[]; doc?: unknown };
  if (n.type === 'text' && typeof n.text === 'string') out.push(n.text);
  for (const c of n.content ?? []) textsOf(c, out);
  if (n.doc) textsOf(n.doc, out);
  return out;
}

async function probe(script: string, flags: string[] = []): Promise<Record<string, unknown>> {
  const r = await podmanSandbox({
    image: IMPORT_IMAGE,
    entrypoint: 'node',
    command: [...flags, '--input-type=module', '-'],
    limits: { wallSeconds: 60 },
  }).run(enc(script));
  expect(r.engineError).toBeNull();
  return JSON.parse(new TextDecoder().decode(r.stdout).trim().split('\n').pop() ?? '{}');
}

const HEAD = `
import fs from 'node:fs';
const out = {};
const attempt = async (name, f) => { try { out[name] = await f(); } catch (e) { out[name] = 'error:' + (e.code ?? e.name); } };
`;
const TAIL = `\nprocess.stdout.write(JSON.stringify(out) + '\\n');\n`;

describe.skipIf(!ready)(`the Word importer in the Podman sandbox (${IMPORT_IMAGE})`, () => {
  it('gives the same import as the importer in this process, on a corpus file', async () => {
    for (const name of ['poi/sample.docx', 'poi/heading123.docx']) {
      const bytes = sample(name);
      const inside = await importer(bytes, { signal });
      const here = await importDocx(bytes);
      expect(textsOf(inside.envelope)).toEqual(textsOf(here.envelope));
      expect(inside.warnings).toEqual(here.warnings);
      expect((inside.envelope as { requires: string[] }).requires).toEqual(here.envelope.requires);
      expect(inside.preservation).toBeDefined();
    }
  });

  it('refuses hostile files inside the sandbox, with the importer message and no sandbox failure', async () => {
    // Not a package at all.
    await expect(importer(enc('this is not a zip file'), { signal })).rejects.toThrow(
      expect.objectContaining({ name: 'Error' }),
    );
    // A document type declaration in the main part.
    const zip = readZip(sample('poi/sample.docx'));
    const dtd = writeZip(
      zip.entries.map((e) => {
        const data = entryData(zip, e);
        if (e.name !== 'word/document.xml') return { name: e.name, data };
        const xml = new TextDecoder().decode(data);
        return {
          name: e.name,
          data: enc(xml.replace(/^(<\?xml[^>]*\?>)?/, (m) => `${m}<!DOCTYPE r [<!ENTITY a "b">]>`)),
        };
      }),
    );
    const refused = await importer(dtd, { signal }).then(
      () => null,
      (e: Error) => e,
    );
    expect(refused).not.toBeNull();
    expect(refused!.name).toBe('Error');
    expect(refused!.message.length).toBeGreaterThan(0);
  });

  it('has no network: no interface but loopback, no name resolution, no route out', async () => {
    const out = await probe(
      HEAD +
        `import os from 'node:os'; import net from 'node:net'; import dns from 'node:dns/promises';
out.interfaces = Object.keys(os.networkInterfaces()).sort();
await attempt('dns', async () => (await dns.lookup('example.org')).address);
const tcp = (host, port) => new Promise((r) => { const s = net.connect({ host, port, timeout: 3000 }); s.on('connect', () => { s.destroy(); r('connected'); }); s.on('error', (e) => r('error:' + e.code)); s.on('timeout', () => { s.destroy(); r('timeout'); }); });
out.internet = await tcp('1.1.1.1', 443);
await attempt('fetch', async () => (await fetch('http://example.org/')).status);` +
        TAIL,
    );
    expect(out['interfaces']).toEqual(['lo']);
    expect(String(out['dns'])).toMatch(/^error:/);
    expect(out['internet']).not.toBe('connected');
    expect(String(out['fetch'])).toMatch(/^error:/);
  });

  it('holds no credentials: the environment is the image and the heap size, nothing of the supervisor', async () => {
    const out = await probe(
      HEAD +
        `out.env = Object.keys(process.env).sort(); out.secrets = fs.readdirSync('/run/secrets');` +
        TAIL,
    );
    const env = out['env'] as string[];
    expect(
      env.filter(
        (k) => !/^(NODE_|YARN_VERSION$|PATH$|HOME$|LANG$|HOSTNAME$|container$|TERM$)/.test(k),
      ),
    ).toEqual([]);
    expect(out['secrets']).toEqual([]);
  });

  it('under the permission model of the entry point, reads only the image and writes nothing', async () => {
    const out = await probe(
      HEAD +
        `await attempt('passwd', () => fs.readFileSync('/etc/passwd', 'utf8').length);
await attempt('write', () => { fs.writeFileSync('/tmp/x', 'x'); return 'written'; });
await attempt('spawn', async () => (await import('node:child_process')).execSync('id').toString());` +
        TAIL,
      ['--permission', '--allow-fs-read=/opt/docedit/'],
    );
    expect(String(out['passwd'])).toMatch(/^error:/);
    expect(String(out['write'])).toMatch(/^error:/);
    expect(String(out['spawn'])).toMatch(/^error:/);
  });
});
