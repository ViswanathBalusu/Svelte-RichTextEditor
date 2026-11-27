/**
 * Stages the content of the documentation site (FND-013 criteria 1 and 2): copies the
 * specification, the decision records, the stories, the integration guide and the protocol
 * artifacts into one folder that VitePress builds, writes the pages that list them, and writes
 * the VitePress configuration and the data it reads.
 *
 * Nothing here edits a source file. The folder is rebuilt from scratch on every run.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Section {
  /** The folder in the staged site, and the path of the section's pages. */
  id: string;
  title: string;
  /** The source folder of Markdown files, relative to the repository root. */
  from: string;
  /** What the section's index page says. */
  intro: string;
  /** `list`: every page in the sidebar. `index`: the sidebar has the index only (a long list). */
  sidebar: 'list' | 'index';
}

export const SECTIONS: readonly Section[] = [
  {
    id: 'spec',
    title: 'Specification',
    from: 'docs/spec',
    intro: 'The specification, 00 to 13. Every figure in it is a target, not a measurement.',
    sidebar: 'list',
  },
  {
    id: 'adr',
    title: 'Decision records',
    from: 'docs/adr',
    intro: 'The decision records. Each one says what it decided and its status.',
    sidebar: 'index',
  },
  {
    id: 'stories',
    title: 'Stories',
    from: 'docs/stories',
    intro: 'The backlog. The README explains the format and the definition of done.',
    sidebar: 'list',
  },
];

export interface StageInput {
  repoRoot: string;
  /** Rebuilt on every run. */
  stageDir: string;
  version: string;
  /** Every release of the site, the one being built included. Newest first. */
  versions: readonly string[];
  latest: string | null;
  /** The URL path of the site root, with a trailing slash. `/` for a site at a host's root. */
  siteRoot: string;
  /** The folder of generated API documentation (HTML), or null for a site without it. */
  apiDir: string | null;
  /** The folder VitePress writes to. */
  outDir: string;
}

export interface PageInfo {
  /** The path of the page below the site root, with no extension: `spec/01-architecture`. */
  path: string;
  title: string;
  status: string | null;
}

/** The text of the first level-1 heading, or the file's name when there is none. */
export function titleOf(markdown: string, fallback: string): string {
  const m = /^#\s+(.+?)\s*#*\s*$/m.exec(markdown);
  return (m?.[1] ?? fallback).replaceAll('`', '').trim();
}

/** The first word of a decision record's `**Status:**` line, in lower case, or null. */
export function statusOf(markdown: string): string | null {
  const m = /^\*\*Status:\*\*\s*([A-Za-z]+)/m.exec(markdown);
  return m?.[1]?.toLowerCase() ?? null;
}

function mdFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith('.md'))
    .sort((a, b) => a.localeCompare(b));
}

function pagesOf(repoRoot: string, stageDir: string, section: Section): PageInfo[] {
  const from = join(repoRoot, section.from);
  if (!existsSync(from)) return [];
  const out = join(stageDir, section.id);
  mkdirSync(out, { recursive: true });
  return mdFiles(from).map((name) => {
    const text = readFileSync(join(from, name), 'utf8');
    writeFileSync(join(out, name), text);
    const base = name.slice(0, -3);
    return {
      path: `${section.id}/${base}`,
      title: titleOf(text, base),
      status: statusOf(text),
    };
  });
}

function indexPage(section: Section, pages: readonly PageInfo[]): string {
  const lines = [`# ${section.title}`, '', section.intro, ''];
  for (const p of pages) {
    const file = p.path.slice(section.id.length + 1);
    lines.push(
      `- [${p.title.replaceAll('|', '\\|')}](./${file}.md)${p.status ? ` (${p.status})` : ''}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** Every file below `dir`, as paths relative to it with forward slashes. */
export function filesBelow(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).replaceAll('\\', '/'));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

function artifactsPage(repoRoot: string, stageDir: string): { files: number } {
  const source = join(repoRoot, 'spec');
  const files = filesBelow(source);
  if (files.length === 0) return { files: 0 };
  cpSync(source, join(stageDir, 'public', 'artifacts'), { recursive: true });
  const lines = [
    '# Protocol artifacts',
    '',
    'The machine-readable artifacts of `spec/`: the document model, the protocol, the embedding API, the rules, the shortcuts and the other generated files. They are generated from the code and never edited by hand. Each link opens the file of this release.',
    '',
  ];
  let group = '';
  for (const file of files) {
    const top = file.includes('/') ? file.slice(0, file.indexOf('/')) : '.';
    if (top !== group) {
      group = top;
      lines.push('', `## ${top === '.' ? 'Top level' : top}`, '');
    }
    const bytes = statSync(join(source, file)).size;
    lines.push(`- [${file}](artifacts/${file}) (${bytes} bytes)`);
  }
  lines.push('');
  writeFileSync(join(stageDir, 'artifacts.md'), lines.join('\n'));
  return { files: files.length };
}

