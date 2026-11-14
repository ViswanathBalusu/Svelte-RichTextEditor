/**
 * The language the status bar shows at the caret (UX-018 criterion 3), and the language command's
 * permission (UX-018 criterion 3, second part; UX-004). The words are the component's; the choice
 * of source is a pure function, tested here with property tests.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createCommandRegistry, immediateScheduler } from '../src/commands/index.ts';
import { shellCommands1b, type ShellCommandHost1b } from '../src/commands/builtin.ts';
import { languageAt } from '../src/shell/status.ts';
import { EDIT, FakeCore, VIEW } from './support/fake-core.ts';

const tag = fc.constantFrom('en-GB', 'fr-FR', 'de-DE', 'ja-JP', 'ar-EG');
const blank = fc.constantFrom('', ' ', '\t', '  \n ');

describe('the language at the caret (UX-018, criterion 3)', () => {
  it('shows the mark at the caret when there is one, whatever the document default (property)', () => {
    fc.assert(
      fc.property(tag, fc.option(tag, { nil: null }), (mark, fallback) => {
        expect(languageAt(mark, fallback)).toEqual({ source: 'mark', tag: mark });
      }),
    );
  });

  it('shows the document default when the caret has no mark (or only a blank one) (property)', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(null), fc.constant(undefined), blank),
        tag,
        (mark, fallback) => {
          expect(languageAt(mark, fallback)).toEqual({ source: 'document', tag: fallback });
        },
      ),
    );
  });

  it('says there is none when neither the mark nor the document has a language', () => {
    expect(languageAt(null, null)).toEqual({ source: 'none' });
    expect(languageAt(undefined, '  ')).toEqual({ source: 'none' });
  });

  it('never invents a language: the tag it returns is the mark or the default, trimmed (property)', () => {
    fc.assert(
      fc.property(
        fc.option(tag, { nil: null }),
        fc.option(tag, { nil: null }),
        (mark, fallback) => {
          const at = languageAt(mark, fallback);
          if (at.source === 'none') expect(mark === null && fallback === null).toBe(true);
          else expect(at.tag).toBe(at.source === 'mark' ? mark : fallback);
        },
      ),
    );
  });
});

describe('the language command follows the access (UX-018 criterion 3, second part)', () => {
  // The language command is a shell command: it opens the language dialog, which runs the core's
  // setLanguage. The host's methods are not needed to read its state.
  const host = new Proxy({}, { get: () => () => true }) as ShellCommandHost1b;
  const language = shellCommands1b(host)['format.language']!;

  function registryWith(access: typeof VIEW) {
    const registry = createCommandRegistry(new FakeCore({ access, extended: true }), {
      scheduler: immediateScheduler(),
    });
    registry.register(language);
    return registry;
  }

  it('is disabled with a reason for a user with only view', () => {
    expect(registryWith(VIEW).state('format.language')).toMatchObject({
      enabled: false,
      reason: 'no-access',
    });
  });

  it('is enabled for a user who may edit', () => {
    const registry = registryWith(EDIT);
    expect(registry.state('format.language').enabled).toBe(true);
  });
});
