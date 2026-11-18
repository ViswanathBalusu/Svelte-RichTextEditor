<!--
  Comments pane (UX-030; 13 §3, §5; 05 §5.6). Lists the threads the core reports, in document order,
  with author, time, state, the commented text or block kind, and the reply count. The state and
  assignee filters are the rules of `filterThreads`. Each row is named by its author, state and
  reply count. A row's 'Show in document' button asks the port to mark and scroll to the thread; a
  highlight chosen in the page selects its row (UX-030 criterion 2). The list and the open thread
  follow the port's changes, and a change is announced (`describeThreadChange`); the port's source
  of `thread.*` and `comment.*` notices is not built in the element. The header count is
  components/Header.svelte; the thread view is components/ThreadView.svelte (UX-029).
-->
<script lang="ts">
  import ThreadView from '../components/ThreadView.svelte';
  import { useShell } from '../context.ts';
  import { live } from '../live.ts';
  import type { StringKey } from '../i18n/en-GB.ts';
  import type { ThreadSummary } from '../core-api.ts';
  import { tick } from 'svelte';
  import { filterThreads, type ThreadState } from '../shell/comment-rules.ts';
  import {
    describeThreadChange,
    paneRows,
    type PaneRow,
    type ThreadChange,
  } from '../shell/comment-threads.ts';
  import { linkedCommentAnnouncement } from '../shell/linked-comment.ts';

  type StateFilter = ThreadState | 'all';

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const service = shell.core.threads;
  // The list follows the port's changes (a thread or comment changed, here or elsewhere; UX-029).
  const changes = service?.changes ? live(service.changes) : null;
  const threads: readonly ThreadSummary[] = $derived.by(() => {
    void changes?.current;
    return service?.list() ?? [];
  });
  // The thread open in the thread view, when the port can show one.
  let openId = $state<string | null>(null);
  const detail = $derived.by(() => {
    void changes?.current;
    return openId && service?.detail ? service.detail(openId) : null;
  });
  const linked = shell.linkedThread;
  let root: HTMLElement | undefined = $state();
  // The message for a followed link that cannot be shown (UX-034 criterion 3); nothing else is shown.
  let unavailable = $state(false);

  let stateFilter = $state<StateFilter>('open');
  let assignee = $state('');

  // A followed link (UX-034 criteria 2 to 4): show the thread even when a filter hides it, bring it
  // into view, focus it and announce its author, time and state. The target is taken once.
  $effect(() => {
    const target = $linked;
    if (!target) return;
    linked.set(null);
    if (target.kind === 'unavailable') {
      unavailable = true;
      return;
    }
    unavailable = false;
    stateFilter = 'all';
    assignee = '';
    void focusLinked(target.id);
  });

  async function focusLinked(id: string): Promise<void> {
    await tick();
    const thread = threads.find((t) => t.id === id);
    const head = root?.querySelector<HTMLElement>(`li[data-thread="${CSS.escape(id)}"] .de-comment-head`);
    if (!thread || !head) return;
    head.scrollIntoView({ block: 'center' });
    head.focus();
    const parts = linkedCommentAnnouncement(thread);
    shell.announceText(
      tr.t('comments.link.announce', {
        author: parts.author,
        time: tr.date(new Date(parts.createdAt), { dateStyle: 'medium', timeStyle: 'short' }),
        state: stateName(parts.state),
      }),
    );
  }

  // The thread chosen, in the pane or in the page (UX-030 criterion 2).
  let selectedId = $state<string | null>(null);

  function show(id: string): void {
    const thread = threads.find((t) => t.id === id);
    if (!thread) return;
    selectedId = id;
    service?.reveal?.(thread);
  }

  // A highlight chosen in the page selects its thread here, even when a filter hides it.
  const picked = service?.picked ? live(service.picked) : null;
  let seenPick = 0;
  $effect(() => {
    const p = picked?.current;
    if (!p || p.n === seenPick) return;
    seenPick = p.n;
    void selectFromPage(p.id);
  });

  async function selectFromPage(id: string): Promise<void> {
    const thread = threads.find((t) => t.id === id);
    if (!thread) return;
    openId = null;
    unavailable = false;
    stateFilter = 'all';
    assignee = '';
    selectedId = id;
    await tick();
    const head = root?.querySelector<HTMLElement>(`li[data-thread="${CSS.escape(id)}"] .de-comment-head`);
    head?.scrollIntoView({ block: 'center' });
    head?.focus();
    shell.announceText(tr.t('comments.picked', { author: thread.author }));
  }

  // A refresh of the list from the port (a `thread.*` or `comment.*` notice) says what changed.
  let previous: readonly ThreadSummary[] | null = null;
  $effect(() => {
    const now = [...threads];
    const before = previous;
    previous = now;
    if (before === null) return;
    const change = describeThreadChange(before, now);
    if (change) shell.announceText(tr.t(ANNOUNCE_KEY[change.kind], { author: change.author }));
  });
  const ANNOUNCE_KEY: Readonly<Record<ThreadChange['kind'], StringKey>> = {
    created: 'comments.announce.created',
    reply: 'comments.announce.reply',
    resolved: 'comments.announce.resolved',
    reopened: 'comments.announce.reopened',
    deleted: 'comments.announce.deleted',
  };

  const STATES: readonly StateFilter[] = ['open', 'resolved', 'all'];
  const STATE_FILTER_KEY: Readonly<Record<StateFilter, StringKey>> = {
    open: 'comments.filter.open',
    resolved: 'comments.filter.resolved',
    all: 'comments.filter.all',
  };

  // An assignee is a principal; its name comes from the host's `resolveUsers` (UX-032 criterion 5:
  // the assignee is exposed as text). A value that is not a `user:` principal is shown as it is.
  const people = shell.people;
  const peopleNames = live(people.view);
  const subOf = (who: string): string => (who.startsWith('user:') ? who.slice(5) : who);
  $effect(() => {
    people.request(
      threads.flatMap((t) => (t.assignee !== null && t.assignee.startsWith('user:') ? [subOf(t.assignee)] : [])),
    );
  });
  function assigneeLabel(who: string): string {
    void peopleNames.current;
    const name = people.lookup(subOf(who)).name;
    if (name !== null) return name;
    return who.startsWith('user:') ? tr.t('people.fallback') : who;
  }

  const assignees = $derived(
    [...new Set(threads.map((t) => t.assignee).filter((a): a is string => a !== null))].sort(),
  );
  const rows = $derived(
    paneRows(
      filterThreads(threads, {
        state: stateFilter,
        assignee: assignee === '' ? null : assignee,
      }),
    ),
  );

  function stateName(state: ThreadState): string {
    return tr.t(state === 'open' ? 'comments.state.open' : 'comments.state.resolved');
  }

  function replies(count: number): string {
    return tr.t('comments.replies', { count });
  }

  function targetText(row: PaneRow): string {
    if (row.target.kind === 'excerpt') return tr.t('comments.target.excerpt', { text: row.target.text });
    if (row.target.kind === 'block') return tr.t('comments.target.block', { kind: row.target.blockKind });
    return tr.t('comments.target.detached');
  }

  function rowName(row: PaneRow): string {
    return tr.t('comments.row.name', {
      author: row.accessibleName.author,
      state: stateName(row.accessibleName.state),
      replies: replies(row.accessibleName.replyCount),
    });
  }