function apiPage(stageDir: string, apiDir: string | null): boolean {
  if (apiDir === null || !existsSync(join(apiDir, 'index.html'))) return false;
  cpSync(apiDir, join(stageDir, 'public', 'api'), { recursive: true });
  writeFileSync(
    join(stageDir, 'api.md'),
    [
      '# API reference',
      '',
      'Generated by TypeDoc from the source of every package, including the embedding API of `@docedit/element`. It is the reference for this release.',
      '',
      '[Open the API reference](api/index.html)',
      '',
    ].join('\n'),
  );
  return true;
}

function guidePage(repoRoot: string, stageDir: string): boolean {
  const source = join(repoRoot, 'apps', 'reference-host', 'docs', 'integration-guide.md');
  if (!existsSync(source)) return false;
  mkdirSync(join(stageDir, 'guide'), { recursive: true });
  cpSync(source, join(stageDir, 'guide', 'integration-guide.md'));
  return true;
}

function homePage(input: StageInput, sections: readonly string[]): string {
  return [
    '# Document editor',
    '',
    `Documentation for release ${input.version}. Every name in it (\`<doc-editor>\`, DEP, CDM, \`@docedit/*\`) is a working placeholder.`,
    '',
    ...sections,
    '',
  ].join('\n');
}

export interface Staged {
  pages: Record<string, PageInfo[]>;
  artifactFiles: number;
  hasApi: boolean;
  hasGuide: boolean;
}

/** Writes the whole staged site and returns what it holds. */
export function stageSite(input: StageInput): Staged {
  rmSync(input.stageDir, { recursive: true, force: true });
  mkdirSync(join(input.stageDir, '.vitepress'), { recursive: true });
  const pages: Record<string, PageInfo[]> = {};
  const sidebar: Record<string, unknown> = {};
  const home: string[] = [];
  for (const section of SECTIONS) {
    const list = pagesOf(input.repoRoot, input.stageDir, section);
    pages[section.id] = list;
    if (list.length === 0) continue;
    writeFileSync(join(input.stageDir, section.id, 'index.md'), indexPage(section, list));
    sidebar[`/${section.id}/`] = [
      {
        text: section.title,
        items: [
          { text: 'Contents', link: `/${section.id}/` },
          ...(section.sidebar === 'list'
            ? list.map((p) => ({ text: p.title, link: `/${p.path}` }))
            : []),
        ],
      },
    ];
    home.push(`- [${section.title}](${section.id}/): ${section.intro}`);
  }
  const hasGuide = guidePage(input.repoRoot, input.stageDir);
  if (hasGuide)
    home.push('- [Integration guide](guide/integration-guide.md): how a host embeds the editor.');
  const hasApi = apiPage(input.stageDir, input.apiDir);
  if (hasApi)
    home.push(
      '- [API reference](api.md): generated from the packages, the embedding API included.',
    );
  const { files: artifactFiles } = artifactsPage(input.repoRoot, input.stageDir);
  if (artifactFiles > 0)
    home.push('- [Protocol artifacts](artifacts.md): the machine-readable files of `spec/`.');
  writeFileSync(join(input.stageDir, 'index.md'), homePage(input, home));

  const nav = [
    ...SECTIONS.filter((s) => (pages[s.id] ?? []).length > 0).map((s) => ({
      text: s.title,
      link: `/${s.id}/`,
    })),
    ...(hasGuide ? [{ text: 'Guide', link: '/guide/integration-guide' }] : []),
    ...(hasApi ? [{ text: 'API', link: '/api' }] : []),
    ...(artifactFiles > 0 ? [{ text: 'Artifacts', link: '/artifacts' }] : []),
  ];
  const base = `${input.siteRoot}${input.version}/`;
  writeFileSync(
    join(input.stageDir, '.vitepress', 'site.json'),
    `${JSON.stringify(
      {
        version: input.version,
        latest: input.latest,
        versions: input.versions,
        base,
        siteRoot: input.siteRoot,
        outDir: input.outDir,
        nav,
        sidebar,
      },
      null,
      2,
    )}\n`,
  );
  cpSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'site', 'config.mts'),
    join(input.stageDir, '.vitepress', 'config.mts'),
  );
  return { pages, artifactFiles, hasApi, hasGuide };
}
