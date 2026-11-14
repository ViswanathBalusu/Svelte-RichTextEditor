/**
 * Links and bookmarks (FE-133 criteria 1 to 3). Criteria 4 (a link opens without an opener) and 5
 * (a referenced bookmark cannot be deleted silently) are not tested here: they need the web view
 * and cross-reference fields, which are not built.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addLink,
  bookmarkPositions,
  followInternalLink,
  insertBookmark,
  linkRefusalOf,
} from '../src/links-bookmarks.ts';
import { AUTH_IDS, authoringState, caretIn, inside, selectIn } from './authoring-doc.ts';

const always = () => true;

function linksIn(doc: ReturnType<typeof authoringState>['doc']): string[] {
  const out: string[] = [];
  doc.descendants((node) => {
    for (const mark of node.marks)
      if (mark.type.name === 'link') out.push(String(mark.attrs['href']));
    return true;
  });
  return out;
}

describe('links (FE-133 criterion 1)', () => {
  it('stores a link that the I9 schemes allow, on the selected text', () => {
    for (const href of [
      'https://example.org/a?b=c#d',
      'http://example.org/',
      'mailto:reader@example.org',
      '#Intro_1',
    ]) {
      const state = selectIn(authoringState(), AUTH_IDS.p1, 0, 5);
      const applied: { state: typeof state | null } = { state: null };
      const result = addLink(state, href, { writable: always }, (tr) => {
        applied.state = state.apply(tr);
      });
      expect(result).toEqual({ ok: true });
      expect(linksIn(applied.state!.doc)).toEqual([href]);
    }
  });

  it('refuses a scheme outside I9 with a reason, and leaves the text unmarked', () => {
    const state = selectIn(authoringState(), AUTH_IDS.p1, 0, 5);
    for (const href of [
      'javascript:alert(1)',
      'data:text/html,<p>x</p>',
      'vbscript:msgbox',
      'file:///etc/hosts',
      'ftp://example.org/file',
    ]) {
      let dispatched = false;
      const result = addLink(state, href, { writable: always }, () => {
        dispatched = true;
      });
      expect(result).toEqual({ ok: false, reason: 'scheme-not-allowed' });
      expect(dispatched).toBe(false);
    }
  });

  it('property: any other scheme is refused as not allowed, and allowed schemes are never refused', () => {
    const forbidden = fc.constantFrom(
      'javascript',
      'data',
      'vbscript',
      'file',
      'ftp',
      'blob',
      'tel',
    );
    fc.assert(
      fc.property(forbidden, fc.stringMatching(/^[a-z0-9]{0,12}$/), (scheme, rest) => {
        expect(linkRefusalOf(`${scheme}:${rest}`)).toBe('scheme-not-allowed');
      }),
    );
    fc.assert(
      fc.property(
        fc.constantFrom('https', 'http'),
        fc.stringMatching(/^[a-z0-9]{1,20}\.[a-z]{2,6}(\/[a-z0-9]{0,10}){0,3}$/),
        (scheme, host) => {
          expect(linkRefusalOf(`${scheme}://${host}`)).toBeNull();
        },
      ),
    );
  });

  it('refuses a malformed target and a selection that is empty', () => {
    expect(linkRefusalOf('https://exa mple.org')).toBe('malformed');
    expect(linkRefusalOf('#bad name')).toBe('malformed');
    const caret = caretIn(authoringState(), AUTH_IDS.p1, 2);
    expect(addLink(caret, 'https://example.org', { writable: always })).toEqual({
      ok: false,
      reason: 'no-selection',
    });
  });
});

describe('bookmarks (FE-133 criterion 2)', () => {
  it('creates an anchor with the given name at the caret', () => {
    const state = caretIn(authoringState(), AUTH_IDS.p2, 3);
    const applied: { state: typeof state | null } = { state: null };
    expect(
      insertBookmark(state, 'Summary_1', { writable: always }, (tr) => {
        applied.state = state.apply(tr);
      }),
    ).toEqual({ ok: true });
    expect(bookmarkPositions(applied.state!.doc).has('Summary_1')).toBe(true);
  });

  it('refuses a duplicate name anywhere in the document, and a name the CDM does not allow', () => {
    const first = insertBookmark(caretIn(authoringState(), AUTH_IDS.p1, 0), 'Intro', {
      writable: always,
    });
    expect(first).toEqual({ ok: true });
    const withIntro = caretIn(authoringState(), AUTH_IDS.p1, 0);
    const applied = { state: withIntro };
    insertBookmark(withIntro, 'Intro', { writable: always }, (tr) => {
      applied.state = withIntro.apply(tr);
    });
    expect(
      insertBookmark(caretIn(applied.state, AUTH_IDS.p2, 0), 'Intro', { writable: always }),
    ).toEqual({
      ok: false,
      reason: 'duplicate',
    });
    for (const name of ['1st', 'has space', '', 'x'.repeat(41)]) {
      expect(
        insertBookmark(caretIn(authoringState(), AUTH_IDS.p1, 0), name, { writable: always }),
      ).toEqual({
        ok: false,
        reason: 'bad-name',
      });
    }
  });

  it('property: every name the CDM pattern allows is accepted once and refused the second time', () => {
    const name = fc
      .tuple(
        fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_'.split('')),
        fc.stringMatching(/^[A-Za-z0-9_]{0,38}$/),
      )
      .map(([head, tail]) => head + tail);
    fc.assert(
      fc.property(name, (n) => {
        const once = insertBookmark(caretIn(authoringState(), AUTH_IDS.p1, 0), n, {
          writable: always,
        });
        expect(once).toEqual({ ok: true });
        const applied = { state: caretIn(authoringState(), AUTH_IDS.p1, 0) };
        insertBookmark(applied.state, n, { writable: always }, (tr) => {
          applied.state = applied.state.apply(tr);
        });
        expect(
          insertBookmark(caretIn(applied.state, AUTH_IDS.p2, 0), n, { writable: always }),
        ).toEqual({ ok: false, reason: 'duplicate' });
      }),
    );
  });

  it('refuses a bookmark inside a region the user cannot change', () => {
    const state = authoringState();
    const protectedFrom = inside(state.doc, AUTH_IDS.region);
    const writable = (pos: number) => pos < protectedFrom;
    expect(insertBookmark(caretIn(state, AUTH_IDS.inRegion, 1), 'Clause', { writable })).toEqual({
      ok: false,
      reason: 'read-only',
    });
  });
});

describe('following an in-document link (FE-133 criterion 3, bookmark targets)', () => {
  it('moves the caret to the bookmark, and reports a missing target', () => {
    // A bookmark in the second paragraph; the caret starts in the first.
    const withMark = { state: caretIn(authoringState(), AUTH_IDS.p2, 0) };
    insertBookmark(withMark.state, 'Target', { writable: always }, (tr) => {
      withMark.state = withMark.state.apply(tr);
    });
    const from = caretIn(withMark.state, AUTH_IDS.p1, 0);
    const moved = { state: from };
    expect(
      followInternalLink(from, '#Target', (tr) => {
        moved.state = from.apply(tr);
      }),
    ).toBe('moved');
    const target = bookmarkPositions(withMark.state.doc).get('Target')!;
    expect(moved.state.selection.from).toBe(target);
    expect(followInternalLink(from, '#Nowhere')).toBe('no-target');
    expect(followInternalLink(from, 'https://example.org')).toBe('not-internal');
  });
});
