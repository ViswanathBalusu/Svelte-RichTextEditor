/**
 * Assigning a thread as a task (UX-032 criteria 1, 2, 3 (the pane's filter), 4 and 5; lane w3). The
 * threads come from the harness's threads port, which answers like the service with versions; the
 * host's directory answers `searchPrincipals` and `resolveUsers`. The `dep.task.assigned` event is
 * the service's: it is tested in services/document-service/test/control-plane/ux-032-task-assigned.test.ts.
 */
import type { Page } from '@playwright/test';
import type { ThreadDetail, ThreadSummary } from '../src/core-api.ts';
import { axe, expect, open, test } from './helpers.ts';

const RANGE = { range: { from: 3, to: 12, baseSeq: 41 } } as const;

function summary(id: string, position: number, over: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id,
    position,
    state: 'open',
    author: 'Ada Lovelace',
    createdAt: '2026-11-10T09:15:00.000Z',
    replyCount: 0,
    assignee: null,
    target: RANGE,
    excerpt: 'Check this sentence.',
    blockKind: null,
    ...over,
  };
}

function detail(
  id: string,
  over: Partial<Omit<ThreadDetail, 'etag'>> = {},
): Omit<ThreadDetail, 'etag'> {
  return {
    id,
    state: 'open',
    author: 'user:u1',
    detached: false,
    assignee: null,
    caps: ['view', 'comment'],
    comments: [
      {
        id: 'c1',
        author: 'user:u1',
        createdAt: '2026-11-10T09:15:00.000Z',
        body: [{ type: 'text', text: 'Please check.' }],
        edited: false,
      },
    ],
    ...over,
  };
}

async function openThread(page: Page, caps: ThreadDetail['caps'] = ['view', 'comment']) {
  const h = await open(page, { extended: true, comments: true, commentsPane: true });
  await h.setThreads([summary('t1', 10), summary('t2', 20, { assignee: 'user:u1' })]);
  await h.putThreads([detail('t1', { caps }), detail('t2', { assignee: 'user:u1' })]);
  expect(await h.exec('view.comments')).toEqual({ ran: true, reason: null });
  const pane = page.locator('.de-pane[data-pane="comments"]');
  await pane.locator('li[data-thread="t1"] [data-thread-open]').click();
  const view = pane.locator('[data-thread-view="t1"]');
  await expect(view).toBeVisible();
  return { h, pane, view };
}

const status = (page: Page) => page.locator('.de-shell > [role="status"]');

test.describe('assigning a thread (UX-032 criterion 1)', () => {
  test('a person found with searchPrincipals is set as the assignee, shown as a task, by keyboard', async ({
    page,
  }) => {
    const { h, view } = await openThread(page);
    await expect(view.locator('[data-assignee]')).toHaveText('Not assigned to anyone.');
    const field = view.getByRole('combobox', { name: 'Assign to' });
    await field.focus();
    await page.keyboard.type('Gr');
    const options = view.getByRole('option');
    await expect(options).toHaveText(['Grace Hopper']);
    await expect(field).toHaveAttribute('aria-expanded', 'true');
    await expect(field).toHaveAttribute('aria-activedescendant', /.+/);
    expect(await h.principalQueries()).toContainEqual({
      text: 'Gr',
      purpose: 'participant',
      docId: 'd1',
    });
    expect(await axe(page)).toEqual([]);
    await page.keyboard.press('Enter');
    // One write, with the version the view was drawn from.
    const writes = (await h.threadWrites()) as Array<Record<string, unknown>>;
    expect(writes).toEqual([
      { op: 'assign', id: 't1', etag: expect.any(String), assignee: 'user:u2' },
    ]);
    await expect(view.locator('[data-assignee]')).toHaveText('Task, assigned to Grace Hopper.');
    await expect(status(page)).toHaveText('Thread assigned.');
    await expect(field).toHaveValue('');
    // Nothing of the document changed: assigning is a control-plane request, not a commit.
    expect(await h.runs()).toEqual([]);
  });

  test('a person with no comment in the thread is not offered the field', async ({ page }) => {
    const { view } = await openThread(page, ['view']);
    await expect(view.locator('[data-assignee]')).toHaveText('Not assigned to anyone.');
    await expect(view.getByRole('combobox')).toHaveCount(0);
  });

  test('a host without searchPrincipals cannot assign, and the task is still shown', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      comments: true,
      commentsPane: true,
      principals: 'none',
    });
    await h.setThreads([summary('t1', 10, { assignee: 'user:u2' })]);
    await h.putThreads([detail('t1', { assignee: 'user:u2' })]);
    expect(await h.exec('view.comments')).toEqual({ ran: true, reason: null });
    const pane = page.locator('.de-pane[data-pane="comments"]');
    await pane.locator('li[data-thread="t1"] [data-thread-open]').click();
    const view = pane.locator('[data-thread-view="t1"]');
    await expect(view.getByRole('combobox')).toHaveCount(0);
    await expect(view.locator('[data-assignee]')).toHaveText('Task, assigned to Grace Hopper.');
  });
});

