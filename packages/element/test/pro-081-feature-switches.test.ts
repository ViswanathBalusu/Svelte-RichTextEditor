// PRO-081 criterion 4: the feature switches of `config` (owner decision 89). The browser run, which
// shows the controls missing in a loaded editor, is e2e/pro-081-feature-switches.spec.ts. These
// tests cover what a browser run cannot tell apart: how the key is read, and which ports the shell
// is given for each group.
import { describe, expect, it } from 'vitest';
import { normaliseConfig } from '../src/config.ts';
import {
  ALL_FEATURES_ON,
  attachWithSwitches,
  type FeatureGroup,
  hiddenBackendFeatures,
  shellWithSwitches,
  switchedModes,
} from '../src/feature-switches.ts';
import type { ShellCore } from '../src/editor.ts';
import type { AttachAt, ReadView } from '../src/session.ts';

const view = <T>(value: T): ReadView<T> => ({ get: () => value, subscribe: () => () => {} });
const off = (...groups: FeatureGroup[]) => ({
  ...ALL_FEATURES_ON,
  ...Object.fromEntries(groups.map((g) => [g, false])),
});

/** A shell with a member for every port a group takes away. */
function shell(): ShellCore {
  const fn = () => null;
  return {
    features: view(['presence', 'comments', 'history', 'exports', 'assets']),
    suggestionItems: () => [],
    stepSuggestion: fn,
    revealSuggestion: fn,
    resolveAtSelection: fn,
    resolveSuggestions: fn,
    markupView: view('all'),
    setMarkupView: fn,
    setSuggestionLabel: fn,
    exports: {},
    assistant: {},
    proofing: view({ available: true }),
    selection: view(null),
  } as unknown as ShellCore;
}

describe('the features key of config (PRO-081 criterion 4)', () => {
  it('has every group on by default', () => {
    expect(normaliseConfig(null).features).toEqual({
      comments: true,
      export: true,
      history: true,
      assistant: true,
    });
    expect(normaliseConfig({}).features).toEqual(normaliseConfig(null).features);
  });

  it('switches off a group only for the boolean false', () => {
    expect(normaliseConfig({ features: { comments: false } }).features).toEqual({
      comments: false,
      export: true,
      history: true,
      assistant: true,
    });
    for (const v of ['false', 0, null, undefined, 'no', {}, []])
      expect(normaliseConfig({ features: { history: v } }).features.history, String(v)).toBe(true);
  });

  it('ignores a features value that is not an object, an inherited key and a key that is no group', () => {
    for (const v of [null, true, 'off', 3, [false, false], undefined])
      expect(normaliseConfig({ features: v }).features).toEqual(ALL_FEATURES_ON);
    const inherited = Object.create({ comments: false }) as object;
    expect(normaliseConfig({ features: inherited }).features).toEqual(ALL_FEATURES_ON);
    expect(normaliseConfig({ features: { print: false } }).features).toEqual(ALL_FEATURES_ON);
  });

  it('returns an object the caller may change without changing the default', () => {
    const a = normaliseConfig(null).features as { comments: boolean };
    a.comments = false;
    expect(normaliseConfig(null).features.comments).toBe(true);
  });
});

describe('what the shell is given when a group is off', () => {
  it('passes everything on when every group is on', () => {
    const s = shell();
    expect(shellWithSwitches(s, ALL_FEATURES_ON)).toBe(s);
    const at = { seq: 1, incarnation: 'i', features: ['comments'] } as AttachAt;
    expect(attachWithSwitches(at, ALL_FEATURES_ON)).toBe(at);
    expect(switchedModes(['edit', 'review', 'view'], ALL_FEATURES_ON)).toEqual([
      'edit',
      'review',
      'view',
    ]);
  });

  it('comments: no review, markup or comment feature, and no suggesting mode', () => {
    const out = shellWithSwitches(shell(), off('comments'));
    for (const k of [
      'suggestionItems',
      'stepSuggestion',
      'revealSuggestion',
      'resolveAtSelection',
      'resolveSuggestions',
      'markupView',
      'setMarkupView',
      'setSuggestionLabel',
    ])
      expect(k in out, k).toBe(false);
    expect(out.features?.get()).toEqual(['presence', 'history', 'exports', 'assets']);
    expect(out.exports).toBeDefined();
    expect(switchedModes(['edit', 'review', 'view'], off('comments'))).toEqual(['edit', 'view']);
  });

  it('export: no exports port and no exports feature', () => {
    const out = shellWithSwitches(shell(), off('export'));
    expect('exports' in out).toBe(false);
    expect(out.features?.get()).toEqual(['presence', 'comments', 'history', 'assets']);
    expect(out.suggestionItems).toBeDefined();
  });

  it('history: no history feature, the rest untouched', () => {
    const out = shellWithSwitches(shell(), off('history'));
    expect(out.features?.get()).toEqual(['presence', 'comments', 'exports', 'assets']);
    expect(out.exports).toBeDefined();
    expect(out.suggestionItems).toBeDefined();
  });

  it('assistant: the proofing and assistant ports are not attached', () => {
    const at = {
      seq: 1,
      incarnation: 'i',
      features: ['presence'],
      proofing: {},
      assistant: {},
      user: 'u',
    } as unknown as AttachAt;
    const out = attachWithSwitches(at, off('assistant'));
    expect('proofing' in out).toBe(false);
    expect('assistant' in out).toBe(false);
    expect(out).toMatchObject({ seq: 1, incarnation: 'i', user: 'u', features: ['presence'] });
    // The other groups leave the ports where they are.
    expect(attachWithSwitches(at, off('comments'))).toMatchObject({ proofing: {}, assistant: {} });
  });

  it('removes the backend features of a group from what the session announces', () => {
    const at = {
      seq: 1,
      incarnation: 'i',
      features: ['comments', 'history', 'exports', 'presence'],
    } as AttachAt;
    expect(attachWithSwitches(at, off('comments', 'history', 'export')).features).toEqual([
      'presence',
    ]);
    expect(
      [...hiddenBackendFeatures(off('comments', 'export', 'history', 'assistant'))].sort(),
    ).toEqual(['comments', 'exports', 'history']);
  });

  it('keeps the subscription of the features view', () => {
    let unsubscribed = 0;
    let subscribed = 0;
    const base: ReadView<readonly string[]> = {
      get: () => ['comments'],
      subscribe: () => {
        subscribed++;
        return () => {
          unsubscribed++;
        };
      },
    };
    const out = shellWithSwitches({ features: base } as unknown as ShellCore, off('history'));
    out.features!.subscribe(() => {})();
    expect([subscribed, unsubscribed]).toEqual([1, 1]);
  });
});
