/**
 * The assistant's context (UX-047; 13 §6.2). Node.js tests with a mock port that records what it
 * receives. Ticked on these: criterion 1 (the request holds the selection, the surrounding blocks
 * and the outline, plus only the host's attachments), criterion 2 (text of a scope the requester
 * cannot view is absent), criterion 3 (the recorded request carries no token, no other user's
 * profile and no content outside the named parts or the attachments), and criterion 4 (an attachment
 * is passed through unchanged and marked as supplied by the host).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  assembleContext,
  type AssistantContext,
  type ContextBlock,
  type ContextInput,
} from '../src/assistant/context.ts';

/** A port that records each request as it would be serialised for the model. */
function recordingPort() {
  const sent: string[] = [];
  return {
    sent,
    send(context: AssistantContext): void {
      sent.push(JSON.stringify(context));
    },
  };
}

const block = (id: string, scope: string, text: string): ContextBlock => ({ id, scope, text });

describe('assembleContext (UX-047 criteria 1 and 2)', () => {
  it('holds the selection, the surrounding blocks and the outline, and nothing else', () => {
    const ctx = assembleContext({
      selection: [block('b1', 's1', 'selected text')],
      surrounding: [block('b0', 's1', 'before'), block('b2', 's1', 'after')],
      outline: [{ id: 'h1', scope: 's1', text: 'Heading', level: 1 }],
      attachments: [],
      viewable: () => true,
    });
    expect(Object.keys(ctx).sort()).toEqual(
      ['attachments', 'omitted', 'outline', 'selection', 'surrounding'].sort(),
    );
    expect(ctx.selection).toEqual([{ id: 'b1', text: 'selected text' }]);
    expect(ctx.surrounding.map((b) => b.id)).toEqual(['b0', 'b2']);
    expect(ctx.outline).toEqual([{ id: 'h1', level: 1, text: 'Heading' }]);
    expect(ctx.omitted).toBe(0);
  });

  it('drops the text of every scope the requester cannot view, and counts what it dropped', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('s1', 's2', 's3'), { minLength: 1, maxLength: 12 }),
        fc.subarray(['s1', 's2', 's3']),
        (scopes, visible) => {
          const blocks = scopes.map((scope, i) => block(`b${i}`, scope, `text-of-${i}`));
          const input: ContextInput = {
            selection: blocks.slice(0, 1),
            surrounding: blocks.slice(1),
            outline: [{ id: 'h', scope: scopes[0] ?? 's1', text: 'HEADING-TEXT', level: 2 }],
            attachments: [],
            viewable: (scope) => visible.includes(scope),
          };
          const ctx = assembleContext(input);
          const out = JSON.stringify(ctx);
          blocks.forEach((b, i) => {
            if (!visible.includes(b.scope)) expect(out).not.toContain(`text-of-${i}"`);
            else expect(out).toContain(`text-of-${i}"`);
          });
          const hidden = scopes.filter((s) => !visible.includes(s)).length;
          const outlineHidden = visible.includes(scopes[0] ?? 's1') ? 0 : 1;
          expect(ctx.omitted).toBe(hidden + outlineHidden);
          if (!visible.includes(scopes[0] ?? 's1')) expect(out).not.toContain('HEADING-TEXT');
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('the request sent to the port (UX-047 criteria 3 and 4)', () => {
  it('carries no token, no other profile and no content outside the named parts', () => {
    const port = recordingPort();
    // The core may hold more than the assistant may see. The builder reads named fields only, so
    // anything else passed alongside is never serialised. The sentinels prove it.
    const input = {
      selection: [block('b1', 's1', 'visible selection')],
      surrounding: [],
      outline: [],
      attachments: [],
      viewable: () => true,
      session: { token: 'SENTINEL-TOKEN-7731' },
      otherProfile: { name: 'SENTINEL-PROFILE-4420' },
      unnamedContent: 'SENTINEL-CONTENT-9182',
    } as ContextInput;
    port.send(assembleContext(input));
    const [recorded] = port.sent;
    expect(recorded).toContain('visible selection');
    expect(recorded).not.toContain('SENTINEL-TOKEN-7731');
    expect(recorded).not.toContain('SENTINEL-PROFILE-4420');
    expect(recorded).not.toContain('SENTINEL-CONTENT-9182');
  });

  it('passes an attachment through unchanged and marks it as supplied by the host', () => {
    const attachment = { id: 'att-1', label: 'Style guide', text: '  Use the house tone.\n\n' };
    const ctx = assembleContext({
      selection: [],
      surrounding: [],
      outline: [],
      attachments: [attachment],
      viewable: () => false,
    });
    expect(ctx.attachments).toEqual([{ source: 'host', ...attachment }]);
    expect(ctx.attachments[0]?.text).toBe(attachment.text);
  });
});
