<!--
  One comment thread, with its comments (UX-029; 13 §5; 07 §12; 05 §6.2). Reply, edit and delete a
  comment, resolve or reopen the thread, delete it. Who is offered what follows the rules of
  `shell/comment-rules.ts`: edit and delete for the author of a comment or a user with `manage`,
  delete of a thread for its author or `manage`, reply and resolve for `comment` in the thread's
  scope. Without `comment` the reply box is shown disabled, with the reason.

  Every change is a control-plane request through the core's `threads` port, sent with the version
  (`If-Match`) the view was drawn from. When the service answers that the thread changed, the latest
  version is shown and what the user typed stays in its box (`writeOutcome`). The thread itself
  follows the port's `changes`, so a reply from another client appears here without a reload. A
  thread whose commented text was removed is marked and stays readable; nothing re-attaches it.
-->
<script lang="ts">
  import { useShell } from '../context.ts';
  import { live } from '../live.ts';
  import { createAssigneeSearch, type AssigneeState } from '../shell/assignee-search.ts';
  import type {
    CommentBodyPart,
    CommentView,
    ThreadDetail,
    ThreadWrite,
    ThreadsService,
  } from '../core-api.ts';
  import type { StringKey } from '../i18n/en-GB.ts';
  import {
    canDeleteComment,
    canDeleteThread,
    canEditComment,
    canReply,
  } from '../shell/comment-rules.ts';
  import { PRECONDITION_FAILED, writeOutcome } from '../shell/comment-threads.ts';

  interface Props {
    threads: ThreadsService;
    /** The thread as the core reports it now. */
    detail: ThreadDetail;
    /** Leaves the thread view for the list. */
    onBack: () => void;
  }

  let { threads, detail, onBack }: Props = $props();

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const id = `${shell.idPrefix}-thread-${Math.random().toString(36).slice(2, 6)}`;

  // The latest version a refused write handed back; dropped when the core reports a newer one.
  let latest = $state.raw<ThreadDetail | null>(null);
  let seenEtag = $state('');
  $effect(() => {
    if (detail.etag !== seenEtag) {
      seenEtag = detail.etag;
      latest = null;
    }
  });
  const shown = $derived(latest ?? detail);

  const self = $derived(threads.self?.() ?? '');
  const caps = $derived(shown.caps);
  const mayReply = $derived(canReply(caps).allowed);
  const mayDeleteThread = $derived(canDeleteThread(self, shown.author, caps).allowed);

  let replyText = $state('');
  let editing = $state<string | null>(null);
  let editText = $state('');
  let message = $state<StringKey | null>(null);
  let busy = $state(false);

  // A mention stores the principal only; the name shown comes from the host's `resolveUsers`
  // through the people directory (UX-031 criterion 3), and the neutral label until it answers or
  // when the host does not know the person (or the principal is a group, which has no lookup).
  const directory = shell.people;
  const names = live(directory.view);
  const subOf = (principal: string): string | null =>
    principal.startsWith('user:') ? principal.slice('user:'.length) : null;
  $effect(() => {
    const ids = shown.comments.flatMap((c) =>
      c.body.flatMap((p) => (p.type === 'mention' ? [subOf(p.principal) ?? ''] : [])),
    );
    if (shown.assignee) ids.push(subOf(shown.assignee) ?? '');
    directory.request(ids.filter((id) => id !== ''));
  });

  // The task (UX-032): who the thread is assigned to, shown as text, and the field that changes it.
  const assigneeName = $derived(shown.assignee ? mentionName(shown.assignee) : null);
  const assignSearch = createAssigneeSearch({
    docId: shell.docId ?? '',
    searchPrincipals: shell.searchPrincipals,
  });
  const mayAssign = $derived(mayReply && !!threads.assign && assignSearch.offered);
  let assignText = $state('');
  let assignList = $state.raw<AssigneeState>(assignSearch.state());

  async function lookUpAssignee(): Promise<void> {
    const shownNow = await assignSearch.update(assignText);
    assignList = assignSearch.state();
    if (shownNow) shell.announce('comment.mention.results', { count: assignList.results.length });
  }

  async function assignTo(person: string | null): Promise<void> {
    const ok = await send(
      () => threads.assign?.(shown.id, person, shown.etag),
      person === null ? 'comments.thread.unassigned' : 'comments.thread.assigned',
    );
    if (ok) {
      assignText = '';
      void assignSearch.update('');
      assignList = assignSearch.state();
    }
  }

  function chooseAssignee(index?: number): void {
    const picked = assignSearch.choose(index);
    assignList = assignSearch.state();
    if (picked) void assignTo(picked.principal);
  }

  function onAssignKey(event: KeyboardEvent): void {
    if (!assignList.open) return;
    const any = assignList.results.length > 0;
    if (event.key === 'ArrowDown' && any) assignSearch.move(1);
    else if (event.key === 'ArrowUp' && any) assignSearch.move(-1);
    else if (event.key === 'Enter' && any) {
      event.preventDefault();
      chooseAssignee();
      return;
    } else if (event.key === 'Escape') assignSearch.close();
    else return;
    event.preventDefault();
    event.stopPropagation();
    assignList = assignSearch.state();
  }
  function mentionName(principal: string): string {
    void names.current;
    const sub = subOf(principal);
    return (sub === null ? null : directory.lookup(sub).name) ?? tr.t('people.fallback');
  }

  function plain(parts: readonly CommentBodyPart[]): string {
    return parts.map((p) => (p.type === 'text' ? p.text : `@${mentionName(p.principal)}`)).join('');
  }

  function time(c: CommentView): string {
    return tr.date(new Date(c.createdAt), { dateStyle: 'medium', timeStyle: 'short' });
  }

  /** Runs a write and applies the answer: saved, the latest version of a conflict, or a refusal. */
  async function send(
    attempt: () => Promise<ThreadWrite> | undefined,
    done: StringKey,
  ): Promise<boolean> {
    if (busy) return false;
    busy = true;
    message = null;
    try {
      const answer = await attempt();
      if (!answer) {
        message = 'comments.thread.failed';
        return false;
      }
      if (answer.ok) {
        latest = answer.detail;
        shell.announce(done);
        return true;
      }
      if (answer.code === PRECONDITION_FAILED && answer.latest) {
        const outcome = writeOutcome('', { ok: false, code: answer.code, latest: answer.latest });
        if (outcome.kind === 'conflict') latest = outcome.shown;
        message = 'comments.thread.conflict';
      } else {
        message = answer.code === 'not_found' ? 'comments.thread.gone' : 'comments.thread.failed';
      }
      return false;
    } finally {
      busy = false;
    }
  }

  async function reply(): Promise<void> {
    const text = replyText.trim();
    if (text === '') {
      message = 'comments.thread.emptyBody';
      return;
    }
    const ok = await send(
      () => threads.reply?.(shown.id, [{ type: 'text', text }], shown.etag),
      'comments.thread.posted',
    );
    if (ok) replyText = '';
  }

  function startEdit(c: CommentView): void {
    editing = c.id;
    editText = plain(c.body);
    message = null;
  }

  async function saveEdit(c: CommentView): Promise<void> {
    const text = editText.trim();
    if (text === '') {
      message = 'comments.thread.emptyBody';
      return;
    }
    const ok = await send(
      () => threads.editComment?.(shown.id, c.id, [{ type: 'text', text }], shown.etag),
      'comments.thread.saved',
    );
    if (ok) editing = null;
  }

  async function removeComment(c: CommentView): Promise<void> {
    await send(() => threads.deleteComment?.(shown.id, c.id, shown.etag), 'comments.thread.commentDeleted');
  }

  async function toggleState(): Promise<void> {
    const next = shown.state === 'open' ? 'resolved' : 'open';
    await send(
      () => threads.setState?.(shown.id, next, shown.etag),
      next === 'resolved' ? 'comments.thread.resolved' : 'comments.thread.reopened',
    );
  }

  async function removeThread(): Promise<void> {
    if (busy || !threads.deleteThread) return;
    busy = true;
    message = null;
    try {
      const answer = await threads.deleteThread(shown.id, shown.etag);
      if (answer.ok) {
        shell.announce('comments.thread.threadDeleted');
        onBack();
        return;
      }
      message =
        answer.code === PRECONDITION_FAILED
          ? 'comments.thread.conflict'
          : answer.code === 'not_found'
            ? 'comments.thread.gone'
            : 'comments.thread.failed';
    } finally {
      busy = false;
    }
  }

  const authorOf = (principal: string): string => principal.replace(/^user:/, '');