test.describe('reassigning and clearing, live (UX-032 criterion 2)', () => {
  test("reassign and clear change the view, and another client's change appears without a reload", async ({
    page,
  }) => {
    const { h, pane, view } = await openThread(page);
    const field = view.getByRole('combobox', { name: 'Assign to' });
    await field.fill('Gr');
    await view.getByRole('option', { name: 'Grace Hopper' }).click();
    await expect(view.locator('[data-assignee]')).toHaveText('Task, assigned to Grace Hopper.');
    // Reassign to Ada.
    await field.fill('Ad');
    await view.getByRole('option', { name: 'Ada Lovelace' }).click();
    await expect(view.locator('[data-assignee]')).toHaveText('Task, assigned to Ada Lovelace.');
    // Clear.
    await view.getByRole('button', { name: 'Clear assignee' }).click();
    await expect(view.locator('[data-assignee]')).toHaveText('Not assigned to anyone.');
    await expect(status(page)).toHaveText('Assignee cleared.');
    await expect(view.getByRole('button', { name: 'Clear assignee' })).toHaveCount(0);
    const ops = ((await h.threadWrites()) as Array<{ op: string; assignee: string | null }>).map(
      (w) => [w.op, w.assignee],
    );
    expect(ops).toEqual([
      ['assign', 'user:u2'],
      ['assign', 'user:u1'],
      ['assign', null],
    ]);

    // Another client assigns it, then clears it: the open view follows.
    await h.remoteAssign('t1', 'user:u2');
    await expect(view.locator('[data-assignee]')).toHaveText('Task, assigned to Grace Hopper.');
    await h.remoteAssign('t1', null);
    await expect(view.locator('[data-assignee]')).toHaveText('Not assigned to anyone.');
    // And the list shows it too.
    await h.remoteAssign('t1', 'user:u2');
    await view.getByRole('button', { name: 'Back to the list' }).click();
    await expect(pane.locator('li[data-thread="t1"] [data-assignee]')).toHaveText(
      'Task, assigned to Grace Hopper.',
    );
  });
});

test.describe('the assignee in the pane (UX-032 criteria 3 and 5)', () => {
  test('the pane filters by the person the thread is assigned to, named as text', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, comments: true, commentsPane: true });
    await h.setThreads([
      summary('t1', 10, { assignee: 'user:u2' }),
      summary('t2', 20, { assignee: 'user:u1' }),
      summary('t3', 30),
    ]);
    expect(await h.exec('view.comments')).toEqual({ ran: true, reason: null });
    const pane = page.locator('.de-pane[data-pane="comments"]');
    const rows = pane.locator('li[data-thread]');
    await expect(rows).toHaveCount(3);
    // The assignee is text on the row, named from the directory.
    await expect(pane.locator('li[data-thread="t1"] [data-assignee]')).toHaveText(
      'Task, assigned to Grace Hopper.',
    );
    await expect(pane.locator('li[data-thread="t3"] [data-assignee]')).toHaveCount(0);
    // The filter lists the people the open threads are assigned to, by name.
    const select = pane.getByLabel('Assigned to');
    await expect(select.locator('option')).toHaveText(['Anyone', 'Ada Lovelace', 'Grace Hopper']);
    await select.selectOption({ label: 'Grace Hopper' });
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-thread', 't1');
    expect(await axe(page)).toEqual([]);
  });
});
