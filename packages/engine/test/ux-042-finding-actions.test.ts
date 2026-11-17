/**
 * UX-042: acting on a finding (13 §6.1): apply a suggestion as an ordinary edit, ignore it once or
 * everywhere, keep a word in the port's custom dictionary, and check again when the language of a
 * range changes. The core is given a mock port and a stepped clock; the suggestion-mode case joins
 * the mock service (the real authority room) as a member who may only suggest. Node.js, no DOM.
 */
import type { ProofingFinding } from '@docedit/protocol';
import { contractDocument } from '@docedit/protocol/contract';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import type { DocumentCore } from '../src/headless.ts';
import type { ProofingPort } from '../src/proofing.ts';
import { internals } from '../src/testing.ts';
import { STYLE_IDS } from './fixtures.ts';
import { blockText, endOf, manualClock, newCore, settle, wordPort } from './proofing-support.ts';
import { join, newService, posOf, type, until } from './support.ts';

/** A port whose checks follow a word list per language, and whose custom dictionary is kept in a set. */
function languagePort(bad: Record<string, Record<string, string[]>>) {
  const dictionary = new Map<string, Set<string>>();
  const requests: Array<{ blockId: string; lang: string }> = [];
  const port: ProofingPort = {
    check(request) {
      const found: ProofingFinding[] = [];
      for (const block of request.blocks) {
        requests.push({ blockId: block.blockId, lang: block.lang });
        for (const m of block.text.matchAll(/[\p{L}']+/gu)) {
          if (dictionary.get(block.lang)?.has(m[0])) continue;
          const suggestions = bad[block.lang]?.[m[0]];
          if (suggestions === undefined) continue;
          found.push({
            blockId: block.blockId,
            from: m.index,
            to: m.index + m[0].length,
            kind: 'spelling',
            message: m[0],
            suggestions,
          });
        }
      }
      return Promise.resolve(found);
    },
    addWord(word, lang) {
      const set = dictionary.get(lang) ?? new Set<string>();
      set.add(word);
      dictionary.set(lang, set);
      return Promise.resolve();
    },
    listWords: (lang) => Promise.resolve([...(dictionary.get(lang) ?? [])].sort()),
    removeWord(word, lang) {
      dictionary.get(lang)?.delete(word);
      return Promise.resolve();
    },
  };
  return { port, requests, dictionary };
}

const text = (core: DocumentCore, id: string): string => blockText(core, id);

describe('UX-042 criterion 1: the actions on a finding', () => {
  it('applies a suggestion at the finding, and the finding is gone', async () => {
    const core = newCore();
    core.attachProofing(wordPort({ Plain: ['Plane', 'Plan'] }), { clock: manualClock() });
    await settle();
    const [finding] = core.proofingFindings();
    expect(finding?.text).toBe('Plain');
    expect(core.applyFinding(finding!.id, 1)).toBe(true);
    expect(text(core, STYLE_IDS.plain)).toBe('Plan text');
    expect(core.proofingFindings()).toEqual([]);
  });

  it('ignores one occurrence only, and ignores a word everywhere', async () => {
    const core = newCore();
    const clock = manualClock();
    core.attachProofing(wordPort({ text: ['txt'] }), { clock });
    await settle();
    // "Plain text" and "Protected text" and "A quotation": "text" twice in the styled document.
    const before = core.proofingFindings().filter((f) => f.text === 'text');
    expect(before).toHaveLength(2);
    expect(core.ignoreFinding(before[0]!.id)).toBe(true);
    const afterOnce = core.proofingFindings().filter((f) => f.text === 'text');
    expect(afterOnce.map((f) => f.id)).toEqual([before[1]!.id]);
    // It stays ignored after another change to the same paragraph (the same word, the same place).
    endOf(core, before[0]!.blockId);
    type(core, '!');
    clock.fire();
    await settle();
    expect(core.proofingFindings().filter((f) => f.text === 'text')).toHaveLength(1);
    expect(core.ignoreFinding(before[1]!.id, true)).toBe(true);
    expect(core.proofingFindings().filter((f) => f.text === 'text')).toEqual([]);
  });

  it('keeps ignore-everywhere to its language', async () => {
    const lp = languagePort({
      'en-GB': { Plain: ['Plane'] },
      'fr-FR': { Plain: ['Plan'] },
    });
    const core = newCore();
    const clock = manualClock();
    core.attachProofing(lp.port, { clock });
    await settle();
    const f = core.proofingFindings()[0]!;
    core.ignoreFinding(f.id, true);
    expect(core.proofingFindings()).toEqual([]);
    // The same word in another language is a different finding (criterion 4 sets the language).
    const i = internals(core);
    const start = posOf(i.state.doc, STYLE_IDS.plain) + 1;
    i.dispatch(
      i.state.tr.setSelection(
        TextSelection.create(i.state.doc, start, start + 'Plain text'.length),
      ),
    );
    core.run('lang', { lang: 'fr-FR' });
    clock.fire();
    await settle();
    expect(core.proofingFindings().map((x) => x.lang)).toEqual(['fr-FR']);
  });
});

describe('UX-042 criterion 2: applying is an ordinary edit through the guards', () => {
  it('is not offered, and is refused, in a scope the user may not change', async () => {
    const core = newCore();
    core.attachProofing(wordPort({ Protected: ['Protect'] }), { clock: manualClock() });
    await settle();
    const [finding] = core.proofingFindings();
    expect(finding?.scope).toBe(`region:${STYLE_IDS.region}`);
    expect(core.canApplyFinding(finding!.id)).toBe(false);
    const before = JSON.stringify(core.getContent());
    expect(core.applyFinding(finding!.id)).toBe(false);
    expect(JSON.stringify(core.getContent())).toBe(before);
    expect(core.refusal.get()?.scopes).toEqual([`region:${STYLE_IDS.region}`]);
  });

  it('is not offered, and is refused, in view mode', async () => {
    const core = newCore();
    core.attachProofing(wordPort({ Plain: ['Plane'] }), { clock: manualClock() });
    await settle();
    const [finding] = core.proofingFindings();
    expect(core.canApplyFinding(finding!.id)).toBe(true);
    core.setMode('view');
    expect(core.canApplyFinding(finding!.id)).toBe(false);
    expect(core.applyFinding(finding!.id)).toBe(false);
    expect(text(core, STYLE_IDS.plain)).toBe('Plain text');
  });

  it('is not offered without a suggestion', async () => {
    const core = newCore();
    core.attachProofing(wordPort({ Plain: [] }), { clock: manualClock() });
    await settle();
    expect(core.canApplyFinding(core.proofingFindings()[0]!.id)).toBe(false);
  });

  it('becomes a suggestion for a member who may only suggest, and the authority accepts it', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument());
    const head = service.document(docId)!.head;
    const sam = await join(service, docId, 'sam', 'suggester', { user: 'sam' });
    await until(() => sam.core.permissions.get() !== null, 'access');
    const port = wordPort({ world: ['earth'] });
    sam.core.attachProofing(port, { clock: manualClock() });
    await settle();
    const [finding] = sam.core.proofingFindings();
    expect(finding?.text).toBe('world');
    expect(sam.core.canApplyFinding(finding!.id)).toBe(true);
    expect(sam.core.applyFinding(finding!.id)).toBe(true);
    await until(() => sam.core.saveState.get() === 'saved', 'saved');
    expect(sam.core.recovered.get().count).toBe(0);
    expect(service.document(docId)!.head).toBeGreaterThan(head);
    const doc = JSON.stringify(service.document(docId)!.content().doc);
    // The old word stays with a deletion mark and the new one carries an insertion mark.
    expect(doc).toContain('"type":"del"');
    expect(doc).toContain('"type":"ins"');
    expect(doc).toContain('earth');
    expect(doc).toContain('world');
    sam.detach();
    await service.dispose();
  });
});

