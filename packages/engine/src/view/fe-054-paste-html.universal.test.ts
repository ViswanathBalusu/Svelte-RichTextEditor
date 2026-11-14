/**
 * Clipboard HTML read through the whitelist (FE-054 criteria 1 to 3 and 6, the part built so far).
 * `fragmentFromHtmlString` parses the HTML into an inert document with `DOMParser`, and a paste event on
 * the body web view takes the result through `pasteFromClipboard`.
 *
 * Runs in real browser engines through `pnpm vitest run --project browser <this file>`
 * (`DOCEDIT_BROWSERS=chromium,firefox,webkit` for all three). Skipped in Node.js, which has no DOM.
 * Not covered here: Trusted Types enforcement (criterion 5), the Word and Google Docs corpus and headings
 * as heading styles (criterion 4), and pictures inside pasted HTML (criterion 6, FE-053 notes).
 */
import type { Access } from '@docedit/protocol';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { styledDocument, styledEditorAccess } from '../../test/fixtures.ts';
import { fragmentFromHtmlString } from '../clipboard-html.ts';
import { internals } from '../testing.ts';
import { EditorCore } from './web.ts';

const isBrowser = typeof document !== 'undefined' && typeof DataTransfer !== 'undefined';

/** Whether a synthetic paste event keeps the data it was built with (Firefox does not; see fe-052). */
function syntheticPasteReads(): boolean {
  if (!isBrowser) return false;
  let seen = '';
  const probe = document.createElement('div');
  probe.addEventListener('paste', (e) => {
    seen = (e as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
  });
  const data = new DataTransfer();
  data.setData('text/plain', 'x');
  probe.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  return seen === 'x';
}

const itReads = syntheticPasteReads() ? it : it.skip;

interface Read {
  readonly text: string;
  readonly marks: readonly string[];
  readonly href: string | null;
}

/** The text nodes of a fragment's paragraphs, with their mark types and link target. */
function readRuns(fragment: NonNullable<ReturnType<typeof fragmentFromHtmlString>>): Read[] {
  const runs: Read[] = [];
  for (const block of fragment.content) {
    for (const node of block.content ?? []) {
      runs.push({
        text: node.text ?? '',
        marks: (node.marks ?? []).map((m) => m.type),
        href:
          ((node.marks ?? []).find((m) => m.type === 'link')?.attrs?.['href'] as
            string | undefined) ?? null,
      });
    }
  }
  return runs;
}

function clipboard(text: string, html: string): DataTransfer {
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  dt.setData('text/html', html);
  return dt;
}

function mounted(access: Access = styledEditorAccess()) {
  const host = document.createElement('div');
  document.body.append(host);
  const core = new EditorCore({
    doc: styledDocument(),
    access,
    schedule: (run) => queueMicrotask(run),
  });
  const unmount = core.mountBody(host);
  const surface = document.querySelector<HTMLElement>('.de-editing-surface');
  if (!surface) throw new Error('the body surface was not mounted');
  return {
    core,
    surface,
    cleanup() {
      unmount();
      core.destroy();
      host.remove();
    },
  };
}

describe.skipIf(!isBrowser)('HTML read through the whitelist (FE-054 criteria 1 to 3)', () => {
  it('keeps the text and bold of allowed elements and drops scripts, frames and handlers', () => {
    const fragment = fragmentFromHtmlString(
      '<p>Keep <b>this</b></p><script>alert(1)</script><iframe src="https://example.com/"></iframe><p onclick="x()">Next</p>',
      1,
    );
    expect(fragment).not.toBeNull();
    const json = JSON.stringify(fragment);
    expect(json).not.toContain('alert');
    expect(json).not.toContain('iframe');
    expect(json).not.toContain('onclick');
    expect(fragment!.content.map((b) => (b.content ?? []).map((n) => n.text).join(''))).toEqual([
      'Keep this',
      'Next',
    ]);
    expect(readRuns(fragment!)[1]).toEqual({ text: 'this', marks: ['bold'], href: null });
  });

  it('drops a link whose scheme is not allowed and keeps its text (I9)', () => {
    const fragment = fragmentFromHtmlString(
      '<p><a href="javascript:alert(1)">bad</a> <a href="https://example.com/x">good</a> <a href="mailto:a@example.com">mail</a></p>',
      1,
    );
    expect(fragment).not.toBeNull();
    const runs = readRuns(fragment!);
    expect(runs.find((r) => r.text === 'bad')?.marks).toEqual([]);
    expect(runs.find((r) => r.text === 'good')).toMatchObject({
      marks: ['link'],
      href: 'https://example.com/x',
    });
    expect(runs.find((r) => r.text === 'mail')?.href).toBe('mailto:a@example.com');
    expect(JSON.stringify(fragment)).not.toContain('javascript:');
  });

  it('keeps no picture, attribute or style, and gives nothing for HTML with no text', () => {
    const fragment = fragmentFromHtmlString(
      '<img src="https://example.com/p.png" alt="p"><p style="color:red" class="c">after</p>',
      1,
    );
    expect(fragment!.content).toHaveLength(1);
    expect(JSON.stringify(fragment)).not.toMatch(/example\.com|color|class/);
    expect(fragmentFromHtmlString('<script>only</script>   ', 1)).toBeNull();
  });

  itReads(
    'a paste of HTML with bold and a link puts that structure into the document',
    async () => {
      const { core, surface, cleanup } = mounted();
      try {
        const ic = internals(core);
        let caret = 0;
        ic.state.doc.descendants((node, pos) => {
          if (caret === 0 && node.isTextblock && node.textContent.length > 0) caret = pos + 1;
          return caret === 0;
        });
        ic.dispatch(ic.state.tr.setSelection(TextSelection.create(ic.state.doc, caret)));
        const event = new ClipboardEvent('paste', {
          clipboardData: clipboard(
            'Alpha bold\nBeta',
            '<p>Alpha <b>bold</b> <a href="https://example.com/">site</a></p><script>x()</script><p>Beta</p>',
          ),
          bubbles: true,
          cancelable: true,
        });
        surface.dispatchEvent(event);
        await new Promise((r) => setTimeout(r, 20));
        const doc = internals(core).state.doc;
        const marks: string[] = [];
        let text = '';
        doc.descendants((node) => {
          if (node.isText) {
            text += node.text ?? '';
            for (const m of node.marks) marks.push(`${m.type.name}:${node.text}`);
          }
          return true;
        });
        expect(text).toContain('Beta');
        expect(text).not.toContain('x()');
        expect(marks).toContain('bold:bold');
        expect(marks.some((m) => m.startsWith('link:'))).toBe(true);
      } finally {
        cleanup();
      }
    },
  );
});
