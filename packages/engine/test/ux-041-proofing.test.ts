/**
 * UX-041: spelling and grammar findings from the proofing port (13 §6.1; 02 §15). The core is given
 * a mock port that records its requests and answers from a list of "misspelt" words. Time is a
 * manual clock, so the pause before a check is stepped, not waited for. Node.js, no DOM.
 */
import { loadProofing } from '../src/core.ts';
import type { CancelSignal, ProofingFinding } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import type { ProofingPort } from '../src/proofing.ts';
import {
  PROOF_CURRENT_CLASS,
  PROOF_SPELLING_CLASS,
  proofingDecorations,
} from '../src/proofing-decorations.ts';
import { internals } from '../src/testing.ts';
import { STYLE_IDS, styledEditorAccess } from './fixtures.ts';
import { blockText, endOf, manualClock, newCore, settle, wordPort } from './proofing-support.ts';
import { join, newService, posOf, type, until } from './support.ts';
import { contractDocument } from '@docedit/protocol/contract';
import { TextSelection } from 'prosemirror-state';

// The proofing controller is a chunk of its own (UX-070); load it so that attaching a port is synchronous.
await loadProofing();

describe('UX-041 criterion 1: findings return as decorations and change nothing', () => {
  it('sends the blocks with the document language when the document opens', async () => {
    const port = wordPort({ quotation: ['quotations'] });
    const core = newCore();
    core.attachProofing(port, { clock: manualClock() });
    await settle();
    const request = port.requests[0]!;
    expect(request.blocks.map((b) => b.blockId)).toEqual([
      STYLE_IDS.heading,
      STYLE_IDS.quote,
      STYLE_IDS.plain,
      STYLE_IDS.inRegion,
      STYLE_IDS.after,
    ]);
    expect(new Set(request.blocks.map((b) => b.lang))).toEqual(new Set(['en-GB']));
    expect(request.blocks[3]?.scope).toBe(`region:${STYLE_IDS.region}`);
    expect(request.blocks[1]?.text).toBe('A quotation');
  });

  it('draws a finding as a decoration over its text, with its suggestions, and leaves the document alone', async () => {
    const core = newCore();
    const before = JSON.stringify(core.getContent());
    core.attachProofing(wordPort({ quotation: ['quotations', 'quotation.'] }), {
      clock: manualClock(),
    });
    await settle();
    const found = core.proofingFindings();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      blockId: STYLE_IDS.quote,
      text: 'quotation',
      kind: 'spelling',
      suggestions: ['quotations', 'quotation.'],
    });
    const doc = internals(core).state.doc;
    const decorations = proofingDecorations(doc, found, null).find();
    expect(decorations).toHaveLength(1);
    expect(doc.textBetween(decorations[0]!.from, decorations[0]!.to)).toBe('quotation');
    const spec = (decorations[0] as unknown as { type: { attrs: Record<string, string> } }).type
      .attrs;
    expect(spec['class']).toBe(PROOF_SPELLING_CLASS);
    expect(spec['data-de-finding']).toBe(found[0]!.id);
    // Not changed, and nothing queued for the service (criterion 7 as well).
    expect(JSON.stringify(core.getContent())).toBe(before);
    const snapshot = core.syncSnapshot();
    expect(snapshot.queue).toEqual([]);
    expect(snapshot.inflight).toBeNull();
  });

  it('checks again after a pause when text changes, and sends only the changed block', async () => {
    const port = wordPort({});
    const clock = manualClock();
    const core = newCore();
    core.attachProofing(port, { clock });
    await settle();
    expect(port.requests).toHaveLength(1);
    endOf(core, STYLE_IDS.plain);
    type(core, ' more');
    type(core, ' text');
    expect(port.requests).toHaveLength(1); // nothing is sent while the author types
    expect(clock.pending()).toBe(1); // one pause, restarted by each change
    clock.fire();
    await settle();
    expect(port.requests).toHaveLength(2);
    expect(port.requests[1]!.blocks.map((b) => b.blockId)).toEqual([STYLE_IDS.plain]);
    expect(port.requests[1]!.blocks[0]?.text).toBe('Plain text more text');
  });

  it('sends the language of the lang mark, and a block with none gets the document default', async () => {
    const port = wordPort({});
    const clock = manualClock();
    const core = newCore();
    core.attachProofing(port, { clock });
    await settle();
    const i = internals(core);
    const start = posOf(i.state.doc, STYLE_IDS.plain) + 1;
    i.dispatch(
      i.state.tr.setSelection(
        TextSelection.create(i.state.doc, start, start + 'Plain text'.length),
      ),
    );
    expect(core.run('lang', { lang: 'fr-FR' })).toBe(true);
    clock.fire();
    await settle();
    const last = port.requests[port.requests.length - 1]!;
    expect(last.blocks).toHaveLength(1);
    expect(last.blocks[0]).toMatchObject({ blockId: STYLE_IDS.plain, lang: 'fr-FR' });
  });
});

