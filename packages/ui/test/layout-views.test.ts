/**
 * The layout views of the view group (UX-007, criterion 4): the registry offers only the views the
 * core lists, in the shell's order, so `print` appears only once the core supports it. The rule is
 * `layoutViews` in `commands/builtin.ts`, which App.svelte uses to register `view.layout.*`.
 * Rendering the group in a browser is not tested here.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { layoutViews, shellCommands1b } from '../src/commands/builtin.ts';
import type { CommandContext } from '../src/commands/types.ts';
import type { ViewName } from '../src/core-api.ts';

const ALL = ['web', 'read', 'print'] as const;

describe('the view group offers the views the build supports (UX-007, criterion 4)', () => {
  it('offers web only when the core does not list its views', () => {
    expect(layoutViews(undefined)).toEqual(['web']);
    expect(layoutViews(null)).toEqual(['web']);
  });

  it('offers print only when the core lists it', () => {
    expect(layoutViews(['web', 'read'])).toEqual(['web', 'read']);
    expect(layoutViews(['web', 'read', 'print'])).toEqual(['web', 'read', 'print']);
    expect(layoutViews(['web'])).not.toContain('print');
  });

  it('keeps the shell order whatever order the core lists them in', () => {
    expect(layoutViews(['print', 'web', 'read'])).toEqual(['web', 'read', 'print']);
  });

  it('drops names the shell does not know (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 6 }), (names) => {
        const offered = layoutViews(names);
        for (const view of offered) expect(ALL).toContain(view);
      }),
    );
  });

  it('offers exactly the listed known views, in order (property)', () => {
    fc.assert(
      fc.property(fc.subarray([...ALL]), fc.shuffledSubarray([...ALL]), (subset, shuffled) => {
        const listed = shuffled.filter((v) => subset.includes(v));
        const offered = layoutViews(listed);
        expect(offered).toEqual(ALL.filter((v) => listed.includes(v)));
      }),
    );
  });

  it('registers one view.layout command per offered view, which sets that view', () => {
    fc.assert(
      fc.property(fc.subarray([...ALL], { minLength: 1 }), (listed) => {
        const calls: string[] = [];
        const none = () => false;
        const entries = shellCommands1b({
          togglePane: none,
          find: none,
          painter: none,
          applyFormat: none,
          openDialog: none,
          zoom: none,
          setMode: none,
          setView: (view: ViewName) => {
            calls.push(view);
            return true;
          },
          closeStory: none,
          commandSearch: none,
        });
        const offered = layoutViews(listed);
        for (const view of offered) {
          const entry = entries[`view.layout.${view}`];
          expect(entry).toBeDefined();
          expect(entry?.group).toBe('view');
          entry?.run({} as CommandContext);
        }
        expect(calls).toEqual(offered);
      }),
    );
  });
});
