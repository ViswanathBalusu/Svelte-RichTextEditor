<!--
  The review pane (UX-037; 13 §3, §5, §12; 08 §14). Lists the document's suggestions in document
  order with the kind (insertion, deletion, formatting, block change), the author, the time of the
  commit that introduced it when the core knows it, and the words. A filter by author narrows the
  list; assistant authors are authors like any other. Choosing a suggestion moves the document to it;
  accept and reject are offered on an item only where the user may resolve it (UX-036), and "accept
  all" and "reject all" act on what the filter shows. The list follows the core's revision, so a
  suggestion that arrives or is resolved appears or leaves without a reload.
-->
<script lang="ts">
  import { useShell } from '../context.ts';
  import { live } from '../live.ts';
  import type { ReviewItem } from '../core-api.ts';
  import type { StringKey } from '../i18n/en-GB.ts';
  import { reviewPaneRows } from '../shell/review-pane-rows.ts';
  import { reviewOffers, type SuggestionKind, type SuggestionRow } from '../shell/review-rules.ts';

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const core = shell.core;
  const revision = core.revision ? live(core.revision) : null;
  const people = shell.people;
  const peopleNames = live(people.view);

  const items: readonly ReviewItem[] = $derived.by(() => {
    void revision?.current;
    return core.suggestionItems?.() ?? [];
  });
  const byId = $derived(new Map(items.map((i) => [i.id, i])));

  // The authors' names come from the host (`resolveUsers`), asked for as the list changes.
  $effect(() => {
    people.request(items.map((i) => i.user));
  });
  function authorName(user: string): string {
    void peopleNames.current;
    const sub = user.startsWith('user:') ? user.slice(5) : user;
    return people.lookup(sub).name ?? tr.t('people.fallback');
  }

  let author = $state('');
  const authors = $derived([...new Set(items.map((i) => i.user))].sort());
  // A filter on an author who has no suggestion left is dropped: the list is never empty by a stale choice.
  $effect(() => {
    if (author !== '' && !authors.includes(author)) author = '';
  });

  function kindOf(item: ReviewItem): SuggestionKind {
    if (item.block) return 'block';
    return item.kind === 'ins' ? 'insertion' : item.kind === 'del' ? 'deletion' : 'formatting';
  }
  const KIND_KEY: Readonly<Record<SuggestionKind, StringKey>> = {
    insertion: 'review.pane.kind.insertion',
    deletion: 'review.pane.kind.deletion',
    formatting: 'review.pane.kind.formatting',
    block: 'review.pane.kind.block',
  };

  const rows = $derived(
    reviewPaneRows(
      items.map(
        (i): SuggestionRow => ({
          id: i.id,
          kind: kindOf(i),
          author: i.user,
          committedAt: i.committedAt ?? '',
          excerpt: i.text,
          position: i.from,
        }),
      ),
      author === '' ? null : author,
    ),
  );
  const mayResolveShown = $derived(
    rows.some((r) => {
      const item = byId.get(r.id);
      return item !== undefined && item.canResolve && reviewOffers(item.caps).accept;
    }),
  );

  let selectedId = $state<string | null>(null);

  function show(id: string): void {
    selectedId = id;
    core.revealSuggestion?.(id);
  }

  function say(action: 'accept' | 'reject', handled: number, skipped: number): void {
    const done = tr.t(action === 'accept' ? 'review.accepted' : 'review.rejected', {
      count: handled,
    });
    shell.announceText(skipped > 0 ? `${done} ${tr.t('review.left', { count: skipped })}` : done);
  }

  function resolveOne(action: 'accept' | 'reject', id: string): void {
    const report = core.resolveSuggestions?.(action, 'document', undefined, id);
    if (!report) return;
    if (report.handled === 0 && report.skipped === 0) shell.announce('review.gone');
    else say(action, report.handled, report.skipped);
    if (selectedId === id) selectedId = null;
  }

  function resolveShown(action: 'accept' | 'reject'): void {
    const report = core.resolveSuggestions?.(
      action,
      'document',
      author === '' ? undefined : author,
    );
    if (!report) return;
    if (report.handled === 0 && report.skipped === 0) shell.announce('review.none');
    else say(action, report.handled, report.skipped);
  }

  function rowName(row: (typeof rows)[number]): string {
    const when = row.accessibleName.committedAt;
    return tr.t(when === '' ? 'review.pane.row.name' : 'review.pane.row.nameAt', {
      kind: tr.t(KIND_KEY[row.accessibleName.kind]),
      author: authorName(row.accessibleName.author),
      excerpt: row.excerpt ?? tr.t('review.pane.noText'),
      time: when === '' ? '' : tr.date(new Date(when), { dateStyle: 'medium', timeStyle: 'short' }),
    });
  }