describe('UX-041 criterion 2: text outside the reader scope is not sent', () => {
  it('never sends a block in a scope without view, and counts it', async () => {
    const access = styledEditorAccess();
    access.scopes[`region:${STYLE_IDS.region}`] = [];
    const port = wordPort({ Protected: ['Protect'] });
    const clock = manualClock();
    const core = newCore({ access });
    core.attachProofing(port, { clock });
    await settle();
    endOf(core, STYLE_IDS.after);
    type(core, ' x');
    clock.fire();
    await settle();
    for (const r of port.requests)
      for (const b of r.blocks) {
        expect(b.blockId).not.toBe(STYLE_IDS.inRegion);
        expect(b.text).not.toContain('Protected');
      }
    expect(core.proofing.get().omitted).toBe(1);
    expect(core.proofingFindings()).toEqual([]);
  });

  it('stops sending a scope when the access that allowed it is withdrawn', async () => {
    const port = wordPort({});
    const clock = manualClock();
    const core = newCore();
    core.attachProofing(port, { clock });
    await settle();
    const access = styledEditorAccess();
    access.scopes[`region:${STYLE_IDS.region}`] = [];
    access.rev = 2;
    core.setAccess(access);
    endOf(core, STYLE_IDS.after);
    type(core, ' y');
    clock.fire();
    await settle();
    const last = port.requests[port.requests.length - 1]!;
    expect(last.blocks.map((b) => b.blockId)).toEqual([STYLE_IDS.after]);
  });
});

describe('UX-041 criterion 3: a finding is never shown on the wrong text', () => {
  it('discards a result computed for text that has since changed, and shows the rest', async () => {
    const pending: Array<(f: ProofingFinding[]) => void> = [];
    const port: ProofingPort = {
      check: (request) =>
        new Promise<ProofingFinding[]>((resolve) => {
          pending.push((all) =>
            resolve(all.filter((f) => request.blocks.some((b) => b.blockId === f.blockId))),
          );
        }),
      addWord: () => Promise.resolve(),
    };
    const clock = manualClock();
    const core = newCore();
    core.attachProofing(port, { clock });
    await settle();
    // While the first check is out, the author edits the plain paragraph.
    endOf(core, STYLE_IDS.plain);
    type(core, 'er');
    const result: ProofingFinding[] = [
      { blockId: STYLE_IDS.plain, from: 0, to: 5, kind: 'spelling', message: 'x', suggestions: [] },
      {
        blockId: STYLE_IDS.quote,
        from: 2,
        to: 11,
        kind: 'spelling',
        message: 'y',
        suggestions: ['z'],
      },
    ];
    pending[0]!(result);
    await settle();
    const shown = core.proofingFindings().map((f) => f.blockId);
    expect(shown).toEqual([STYLE_IDS.quote]);
    expect(blockText(core, STYLE_IDS.plain)).toBe('Plain texter');
  });

  it('drops a finding that does not fit the block it names', async () => {
    const port: ProofingPort = {
      check: () =>
        Promise.resolve([
          { blockId: 'nope', from: 0, to: 2, kind: 'spelling', message: '', suggestions: [] },
          {
            blockId: STYLE_IDS.plain,
            from: 3,
            to: 3,
            kind: 'spelling',
            message: '',
            suggestions: [],
          },
          {
            blockId: STYLE_IDS.plain,
            from: 0,
            to: 99,
            kind: 'spelling',
            message: '',
            suggestions: [],
          },
          {
            blockId: STYLE_IDS.plain,
            from: 0,
            to: 5,
            kind: 'spelling',
            message: '',
            suggestions: [],
          },
        ]),
      addWord: () => Promise.resolve(),
    };
    const core = newCore();
    core.attachProofing(port, { clock: manualClock() });
    await settle();
    expect(core.proofingFindings().map((f) => [f.from, f.to - f.from])).toHaveLength(1);
    expect(core.proofingFindings()[0]!.text).toBe('Plain');
  });
});

describe('UX-041 criterion 4: a slow or missing port never blocks typing', () => {
  it('leaves the state at checking while the port is slow, and typing goes on', async () => {
    const port: ProofingPort = {
      check: () => new Promise<ProofingFinding[]>(() => {}),
      addWord: () => Promise.resolve(),
    };
    const core = newCore();
    core.attachProofing(port, { clock: manualClock() });
    await settle();
    expect(core.proofing.get().state).toBe('checking');
    endOf(core, STYLE_IDS.plain);
    type(core, '!');
    expect(blockText(core, STYLE_IDS.plain)).toBe('Plain text!');
    expect(core.problem.get()).toBeNull();
  });

  it('shows unavailable quietly when the port rejects or throws, and tries again on the next change', async () => {
    let mode: 'reject' | 'throw' | 'ok' = 'reject';
    let calls = 0;
    const port: ProofingPort = {
      check: () => {
        calls++;
        if (mode === 'throw') throw new Error('port is down');
        if (mode === 'reject') return Promise.reject(new Error('503'));
        return Promise.resolve([]);
      },
      addWord: () => Promise.resolve(),
    };
    const clock = manualClock();
    const core = newCore();
    core.attachProofing(port, { clock });
    await settle();
    expect(core.proofing.get().state).toBe('unavailable');
    expect(core.problem.get()).toBeNull();
    expect(core.refusal.get()).toBeNull();
    mode = 'throw';
    endOf(core, STYLE_IDS.plain);
    type(core, 'a');
    clock.fire();
    await settle();
    expect(core.proofing.get().state).toBe('unavailable');
    mode = 'ok';
    type(core, 'b');
    clock.fire();
    await settle();
    expect(core.proofing.get().state).toBe('idle');
    expect(calls).toBe(3);
  });

  it('cancels the check in flight when a newer one starts', async () => {
    const signals: CancelSignal[] = [];
    const port: ProofingPort = {
      check: (_request, opts) => {
        if (opts?.signal) signals.push(opts.signal);
        return new Promise<ProofingFinding[]>(() => {});
      },
      addWord: () => Promise.resolve(),
    };
    const clock = manualClock();
    const core = newCore();
    core.attachProofing(port, { clock });
    endOf(core, STYLE_IDS.plain);
    type(core, 'a');
    clock.fire();
    expect(signals).toHaveLength(2);
    expect(signals[0]!.cancelled).toBe(true);
    expect(signals[1]!.cancelled).toBe(false);
  });
});

