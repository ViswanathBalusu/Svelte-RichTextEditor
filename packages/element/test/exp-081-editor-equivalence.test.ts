/**
 * EXP-081 criterion 6: the text of a document accepted in the editor is the text of the same
 * document exported with `suggestions: accept`. The editor side is the real core
 * (`DocumentCore.resolveSuggestions('accept', 'document')`, FE-047); the export side is the
 * Markdown and HTML writers of `@docedit/export-latex`, which share the suggestion rules of the
 * converter (`settleSuggestions`, `visibility`). The PDF itself is not compiled here.
 */
import type { CdmEnvelope } from '@docedit/model';
import { DocumentCore } from '@docedit/engine/headless';
import { SPIKE_IDS, spikeDocument } from '@docedit/engine/spike-document';
import { htmlText, markdownText } from '@docedit/export-latex';
import { describe, expect, it } from 'vitest';

interface JsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

const mark = (type: 'ins' | 'del', id: string) => ({ type, attrs: { id, user: 'alice' } });
const run = (text: string, marks?: JsonNode['marks']): JsonNode =>
  marks ? { type: 'text', text, marks } : { type: 'text', text };
/** A paragraph; its suggestions are in the `suggest` attribute (03 §5; owner decision 92). */
const paragraph = (id: string, content: JsonNode[], suggest?: JsonNode['marks']): JsonNode => ({
  type: 'paragraph',
  attrs: suggest ? { id, suggest } : { id },
  content,
});

function find(n: JsonNode, id: string): JsonNode | null {
  if (n.attrs?.['id'] === id) return n;
  for (const c of n.content ?? []) {
    const r = find(c, id);
    if (r) return r;
  }
  return null;
}

/** The spike document with a deleted run, an inserted run, a deleted paragraph and an inserted one. */
function suggested(): CdmEnvelope {
  const env = spikeDocument();
  const root = env.doc as unknown as JsonNode;
  const intro = find(root, SPIKE_IDS.intro)!;
  const rest = (intro.content ?? []).filter((c) => c.type !== 'text');
  intro.content = [
    run('Alpha '),
    run('bravo ', [mark('del', 'sDelRun0000000001')]),
    run('new ', [mark('ins', 'sInsRun0000000001')]),
    run('charlie'),
    ...rest,
  ];
  const body = root.content!.find((c) => c.type === 'body')!;
  const at = body.content!.findIndex((c) => c.attrs?.['id'] === SPIKE_IDS.title);
  body.content!.splice(
    at + 1,
    0,
    paragraph('pDelBlock00000001', [run('Struck paragraph.')], [mark('del', 'sDelBlk0000000001')]),
    paragraph('pInsBlock00000001', [run('Added paragraph.')], [mark('ins', 'sInsBlk0000000001')]),
  );
  return env as CdmEnvelope;
}

describe('EXP-081 an export with accept reads as the editor reads after accept', () => {
  it('gives the same Markdown and the same HTML', () => {
    const env = suggested();
    const core = new DocumentCore({ doc: structuredClone(env), schedule: queueMicrotask });
    const report = core.resolveSuggestions('accept', 'document');
    expect(report.handled).toBeGreaterThanOrEqual(4);
    expect(report.skipped).toBe(0);
    const edited = core.getContent() as CdmEnvelope;
    core.destroy();

    const exported = markdownText(env, { suggestions: 'accept' });
    const reference = markdownText(edited, { suggestions: 'accept' });
    expect(exported.text).toBe(reference.text);
    expect(exported.text).toContain('Alpha new charlie');
    expect(exported.text).toContain('Added paragraph.');
    expect(exported.text).not.toContain('Struck paragraph.');
    expect(exported.text).not.toContain('bravo');

    expect(htmlText(env, { suggestions: 'accept' }).text).toBe(
      htmlText(edited, { suggestions: 'accept' }).text,
    );
  });

  it('leaves the document it exports as it was', () => {
    const env = suggested();
    const before = JSON.stringify(env);
    markdownText(env, { suggestions: 'accept' });
    expect(JSON.stringify(env)).toBe(before);
  });
});