describe('UX-042 criterion 3: custom dictionaries', () => {
  it('adds, lists and removes words, and later checks honour them', async () => {
    const lp = languagePort({ 'en-GB': { Plain: ['Plane'] } });
    const core = newCore();
    core.attachProofing(lp.port, { clock: manualClock() });
    await settle();
    expect(core.proofing.get().dictionary).toBe(true);
    const [finding] = core.proofingFindings();
    expect(await core.addFindingToDictionary(finding!.id)).toBe(true);
    await settle();
    expect(core.proofingFindings()).toEqual([]);
    expect(await core.dictionaryWords('en-GB')).toEqual(['Plain']);
    expect(await core.removeDictionaryWord('Plain', 'en-GB')).toBe(true);
    await settle();
    expect(core.proofingFindings().map((f) => f.text)).toEqual(['Plain']);
    expect(await core.dictionaryWords('en-GB')).toEqual([]);
  });

  it('offers nothing for a port that cannot list or remove words', async () => {
    const core = newCore();
    core.attachProofing(wordPort({ Plain: ['Plane'] }), { clock: manualClock() });
    await settle();
    expect(core.proofing.get().dictionary).toBe(false);
    expect(await core.addFindingToDictionary(core.proofingFindings()[0]!.id)).toBe(false);
    expect(await core.dictionaryWords('en-GB')).toBeNull();
    expect(await core.removeDictionaryWord('Plain', 'en-GB')).toBe(false);
  });

  it('reports the port as unavailable, quietly, when adding a word fails', async () => {
    const lp = languagePort({ 'en-GB': { Plain: ['Plane'] } });
    const port: ProofingPort = { ...lp.port, addWord: () => Promise.reject(new Error('503')) };
    const core = newCore();
    core.attachProofing(port, { clock: manualClock() });
    await settle();
    expect(await core.addFindingToDictionary(core.proofingFindings()[0]!.id)).toBe(false);
    expect(core.proofing.get().state).toBe('unavailable');
    expect(core.problem.get()).toBeNull();
  });
});

describe('UX-042 criterion 4: a new language gives new findings', () => {
  it('checks the range again in the language the command set', async () => {
    const lp = languagePort({
      'en-GB': { Plain: ['Plane'] },
      'fr-FR': { text: ['texte'] },
    });
    const core = newCore();
    const clock = manualClock();
    core.attachProofing(lp.port, { clock });
    await settle();
    expect(core.proofingFindings().map((f) => [f.text, f.lang])).toEqual([['Plain', 'en-GB']]);
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
    expect(lp.requests[lp.requests.length - 1]).toEqual({
      blockId: STYLE_IDS.plain,
      lang: 'fr-FR',
    });
    expect(core.proofingFindings().map((f) => [f.text, f.lang])).toEqual([['text', 'fr-FR']]);
  });
});