describe('UX-041 criterion 5: no port, no proofing', () => {
  it('reports no proofing and has nothing to move to', () => {
    const core = newCore();
    expect(core.proofing.get().available).toBe(false);
    expect(core.proofingStep(1)).toBe(false);
    expect(core.proofingFindings()).toEqual([]);
  });

  it('goes back to no proofing when the port is detached', async () => {
    const core = newCore();
    const detach = core.attachProofing(wordPort({}), { clock: manualClock() });
    await settle();
    expect(core.proofing.get().available).toBe(true);
    detach();
    expect(core.proofing.get().available).toBe(false);
  });
});

describe('UX-041 criterion 6: findings can be moved between and read as text', () => {
  it('moves the selection from finding to finding, wrapping, and reports the current one', async () => {
    const core = newCore();
    core.attachProofing(
      wordPort({ Introduction: ['Intro'], quotation: ['quote'], After: ['Before'] }),
      { clock: manualClock() },
    );
    await settle();
    expect(core.proofing.get().count).toBe(3);
    const doc = () => internals(core).state.doc;
    const selected = () => {
      const s = internals(core).state.selection;
      return doc().textBetween(s.from, s.to);
    };
    expect(core.proofingStep(1)).toBe(true);
    expect(selected()).toBe('Introduction');
    expect(core.proofing.get().current).toMatchObject({
      text: 'Introduction',
      kind: 'spelling',
      suggestions: ['Intro'],
    });
    expect(core.proofingStep(1)).toBe(true);
    expect(selected()).toBe('quotation');
    expect(core.proofingStep(1)).toBe(true);
    expect(selected()).toBe('After');
    expect(core.proofingStep(1)).toBe(true);
    expect(selected()).toBe('Introduction'); // wraps
    expect(core.proofingStep(-1)).toBe(true);
    expect(selected()).toBe('After'); // wraps backwards
    expect(core.proofing.get().atCaret?.text).toBe('After');
    const current = core.proofingCurrentId();
    const decorations = proofingDecorations(doc(), core.proofingFindings(), current).find();
    expect(
      decorations.filter((d) =>
        (d as unknown as { type: { attrs: { class: string } } }).type.attrs.class.includes(
          PROOF_CURRENT_CLASS,
        ),
      ),
    ).toHaveLength(1);
  });
});

describe('UX-041 criterion 7: findings are not part of the document', () => {
  it('queues no step and changes no confirmed content while findings come and go', async () => {
    const core = newCore();
    const confirmed = JSON.stringify(core.confirmedContent());
    const clock = manualClock();
    core.attachProofing(wordPort({ Plain: ['Plane'] }), { clock });
    await settle();
    expect(core.proofingFindings()).toHaveLength(1);
    core.proofingStep(1);
    expect(JSON.stringify(core.confirmedContent())).toBe(confirmed);
    expect(core.syncSnapshot().queue).toEqual([]);
    // No mark and no attribute of the document names a finding.
    expect(JSON.stringify(core.getContent())).not.toContain('de-finding');
    expect(JSON.stringify(core.getContent())).not.toContain('spelling');
  });
});

describe('UX-041 criterion 7 against the authority: no commit, version or history entry', () => {
  it('leaves the server head and its content where they were while findings come and go', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument());
    const head = service.document(docId)!.head;
    const before = JSON.stringify(service.document(docId)!.content());
    const m = await join(service, docId, 'ed', 'editor');
    await until(() => m.core.permissions.get() !== null, 'access');
    const clock = manualClock();
    m.core.attachProofing(wordPort({ world: ['earth'] }), { clock });
    await settle();
    expect(m.core.proofingFindings().map((f) => f.text)).toEqual(['world']);
    m.core.proofingStep(1);
    m.core.ignoreFinding(m.core.proofingFindings()[0]!.id);
    clock.fire();
    await settle();
    await m.core.flush();
    expect(service.document(docId)!.head).toBe(head);
    expect(JSON.stringify(service.document(docId)!.content())).toBe(before);
    m.detach();
    await service.dispose();
  });
});
