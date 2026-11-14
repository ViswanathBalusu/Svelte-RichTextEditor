/**
 * The comment box's text model (`shell/comment-composer.ts`) and the command state and refusal
 * mapping of `shell/comment-create.ts` that the box and the comment command use (UX-028, UX-031).
 * The box itself is run in the browser (e2e/comments.spec.ts).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bodyParts, placeMention } from '../src/shell/comment-composer.ts';
import { commentCommandState, serverRefusal } from '../src/shell/comment-create.ts';
import { mentionTrigger, insertMention } from '../src/shell/mention-picker.ts';

describe('placing a chosen mention in the text', () => {
  it('replaces the trigger with @name and a space, and puts the caret after it', () => {
    const text = 'Ask @Gr now';
    const caret = 'Ask @Gr'.length;
    const trigger = mentionTrigger(text, caret)!;
    const chosen = insertMention(text, trigger, caret, { type: 'mention', principal: 'user:u2' });
    expect(placeMention(chosen.parts, 'Grace Hopper')).toEqual({
      text: 'Ask @Grace Hopper now',
      caret: 'Ask @Grace Hopper'.length,
      mention: { principal: 'user:u2', label: '@Grace Hopper' },
    });
  });

  it('adds a space when the text after the caret does not start with one', () => {
    const chosen = insertMention('@Gr', { start: 0, fragment: 'Gr' }, 3, {
      type: 'mention',
      principal: 'user:u2',
    });
    expect(placeMention(chosen.parts, 'Grace Hopper')?.text).toBe('@Grace Hopper ');
  });

  it('gives null for parts without a mention', () => {
    expect(placeMention([{ type: 'text', text: 'plain' }], 'x')).toBeNull();
  });
});

describe('the body posted for the text and its mentions', () => {
  it('turns each intact mention into a node holding the principal only', () => {
    const body = bodyParts('Please ask @Grace Hopper to check.', [
      { principal: 'user:u2', label: '@Grace Hopper' },
    ]);
    expect(body).toEqual([
      { type: 'text', text: 'Please ask ' },
      { type: 'mention', principal: 'user:u2' },
      { type: 'text', text: ' to check.' },
    ]);
  });

  it('keeps a mention whose text was edited as plain text', () => {
    expect(
      bodyParts('Ask @Grace Hoppers', [{ principal: 'user:u2', label: '@Grace Hopper' }]),
    ).toEqual([{ type: 'text', text: 'Ask @Grace Hoppers' }]);
  });

  it('places mentions in text order, each once', () => {
    const body = bodyParts('@Legal team and @Ada Lovelace', [
      { principal: 'user:u1', label: '@Ada Lovelace' },
      { principal: 'group:legal', label: '@Legal team' },
    ]);
    expect(body).toEqual([
      { type: 'mention', principal: 'group:legal' },
      { type: 'text', text: ' and ' },
      { type: 'mention', principal: 'user:u1' },
    ]);
  });

  it('gives back the typed text exactly when the mentions are put back as their labels (property)', () => {
    const name = fc.stringMatching(/^[A-Z][a-z]{1,6}$/);
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.stringMatching(/^[a-z .]{0,8}$/), name), { maxLength: 6 }),
        (pieces) => {
          // Every second piece is a mention; text pieces are separated from mentions by spaces.
          const mentions = pieces
            .filter((_, i) => i % 2 === 1)
            .map((n) => ({ principal: `user:${n}`, label: `@${n}` }));
          const text = pieces.map((p, i) => (i % 2 === 1 ? ` @${p} ` : p)).join('');
          const body = bodyParts(text, mentions);
          const back = body
            .map((p) => (p.type === 'text' ? p.text : `@${p.principal.slice(5)}`))
            .join('');
          expect(back).toBe(text);
          expect(body.filter((p) => p.type === 'mention')).toHaveLength(mentions.length);
          for (const p of body)
            if (p.type === 'mention') expect(Object.keys(p).sort()).toEqual(['principal', 'type']);
        },
      ),
    );
  });
});

describe('the comment command state and the service refusals (UX-028 criterion 3)', () => {
  it('is disabled without an anchor, or without comment in a covered scope', () => {
    expect(commentCommandState(null)).toEqual({ allowed: false, reason: 'noCommentTarget' });
    expect(commentCommandState({ scopes: [['view', 'comment'], ['view']] })).toEqual({
      allowed: false,
      reason: 'noComment',
    });
    expect(commentCommandState({ scopes: [['view', 'comment']] })).toEqual({ allowed: true });
  });

  it('maps the service codes of 05 §5.8 to the refusals the box states', () => {
    expect(serverRefusal('permission_denied')).toBe('permissionsChanged');
    expect(serverRefusal('stale_base')).toBe('baseSeqOutOfWindow');
    expect(serverRefusal('threadLimit')).toBe('threadLimit');
    expect(serverRefusal('internal')).toBe('failed');
  });
});