</script>

<section class="de-review" aria-label={tr.t('pane.review')}>
  {#if authors.length > 0}
    <div class="de-review-filters">
      <label for="de-review-author">{tr.t('review.pane.filter.author')}</label>
      <select id="de-review-author" bind:value={author}>
        <option value="">{tr.t('review.pane.filter.everyone')}</option>
        {#each authors as who (who)}
          <option value={who}>{authorName(who)}</option>
        {/each}
      </select>
    </div>
    {#if core.resolveSuggestions && mayResolveShown}
      <div class="de-review-bulk">
        <button type="button" class="de-list-button" data-review-accept-all onclick={() => resolveShown('accept')}
          >{author === ''
            ? tr.t('review.pane.acceptAll')
            : tr.t('review.pane.acceptAllBy', { author: authorName(author) })}</button
        >
        <button type="button" class="de-list-button" data-review-reject-all onclick={() => resolveShown('reject')}
          >{author === ''
            ? tr.t('review.pane.rejectAll')
            : tr.t('review.pane.rejectAllBy', { author: authorName(author) })}</button
        >
      </div>
    {/if}
  {/if}

  {#if rows.length === 0}
    <p data-review-empty>{tr.t('review.pane.empty')}</p>
  {:else}
    <ul class="de-list de-review-list" aria-label={tr.t('review.pane.list')}>
      {#each rows as row (row.id)}
        {@const item = byId.get(row.id)}
        <li
          class="de-review-row"
          data-suggestion={row.id}
          data-kind={row.kind}
          data-selected={selectedId === row.id ? 'true' : undefined}
          aria-current={selectedId === row.id ? 'true' : undefined}
        >
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <div class="de-review-head" role="group" tabindex="0" aria-label={rowName(row)}>
            <span class="de-review-kind">{tr.t(KIND_KEY[row.kind])}</span>
            <span class="de-review-author">{authorName(row.author)}</span>
            {#if row.committedAt !== ''}
              <time datetime={row.committedAt}
                >{tr.date(new Date(row.committedAt), { dateStyle: 'medium', timeStyle: 'short' })}</time
              >
            {/if}
          </div>
          <p class="de-review-excerpt" data-content>{row.excerpt ?? tr.t('review.pane.noText')}</p>
          <button
            type="button"
            class="de-list-button"
            data-review-show
            aria-label={tr.t('review.pane.show.label', { author: authorName(row.author) })}
            onclick={() => show(row.id)}>{tr.t('review.pane.show')}</button
          >
          {#if item && item.canResolve && reviewOffers(item.caps).accept}
            <button
              type="button"
              class="de-list-button"
              data-review-accept
              aria-label={tr.t('review.pane.accept.label', { author: authorName(row.author) })}
              onclick={() => resolveOne('accept', row.id)}>{tr.t('review.pane.accept')}</button
            >
            <button
              type="button"
              class="de-list-button"
              data-review-reject
              aria-label={tr.t('review.pane.reject.label', { author: authorName(row.author) })}
              onclick={() => resolveOne('reject', row.id)}>{tr.t('review.pane.reject')}</button
            >
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
