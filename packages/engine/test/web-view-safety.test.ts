/**
 * What the web view writes into the page (FE-067 criteria 1 and 2; 03 §8 I9; 10 §3.1). The DOM is
 * built from DOM specifications, never from an HTML string, and a link is live only for an allowed
 * scheme and opens without a referrer or an opener. The CSSOM styles (criterion 4) and the fuzz run
 * under a strict policy (criterion 5) need a browser and are not tested here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { editingSchema } from '../src/schema.ts';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/** Every TypeScript source file under the engine's `src` (test helpers excepted). */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith('.ts') && name !== 'testing.ts') out.push(path);
  }
  return out;
}

/** The DOM specification the link mark renders for an `href`. */
function linkSpec(href: string): unknown[] {
  const schema = editingSchema();
  const mark = schema.marks['link']!.create({ href, title: null });
  return schema.marks['link']!.spec.toDOM!(mark, true) as unknown as unknown[];
}

describe('the web view builds its DOM without HTML strings (FE-067 criterion 1)', () => {
  it('assigns no HTML string to the DOM anywhere in the engine source', () => {
    // Non-vacuity: the scan reads the engine's own sources.
    expect(sources(SRC).length).toBeGreaterThan(20);
    const offenders: string[] = [];
    const pattern = /\.(?:inner|outer)HTML\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(/;
    for (const file of sources(SRC)) {
      if (pattern.test(readFileSync(file, 'utf8'))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe('a link is live only for an allowed scheme, and opens without a referrer (FE-067 criterion 2)', () => {
  it.each(['https://example.org/a?b=c', 'http://example.org', 'mailto:a@example.org', '#intro'])(
    'renders %s as a live link with noopener and noreferrer',
    (href) => {
      const [tag, attrs] = linkSpec(href) as [string, Record<string, string>];
      expect(tag).toBe('a');
      expect(attrs['href']).toBe(href);
      expect(attrs['rel']).toBe('noopener noreferrer');
    },
  );

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
  ])('renders %s without an href, so it is not clickable', (href) => {
    const [tag, attrs] = linkSpec(href) as [string, Record<string, string>];
    expect(tag).toBe('a');
    expect(attrs).not.toHaveProperty('href');
    expect(attrs['rel']).toBe('noopener noreferrer');
  });
});
