<!--
  Comments pane (UX-030; 13 §3, §5; 05 §5.6). Lists the threads the core reports, in document order,
  with author, time, state, the commented text or block kind, and the reply count. The state and
  assignee filters are the rules of `filterThreads`. Each row is named by its author, state and
  reply count. Not built here: choosing a thread to scroll to and highlight it, the live refresh
  from `thread.*` and `comment.*`, and the count on the header button. The list is read when the
  pane opens.
-->
<script lang="ts">
  import { useShell } from '../context.ts';
  import type { StringKey } from '../i18n/en-GB.ts';
  import type { ThreadSummary } from '../core-api.ts';
  import { tick } from 'svelte';
  import { filterThreads, type ThreadState } from '../shell/comment-rules.ts';
  import { paneRows, type PaneRow } from '../shell/comment-threads.ts';
  import { linkedCommentAnnouncement } from '../shell/linked-comment.ts';

  type StateFilter = ThreadState | 'all';

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const threads: readonly ThreadSummary[] = shell.core.threads?.list() ?? [];
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

  const STATES: readonly StateFilter[] = ['open', 'resolved', 'all'];
  const STATE_FILTER_KEY: Readonly<Record<StateFilter, StringKey>> = {
    open: 'comments.filter.open',
    resolved: 'comments.filter.resolved',
    all: 'comments.filter.all',
  };

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
        <option value={who}>{who}</option>
      {/each}
    </select>
  </div>

  {#if rows.length === 0}
    <p>{tr.t('comments.empty')}</p>
  {:else}
    <ul class="de-list de-comments-list">
      {#each rows as row (row.id)}
        <li class="de-comment-row" data-thread={row.id} data-state={row.state}>
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
        </li>
      {/each}
    </ul>
  {/if}
  {/if}
</section>
