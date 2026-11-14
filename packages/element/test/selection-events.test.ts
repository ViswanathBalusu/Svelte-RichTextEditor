/**
 * FE-028: `de-selection` and `de-command-state` are raised from the core's revision view, at most
 * once per frame each, with identifiers only. The frame is driven by a ViewHub with a manual
 * scheduler, so the test controls exactly when a frame ends.
 */
import { ReadValue, ViewHub } from '@docedit/engine';
import { describe, expect, it } from 'vitest';
import {
  SelectionEvents,
  type CommandSnapshot,
  type SelectionDetail,
  type SelectionWatch,
} from '../src/selection-events.ts';

type Raised = { commands: { name: string; enabled: boolean; active: boolean }[] };

interface Harness {
  readonly selectionRaised: SelectionDetail[];
  readonly stateRaised: Raised[];
  scope: SelectionDetail;
  commands: Record<string, CommandSnapshot>;
  /** Changes the state the watch reads, then records that the core published a revision. */
  change(edit: (h: Harness) => void): void;
  /** Ends the frame: the scheduled pass runs once and notifies the subscribers. */
  endFrame(): void;
  /** Removes the subscription. */
  stop: () => void;
}

function harness(): Harness {
  const frames: (() => void)[] = [];
  const hub = new ViewHub((run) => frames.push(run));
  // The core's `revision` view: notifies at most once per frame (core.ts #publish).
  const revision = new ReadValue<number>(0, Object.is, hub);
  const selectionRaised: SelectionDetail[] = [];
  const stateRaised: Raised[] = [];
  let rev = 0;

  const h: Harness = {
    selectionRaised,
    stateRaised,
    scope: { scope: 'body', blockId: 'b1' },
    commands: {
      bold: { enabled: true, active: false },
      italic: { enabled: true, active: false },
    },
    change(edit) {
      edit(h);
      rev += 1;
      revision.set(rev);
    },
    endFrame() {
      for (const run of frames.splice(0)) run();
    },
    stop: () => {},
  };

  const watch: SelectionWatch = {
    revision,
    selectionScope: () => h.scope,
    commandStates: () => h.commands,
  };
  const events = new SelectionEvents(watch, {
    selection: (d) => selectionRaised.push(d),
    commandState: (d) => stateRaised.push(d),
  });
  h.stop = events.start();
  return h;
}

describe('FE-028 de-selection', () => {
  it('raises nothing for a caret that moves inside the same block', () => {
    const h = harness();
    h.change(() => {});
    h.endFrame();
    expect(h.selectionRaised).toEqual([]);
  });

  it('raises {scope, blockId} with no other keys when the selection moves to another block', () => {
    const h = harness();
    h.change((x) => (x.scope = { scope: 'body', blockId: 'b2' }));
    h.endFrame();
    expect(h.selectionRaised).toEqual([{ scope: 'body', blockId: 'b2' }]);
    expect(Object.keys(h.selectionRaised[0] ?? {}).sort()).toEqual(['blockId', 'scope']);
  });

  it('raises when the selection moves into a region', () => {
    const h = harness();
    h.change((x) => (x.scope = { scope: 'region:r1', blockId: 'p9' }));
    h.endFrame();
    expect(h.selectionRaised).toEqual([{ scope: 'region:r1', blockId: 'p9' }]);
  });

  it('gives at most one event per frame however many moves happen in it', () => {
    const h = harness();
    h.change((x) => (x.scope = { scope: 'body', blockId: 'b2' }));
    h.change((x) => (x.scope = { scope: 'body', blockId: 'b3' }));
    h.change((x) => (x.scope = { scope: 'region:r1', blockId: 'p1' }));
    h.endFrame();
    expect(h.selectionRaised).toEqual([{ scope: 'region:r1', blockId: 'p1' }]);
  });

  it('raises nothing when the selection moves and comes back within one frame', () => {
    const h = harness();
    h.change((x) => (x.scope = { scope: 'body', blockId: 'b2' }));
    h.change((x) => (x.scope = { scope: 'body', blockId: 'b1' }));
    h.endFrame();
    expect(h.selectionRaised).toEqual([]);
  });

  it('stops raising after the subscription is removed', () => {
    const h = harness();
    h.stop();
    h.change((x) => (x.scope = { scope: 'body', blockId: 'b2' }));
    h.endFrame();
    expect(h.selectionRaised).toEqual([]);
  });
});

describe('FE-028 de-command-state', () => {
  it('lists exactly the command whose active state changed', () => {
    const h = harness();
    h.change((x) => (x.commands = { ...x.commands, bold: { enabled: true, active: true } }));
    h.endFrame();
    expect(h.stateRaised).toEqual([{ commands: [{ name: 'bold', enabled: true, active: true }] }]);
  });

  it('lists a command whose enabled state changed, and not the others', () => {
    const h = harness();
    h.change((x) => (x.commands = { ...x.commands, italic: { enabled: false, active: false } }));
    h.endFrame();
    expect(h.stateRaised).toEqual([
      { commands: [{ name: 'italic', enabled: false, active: false }] },
    ]);
  });

  it('raises nothing when a command state is unchanged', () => {
    const h = harness();
    h.change((x) => (x.commands = { ...x.commands, bold: { enabled: true, active: false } }));
    h.endFrame();
    expect(h.stateRaised).toEqual([]);
  });

  it('gives at most one event per frame and lists each changed command once', () => {
    const h = harness();
    h.change((x) => (x.commands = { ...x.commands, bold: { enabled: true, active: true } }));
    h.change((x) => (x.commands = { ...x.commands, italic: { enabled: true, active: true } }));
    h.change((x) => (x.commands = { ...x.commands, bold: { enabled: true, active: false } }));
    h.endFrame();
    expect(h.stateRaised).toHaveLength(1);
    expect(h.stateRaised[0]?.commands).toEqual([{ name: 'italic', enabled: true, active: true }]);
  });

  it('carries only the name, enabled and active: no content', () => {
    const h = harness();
    h.change((x) => (x.commands = { ...x.commands, bold: { enabled: true, active: true } }));
    h.endFrame();
    const entry = h.stateRaised[0]?.commands[0];
    expect(Object.keys(entry ?? {}).sort()).toEqual(['active', 'enabled', 'name']);
  });

  it('raises nothing for the baseline state the reporter started from', () => {
    const h = harness();
    h.endFrame();
    expect(h.stateRaised).toEqual([]);
    expect(h.selectionRaised).toEqual([]);
  });
});
