// The VitePress configuration of the documentation site (FND-013). `scripts/stage.ts` copies this
// file into the staged site and writes `site.json` beside it, so that one file serves every release.
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitepress';

interface Site {
  version: string;
  latest: string | null;
  versions: string[];
  base: string;
  outDir: string;
  nav: Array<{ text: string; link: string }>;
  sidebar: Record<string, unknown>;
}

const data = JSON.parse(readFileSync(new URL('./site.json', import.meta.url), 'utf8')) as Site;

// The other releases are folders next to this one. A link such as `/../1.0.0/` leaves this
// release's base, and the browser resolves it. The router of VitePress would try to load it as a
// page of this release, so a click on such a link is handed to the browser first.
const LEAVE_RELEASE = `document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href*="/../"]');if(a&&!a.target){e.preventDefault();e.stopImmediatePropagation();location.href=a.href;}},true);`;

export default defineConfig({
  lang: 'en-GB',
  title: 'Document editor',
  description: 'The specification, decisions, stories, API reference and integration guide.',
  base: data.base,
  outDir: data.outDir,
  cleanUrls: false,
  // The sources link to files of the repository that are not part of the site.
  ignoreDeadLinks: true,
  lastUpdated: false,
  head: [['script', {}, LEAVE_RELEASE]],
  markdown: {
    // The sources write tags such as <doc-editor> in running text. They are text, not HTML.
    html: false,
    config(md) {
      // Vue reads `{{ ... }}` in a page as an expression. The sources use it as text.
      const render = md.render.bind(md);
      md.render = (src, env) => render(src, env).replaceAll('{{', '&#123;&#123;');
    },
  },
  themeConfig: {
    nav: [
      ...data.nav,
      {
        text: `Release ${data.version}`,
        items: [
          ...(data.latest
            ? [{ text: `Latest (${data.latest})`, link: `/../${data.latest}/` }]
            : []),
          ...data.versions.map((v) => ({ text: v, link: `/../${v}/` })),
        ],
      },
    ],
    sidebar: data.sidebar as never,
    search: { provider: 'local' },
    outline: { level: [2, 3] },
  },
});