</script>

<section
  class="de-thread"
  aria-label={tr.t('comments.thread.label', { author: authorOf(shown.author) })}
  data-thread-view={shown.id}
  data-state={shown.state}
  data-detached={shown.detached ? 'true' : undefined}
>
  <div class="de-thread-bar">
    <button type="button" class="de-list-button" data-thread-back onclick={onBack}
      >{tr.t('comments.thread.back')}</button
    >
    {#if mayReply}
      <button type="button" class="de-list-button" data-thread-state disabled={busy} onclick={toggleState}
        >{tr.t(shown.state === 'open' ? 'comments.thread.resolve' : 'comments.thread.reopen')}</button
      >
    {/if}
    {#if mayDeleteThread && threads.deleteThread}
      <button type="button" class="de-list-button" data-thread-delete disabled={busy} onclick={removeThread}
        >{tr.t('comments.thread.deleteThread')}</button
      >
    {/if}
  </div>

  {#if shown.detached}
    <p class="de-hint" data-detached-note>{tr.t('comments.thread.detached')}</p>
  {/if}

  <div class="de-thread-task" data-task data-assigned={shown.assignee ? 'true' : undefined}>
    <p class="de-comment-assignee" data-assignee>
      {#if assigneeName}
        {tr.t('comments.thread.task.assigned', { name: assigneeName })}
      {:else}
        {tr.t('comments.thread.task.none')}
      {/if}
    </p>
    {#if mayAssign}
      <label for={`${id}-assignee`}>{tr.t('comments.thread.assign.label')}</label>
      <input
        id={`${id}-assignee`}
        type="text"
        class="de-input"
        role="combobox"
        autocomplete="off"
        aria-autocomplete="list"
        aria-expanded={assignList.open && assignList.results.length > 0}
        aria-controls={`${id}-assignees`}
        aria-activedescendant={assignList.open && assignList.active !== null
          ? `${id}-assignee-${assignList.active}`
          : undefined}
        bind:value={assignText}
        oninput={() => void lookUpAssignee()}
        onkeydown={onAssignKey}
        onblur={() => {
          assignSearch.close();
          assignList = assignSearch.state();
        }}
        data-assign-field
      />
      <ul
        id={`${id}-assignees`}
        class="de-listbox"
        role="listbox"
        aria-label={tr.t('comments.thread.assign.results')}
        hidden={!assignList.open || assignList.results.length === 0}
      >
        {#each assignList.results as p, i (p.principal)}
          <!-- The keys are handled by the field, which owns the list. -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <li
            id={`${id}-assignee-${i}`}
            role="option"
            class="de-option"
            aria-selected={i === assignList.active}
            data-principal={p.principal}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => chooseAssignee(i)}
          >
            <span data-content>{p.name}</span>
          </li>
        {/each}
      </ul>
      {#if assignList.open && assignList.results.length === 0}
        <p class="de-hint" role="status">{tr.t('dialog.comment.mentionNone')}</p>
      {/if}
      {#if shown.assignee}
        <button
          type="button"
          class="de-list-button"
          data-assign-clear
          disabled={busy}
          onclick={() => assignTo(null)}>{tr.t('comments.thread.assign.clear')}</button
        >
      {/if}
    {/if}
  </div>

  <ul class="de-list de-thread-comments">
    {#each shown.comments as c (c.id)}
      <li class="de-thread-comment" data-comment={c.id}>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div
          class="de-comment-head"
          role="group"
          tabindex="0"
          aria-label={tr.t('comments.thread.comment.name', {
            author: authorOf(c.author),
            time: time(c),
            state: tr.t(shown.state === 'open' ? 'comments.state.open' : 'comments.state.resolved'),
          })}
        >
          <span class="de-comment-author">{authorOf(c.author)}</span>
          <time datetime={c.createdAt}>{time(c)}</time>
          {#if c.edited}<span class="de-hint">({tr.t('comments.thread.edited')})</span>{/if}
        </div>
        {#if editing === c.id}
          <label class="de-visually-hidden" for={`${id}-edit-${c.id}`}
            >{tr.t('comments.thread.edit.label', { author: authorOf(c.author) })}</label
          >
          <textarea id={`${id}-edit-${c.id}`} rows="3" bind:value={editText} data-edit-field></textarea>
          <button type="button" class="de-list-button" disabled={busy} data-edit-save onclick={() => saveEdit(c)}
            >{tr.t('comments.thread.edit.save')}</button
          >
          <button type="button" class="de-list-button" data-edit-cancel onclick={() => (editing = null)}
            >{tr.t('comments.thread.edit.cancel')}</button
          >
        {:else}
          <p class="de-comment-text" data-content>
            {#each c.body as part, i (i)}
              {#if part.type === 'text'}{part.text}{:else}<span
                  class="de-mention"
                  data-principal={part.principal}>@{mentionName(part.principal)}</span
                >{/if}
            {/each}
          </p>
          {#if canEditComment(self, c.author, caps).allowed}
            <button type="button" class="de-list-button" data-comment-edit onclick={() => startEdit(c)}
              >{tr.t('comments.thread.edit')}</button
            >
          {/if}
          {#if canDeleteComment(self, c.author, caps).allowed}
            <button
              type="button"
              class="de-list-button"
              data-comment-delete
              disabled={busy}
              onclick={() => removeComment(c)}>{tr.t('comments.thread.deleteComment')}</button
            >
          {/if}
        {/if}
      </li>
    {/each}
  </ul>

  <div class="de-thread-reply">
    <label for={`${id}-reply`}>{tr.t('comments.thread.reply.label')}</label>
    <textarea
      id={`${id}-reply`}
      rows="3"
      bind:value={replyText}
      disabled={!mayReply}
      aria-describedby={mayReply ? undefined : `${id}-reason`}
      data-reply-field
    ></textarea>
    <button type="button" class="de-list-button" data-reply-post disabled={!mayReply || busy} onclick={reply}
      >{tr.t('comments.thread.reply.post')}</button
    >
    {#if !mayReply}
      <p class="de-hint" id={`${id}-reason`} data-reply-reason>{tr.t('reason.query.noComment')}</p>
    {/if}
  </div>

  {#if message}
    <p class="de-hint" role="alert" data-thread-message>{tr.t(message)}</p>
  {/if}
</section>