</script>

<section class="de-comments" aria-label={tr.t('pane.comments')} bind:this={root}>
  {#if unavailable}
  <p>{tr.t('comments.link.unavailable')}</p>
  {:else if openId && service}
    {#if detail}
      <ThreadView threads={service} {detail} onBack={() => (openId = null)} />
    {:else}
      <p data-thread-gone>{tr.t('comments.thread.gone')}</p>
      <button type="button" class="de-list-button" data-thread-back onclick={() => (openId = null)}
        >{tr.t('comments.thread.back')}</button
      >
    {/if}
  {:else}
  <div class="de-comments-filters">
    <fieldset class="de-comments-state">
      <legend>{tr.t('comments.filter.label')}</legend>
      {#each STATES as s (s)}
        <label class="de-check">
          <input
            type="radio"
            name="comments-state"
            value={s}
            checked={stateFilter === s}
            onchange={() => (stateFilter = s)}
          />
          {tr.t(STATE_FILTER_KEY[s])}
        </label>
      {/each}
    </fieldset>
    <label class="de-comments-assignee" for="de-comments-assignee"
      >{tr.t('comments.filter.assignee')}</label
    >
    <select id="de-comments-assignee" bind:value={assignee}>
      <option value="">{tr.t('comments.filter.anyone')}</option>
      {#each assignees as who (who)}
        <option value={who}>{assigneeLabel(who)}</option>
      {/each}
    </select>
  </div>

  {#if rows.length === 0}
    <p>{tr.t('comments.empty')}</p>
  {:else}
    <ul class="de-list de-comments-list">
      {#each rows as row (row.id)}
        <li
          class="de-comment-row"
          data-thread={row.id}
          data-state={row.state}
          data-selected={selectedId === row.id ? 'true' : undefined}
          aria-current={selectedId === row.id ? 'true' : undefined}
        >
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <div class="de-comment-head" role="group" tabindex="0" aria-label={rowName(row)}>
            <span class="de-comment-author">{row.author}</span>
            <time datetime={row.createdAt}
              >{tr.date(new Date(row.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}</time
            >
            <span class="de-comment-state">{stateName(row.state)}</span>
            <span class="de-comment-replies">{replies(row.replyCount)}</span>
          </div>
          <p class="de-comment-target" data-content>{targetText(row)}</p>
          {#if row.assignee !== null}
            <p class="de-comment-assignee" data-assignee>
              {tr.t('comments.thread.task.assigned', { name: assigneeLabel(row.assignee) })}
            </p>
          {/if}
          {#if service?.reveal}
            <button
              type="button"
              class="de-list-button"
              data-thread-show
              aria-label={tr.t('comments.show.label', { author: row.author })}
              onclick={() => {
                show(row.id);
                shell.announceText(tr.t('comments.shown'));
              }}>{tr.t('comments.show')}</button
            >
          {/if}
          {#if service?.detail}
            <button
              type="button"
              class="de-list-button"
              data-thread-open
              onclick={() => {
                show(row.id);
                openId = row.id;
              }}
              >{tr.t('comments.thread.open', { author: row.author })}</button
            >
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  {/if}
</section>
