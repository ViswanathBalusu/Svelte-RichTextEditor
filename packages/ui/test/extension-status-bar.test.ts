/**
 * Extension status-bar items are wired into the bar (UX-052 criterion 2, part). This is a source
 * check: it reads the status bar and the shell, and confirms that the bar reads the registry, puts
 * `start` items before the scope and `end` items after the notices, and gives each item its label
 * as a visually hidden text alternative. It does not render the bar: the rendered position and the
 * screen reader's announcement need a browser run, which was not made here, so criterion 2 stays
 * unticked.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const statusBar = read('../src/components/StatusBar.svelte');
const shell = read('../src/App.svelte');

describe('extension status-bar items (UX-052 criterion 2, wiring)', () => {
  it('the status bar takes the registry and reads its list by position', () => {
    expect(statusBar).toContain('statusItems?: StatusItemRegistry');
    expect(statusBar).toContain("statusItems.list().filter((item) => item.position === 'start')");
    expect(statusBar).toContain("statusItems.list().filter((item) => item.position === 'end')");
  });

  it('start items come before the scope, end items after the notices', () => {
    const start = statusBar.indexOf('{#each startItems as item');
    const scope = statusBar.indexOf('<span data-status="scope">');
    const notice = statusBar.indexOf('{#each endItems as item');
    const endOfBar = statusBar.lastIndexOf('</div>');
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(scope);
    expect(notice).toBeGreaterThan(statusBar.indexOf('data-status="notice"'));
    expect(notice).toBeLessThan(endOfBar);
  });

  it('each item shows its text and exposes its label as a visually hidden alternative', () => {
    expect(statusBar).toContain('data-status-item={item.id}');
    expect(statusBar).toContain('<span aria-hidden="true">{item.text}</span>');
    expect(statusBar).toContain('<span class="de-visually-hidden">{item.label}</span');
  });

  it('the shell passes the host registry to the status bar', () => {
    expect(shell).toContain(
      "import type { StatusItemRegistry } from './extensions/contributions.ts';",
    );
    expect(shell).toContain('statusItems?: StatusItemRegistry;');
    expect(shell).toContain('statusItems={props.statusItems}');
  });
});
