/**
 * Feature switches (05 §8.1 `config`; PRO-081 criterion 4; owner decision 89 in
 * docs/owner-decisions-2026-11-15.md). Four groups can be switched off, and the editor then loads
 * without their controls:
 *
 * | Switch | What goes |
 * |---|---|
 * | `comments` | comments and suggestions: the comments pane and its commands, the review pane and commands, the suggestion markup views, and the suggesting mode |
 * | `export` | export and print: the export dialog and command, the print command and the PDF pane |
 * | `history` | history: the history pane, the catch-up pane and naming a version |
 * | `assistant` | assistant and proofing: the assistant pane, the proofing commands and the findings |
 *
 * The shell shows a feature only when its port exists (05 §8.3), so a switch takes the ports away
 * before the shell sees them: the backend features of the group are not passed on (`features`), the
 * ports that have no feature name (`proofing`, `assistant`) are not attached, and the members the
 * shell reads for the group are left out of its view of the core. A switch changes what the interface
 * offers. It is not a permission: the server still decides what a caller may do (PRODUCT principle 2).
 *
 * The names of the keys are proposed in `docs/stories/PRO-protocol.md` (PRO-081 Notes).
 */
import type { CoreApi, EditorMode } from '@docedit/ui';
import type { AttachAt, ReadView } from './session.ts';

export type FeatureGroup = 'comments' | 'export' | 'history' | 'assistant';

/** The groups that can be switched off, in the order of the schema. */
export const FEATURE_GROUPS: readonly FeatureGroup[] = [
  'comments',
  'export',
  'history',
  'assistant',
];

/** Which groups are on. Every group is on unless its key is `false` (PRO-081). */
export type FeatureSwitches = Readonly<Record<FeatureGroup, boolean>>;

export const ALL_FEATURES_ON: FeatureSwitches = {
  comments: true,
  export: true,
  history: true,
  assistant: true,
};

/** The backend features (05 §1) whose controls belong to a group. */
const BACKEND_FEATURES: Readonly<Record<FeatureGroup, readonly string[]>> = {
  comments: ['comments'],
  export: ['exports'],
  history: ['history'],
  assistant: [],
};

/** The backend features that a switched-off group hides. */
export function hiddenBackendFeatures(on: FeatureSwitches): ReadonlySet<string> {
  const out = new Set<string>();
  for (const group of FEATURE_GROUPS)
    if (!on[group]) for (const f of BACKEND_FEATURES[group]) out.add(f);
  return out;
}

/** What the session hands the core: the ports of a switched-off group are left out. */
export function attachWithSwitches(at: AttachAt, on: FeatureSwitches): AttachAt {
  if (FEATURE_GROUPS.every((g) => on[g])) return at;
  const { proofing, assistant, features, ...rest } = at;
  const hidden = hiddenBackendFeatures(on);
  return {
    ...rest,
    ...(features ? { features: features.filter((f) => !hidden.has(f)) } : {}),
    ...(on.assistant && proofing ? { proofing } : {}),
    ...(on.assistant && assistant ? { assistant } : {}),
  };
}

/** The modes the switcher offers: the suggesting mode goes with the comments group. */
export function switchedModes(
  modes: readonly EditorMode[],
  on: FeatureSwitches,
): readonly EditorMode[] {
  return on.comments ? modes : modes.filter((m) => m !== 'review');
}

/**
 * The shell's view of the core without the members of the groups that are off. The members are
 * left out, not replaced by empty ones, because the shell tests for their presence.
 */
export function shellWithSwitches<T extends CoreApi>(shell: T, on: FeatureSwitches): T {
  if (FEATURE_GROUPS.every((g) => on[g])) return shell;
  const hidden = hiddenBackendFeatures(on);
  let out: T = shell;
  if (hidden.size > 0 && shell.features) {
    const base = shell.features;
    const features: ReadView<readonly string[]> = {
      get: () => base.get().filter((f) => !hidden.has(f)),
      subscribe: (listener) => base.subscribe(listener),
    };
    out = { ...out, features };
  }
  if (!on.comments) {
    const {
      suggestionItems: _a,
      stepSuggestion: _b,
      revealSuggestion: _c,
      resolveAtSelection: _d,
      resolveSuggestions: _e,
      markupView: _f,
      setMarkupView: _g,
      setSuggestionLabel: _h,
      threads: _i,
      ...rest
    } = out;
    out = rest as unknown as T;
  }
  if (!on.export) {
    const { exports: _x, ...rest } = out;
    out = rest as unknown as T;
  }
  return out;
}
