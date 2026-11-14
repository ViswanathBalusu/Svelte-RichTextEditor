/**
 * The mode in a suggest-only scope (PRM-031 criteria 1, 3 and 4; 07 §7). The shell keeps the editor
 * in suggestion mode where the user may only suggest, and applies the mode they chose for editing
 * when the caret moves to a scope they may edit.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { AccessSummary, Capability, EditorMode } from '../src/core-api.ts';
import {
  START_TRACK,
  modeInScope,
  stepMode,
  suggestOnlyHere,
  type ModeTrack,
} from '../src/shell/suggest-mode.ts';

const CAPS: readonly Capability[] = [
  'view',
  'comment',
  'suggest',
  'edit',
  'fill',
  'structure',
  'manage',
];
const MODES: readonly EditorMode[] = ['edit', 'review', 'view', 'fill'];
const LIMITS = [null, 'locked', 'archived', 'workflow', 'role', 'hidden'] as const;

function here(caps: readonly Capability[], limit: AccessSummary['limit'] = null): AccessSummary {
  return { scope: 'region:r1', caps, limit };
}

/** A core that applies every request at once, as the editing core does for a mode change. */
function run(
  track: ModeTrack,
  core: EditorMode,
  access: readonly (AccessSummary | undefined)[],
): { track: ModeTrack; core: EditorMode; seen: EditorMode[] } {
  let t = track;
  let c = core;
  const seen: EditorMode[] = [];
  for (const h of access) {
    const step = stepMode(t, c, h);
    t = step.track;
    if (step.target) c = step.target;
    seen.push(c);
  }
  return { track: t, core: c, seen };
}

describe('suggestion mode where the user may only suggest (PRM-031, criterion 1)', () => {
  it('reports suggest without edit as suggest-only, and nothing else', () => {
    expect(suggestOnlyHere(here(['suggest']))).toBe(true);
    expect(suggestOnlyHere(here(['suggest', 'edit']))).toBe(false);
    expect(suggestOnlyHere(here(['view']))).toBe(false);
    expect(suggestOnlyHere(undefined)).toBe(false);
  });

  it('puts the editor in review, not edit, when the caret is in a suggest-only scope', () => {
    expect(modeInScope('edit', here(['suggest']))).toBe('review');
  });

  it('keeps the editor out of edit in every suggest-only scope without a document limit (property)', () => {
    fc.assert(
      fc.property(
        fc.subarray([...CAPS]).filter((c) => c.includes('suggest') && !c.includes('edit')),
        fc.constantFrom(...LIMITS),
        (caps, limit) => {
          const mode = modeInScope('edit', here(caps, limit));
          if (limit === null || limit === 'role' || limit === 'hidden') expect(mode).toBe('review');
          else expect(mode).toBe('edit');
        },
      ),
    );
  });

  it('leaves the choice alone where a document limit applies, since review is refused there too', () => {
    expect(modeInScope('edit', here(['suggest'], 'locked'))).toBe('edit');
    expect(modeInScope('edit', here(['suggest'], 'workflow'))).toBe('edit');
  });

  it('never changes view, review or fill (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...MODES.filter((m) => m !== 'edit')),
        fc.subarray([...CAPS]),
        fc.constantFrom(...LIMITS),
        (chosen, caps, limit) => {
          expect(modeInScope(chosen, here(caps, limit))).toBe(chosen);
        },
      ),
    );
  });
});

describe('the mode chosen for editing comes back in an editable scope (PRM-031, criterion 3)', () => {
  it('moves to review in a suggest-only scope and back to edit in a scope the user may edit', () => {
    const editable = here(['suggest', 'edit']);
    const suggestOnly = here(['suggest']);
    const { core, seen } = run(START_TRACK, 'edit', [editable, suggestOnly, editable]);
    expect(seen).toEqual(['edit', 'review', 'edit']);
    expect(core).toBe('edit');
  });

  it('returns to the chosen mode after any sequence of scopes (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }), (suggestOnlyFlags) => {
        const accesses = suggestOnlyFlags.map((s) =>
          s ? here(['suggest']) : here(['suggest', 'edit']),
        );
        const { core, seen } = run(START_TRACK, 'edit', accesses);
        // The core is in edit exactly where the user may edit, and in review where they may only suggest.
        seen.forEach((mode, i) => expect(mode).toBe(suggestOnlyFlags[i] ? 'review' : 'edit'));
        expect(core).toBe(suggestOnlyFlags[suggestOnlyFlags.length - 1] ? 'review' : 'edit');
      }),
    );
  });

  it('keeps a mode the user chose by hand after a move into a suggest-only scope', () => {
    // The user chose view; the caret visits a suggest-only scope and comes back.
    const { core, seen } = run({ ...START_TRACK, chosen: 'view', seen: 'view' }, 'view', [
      here(['suggest']),
      here(['suggest', 'edit']),
    ]);
    expect(seen).toEqual(['view', 'view']);
    expect(core).toBe('view');
  });

  it('takes a mode changed by the user as the new choice', () => {
    // The core was in edit and moves to view on the user's command; the shell did not ask for it.
    const started = run(START_TRACK, 'edit', [here(['suggest', 'edit'])]);
    const after = stepMode(started.track, 'view', here(['suggest']));
    expect(after.track.chosen).toBe('view');
    expect(after.target).toBeNull();
  });
});

describe('a host that sets edit where the server grants only suggest (PRM-031, criterion 4)', () => {
  it('moves the editor to review when the document opens', () => {
    const step = stepMode(START_TRACK, 'edit', here(['suggest']));
    expect(step.target).toBe('review');
  });

  it('does not ask the core again once it is in review (no loop)', () => {
    const first = stepMode(START_TRACK, 'edit', here(['suggest']));
    const confirmed = stepMode(first.track, 'review', here(['suggest']));
    expect(confirmed.target).toBeNull();
  });
});
