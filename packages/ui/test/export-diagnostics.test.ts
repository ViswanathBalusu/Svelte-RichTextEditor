/**
 * The export dialog's words and announcements (UX-101 criteria 4 and 6; UX-104 criterion 4).
 * Severities are words, the job states have labels, a finished, failed or cancelled job is
 * announced in the shell's live region, and a projected export says that hidden parts are left
 * out. The dialog's rendering is checked in its source, since no component test harness runs here;
 * a browser run of the live region and of the diagnostic jump is not done (see the story Notes).
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EN_GB } from '../src/i18n/en-GB.ts';
import { Strings } from '../src/i18n/strings.ts';
import { read } from './support/source-checks.ts';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dialog = read(join(pkg, 'src/components/ExportDialog.svelte'));
const app = read(join(pkg, 'src/App.svelte'));
const coreApi = read(join(pkg, 'src/core-api.ts'));

const STATES = ['queued', 'converting', 'compiling', 'completed', 'failed', 'cancelled'] as const;
const TERMINAL = ['completed', 'failed', 'cancelled'] as const;

describe('every job state has a label (UX-101 criterion 2, part)', () => {
  it('names each state the dialog can show, in words', () => {
    const tr = new Strings().current;
    for (const state of STATES) {
      const text = tr.t(`export.state.${state}` as 'export.state.queued');
      expect(text, state).not.toBe(`export.state.${state}`);
      expect(text.trim().length, state).toBeGreaterThan(0);
    }
  });
});

describe('a finished, failed or cancelled job is announced (UX-101 criterion 6)', () => {
  it('has an announcement for each terminal state', () => {
    for (const state of TERMINAL) {
      expect(EN_GB[`announce.export.${state}`], state).toMatch(/\S/);
    }
  });

  it('announces a terminal state once through the shell, and only for those states', () => {
    expect(dialog).toMatch(
      /state === 'completed' \|\| state === 'failed' \|\| state === 'cancelled'/,
    );
    expect(dialog).toMatch(/shell\.announce\(`announce\.export\.\$\{state\}` as StringKey\)/);
    expect(dialog).toMatch(/if \(!state \|\| state === announced\) return;/);
  });

  it('sends the announcement to the shell live region, which is a status region', () => {
    expect(app).toMatch(
      /<div class="de-visually-hidden" role="status"[^>]*>\{announcement\}<\/div>/,
    );
  });
});

describe('severity is given in words, not by colour alone (UX-101 criterion 4, part)', () => {
  it('has three distinct, non-empty severity words', () => {
    const tr = new Strings().current;
    const words = [
      'export.severity.error',
      'export.severity.warning',
      'export.severity.info',
    ] as const;
    const texts = words.map((k) => tr.t(k));
    for (const text of texts) expect(text.trim().length).toBeGreaterThan(0);
    expect(new Set(texts).size).toBe(3);
  });

  it('renders the severity as text inside each diagnostic, with the colour hook only as an attribute', () => {
    expect(dialog).toMatch(
      /<span class="de-severity" data-severity=\{d\.severity\}>\{tr\.t\(severityKey\(d\)\)\}<\/span>/,
    );
  });
});

describe('a projected export says that hidden parts are left out (UX-104 criterion 4)', () => {
  it('states it in words that do not name who has access', () => {
    const text = new Strings().current.t('dialog.export.hidden');
    expect(text).toMatch(/hidden from you/);
    expect(text).toMatch(/left out/);
    expect(text).not.toMatch(/owner|editor|administrator|who /i);
  });

  it('shows the statement only when the core reports the export as projected', () => {
    expect(coreApi).toMatch(/readonly projected\?: ReadView<boolean>;/);
    expect(dialog).toMatch(
      /\{#if projected\?\.current\}\s*<p class="de-hint" data-export="hidden">\{tr\.t\('dialog\.export\.hidden'\)\}<\/p>\s*\{\/if\}/,
    );
  });
});
