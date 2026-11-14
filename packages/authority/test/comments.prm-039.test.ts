// PRM-039 criterion 3 (lane authority-2): editing or deleting a comment needs its author or
// `manage` (05 §6.2; 07 §12 row 5). The thread-level rules are in threads.test.ts; these cases
// pin the comment-level edit, which that file did not exercise.
import { describe, expect, it } from 'vitest';
import { computeAccess } from '../src/permissions/access.ts';
import { authoriseComment } from '../src/permissions/comments.ts';
import type { Connection } from '../src/permissions/model.ts';
import { USERS } from './fixtures.ts';
import { MORE, morePermissions } from './permission-fixtures.ts';

const ctx = (conn: Connection, opts: { commentAuthor?: string; archived?: boolean } = {}) => ({
  access: computeAccess(conn, [], morePermissions(), 0),
  user: conn.sub,
  scopes: ['body'],
  archived: opts.archived ?? false,
  commentAuthor: opts.commentAuthor ?? 'cora',
});

describe('editing a comment (PRM-039 criterion 3)', () => {
  it('lets the comment’s author edit it, and refuses a commenter who is not the author', () => {
    expect(authoriseComment(ctx(MORE.cora), 'edit').ok).toBe(true);
    const other = authoriseComment(ctx(USERS.carol), 'edit');
    expect(other).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(other.ok === false && other.reason).toMatch(/editing a comment needs its author/);
  });

  it('lets a holder of manage edit any comment', () => {
    expect(authoriseComment(ctx(USERS.alice), 'edit').ok).toBe(true);
  });

  it('refuses the edit of a comment on an archived document with read_only', () => {
    expect(authoriseComment({ ...ctx(MORE.cora), archived: true }, 'edit')).toMatchObject({
      ok: false,
      code: 'read_only',
    });
  });

  it('refuses the edit of a comment the caller cannot see, as not_found', () => {
    expect(authoriseComment({ ...ctx(MORE.cora), scopes: [] }, 'edit')).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });
});
