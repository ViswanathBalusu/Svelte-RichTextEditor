<!--
  The review pane (UX-037; 13 §3, §5, §12; 08 §14). Lists the document's suggestions in document
  order with the kind (insertion, deletion, formatting, block change), the author, the time of the
  commit that introduced it when the core knows it, and the words. A filter by author, and one by region, narrow the
  list; assistant authors are authors like any other. Choosing a suggestion moves the document to it;
  accept and reject are offered on an item only where the user may resolve it (UX-036), and "accept
  all" and "reject all" act on what the filter shows. The list follows the core's revision, so a
  suggestion that arrives or is resolved appears or leaves without a reload.
-->
<script lang="ts">
  import '../i18n/late/reviewPane.ts';
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

  // "Tracked changes for everyone" (UX-038; owner decision 118): the setting and who may switch it
  // are shown. The switch is the core's answer (`manage`, and the document not locked), asked again
  // at each revision, since the capabilities of the selection's scope do not say it.
  const tracked = core.trackedForEveryone ? live(core.trackedForEveryone) : null;
  const mayChangeTracked = $derived(
    !!tracked &&
      !!core.runNamed &&
      (core.commandNames?.includes('setTrackedForEveryone') ?? false) &&
      (void revision?.current, core.query?.('canSetTrackedForEveryone') ?? false),
  );
  let trackedFailed = $state(false);

  function setTracked(event: Event): void {
    const box = event.currentTarget as HTMLInputElement;
    const done = core.runNamed?.('setTrackedForEveryone', { on: box.checked }) ?? false;
    trackedFailed = !done;
    // The box shows the setting, not the click: a refusal puts it back.
    if (!done && tracked) box.checked = tracked.current;
  }

  // The regions that hold a suggestion, in document order, and the filter on one of them (UX-036
  // criterion 2). A region the user may not see has no title: it is named without one.
  const regionsView = core.regions ? live(core.regions) : null;
  let region = $state('');
  const regionIds = $derived([
    ...new Set(items.flatMap((i) => (i.region === undefined || i.region === null ? [] : [i.region]))),
  ]);
  $effect(() => {
    if (region !== '' && !regionIds.includes(region)) region = '';
  });
  function regionName(id: string): string {
    const title = regionsView?.current.find((r) => r.id === id)?.title;
    return title ? title : tr.t('review.pane.region.untitled');
  }
  const shownItems = $derived(region === '' ? items : items.filter((i) => i.region === region));

  let author = $state('');
  const authors = $derived([...new Set(shownItems.map((i) => i.user))].sort());
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
      shownItems.map(
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
      region === '' ? 'document' : { id: region },
      author === '' ? undefined : author,
    );
    if (!report) return;
    if (report.handled === 0 && report.skipped === 0) shell.announce('review.none');
    else say(action, report.handled, report.skipped);
  }

  function bulkLabel(action: 'accept' | 'reject'): string {
    const who = author === '' ? null : authorName(author);
    const where = region === '' ? null : regionName(region);
    const accept = action === 'accept';
    if (who !== null && where !== null)
      return tr.t(accept ? 'review.pane.acceptAllByIn' : 'review.pane.rejectAllByIn', {
        author: who,
        region: where,
      });
    if (who !== null)
      return tr.t(accept ? 'review.pane.acceptAllBy' : 'review.pane.rejectAllBy', { author: who });
    if (where !== null)
      return tr.t(accept ? 'review.pane.acceptAllIn' : 'review.pane.rejectAllIn', {
        region: where,
      });
    return tr.t(accept ? 'review.pane.acceptAll' : 'review.pane.rejectAll');
  }

  /** The words that name the model and the person it acted for, or '' for a person's own suggestion. */
  function assistantLine(id: string, author: string): string {
    const assistant = byId.get(id)?.assistant;
    if (assistant === undefined || assistant === null) return '';
    const who = authorName(author);
    return assistant.name === null
      ? tr.t('review.pane.assistant.unnamed.for', { author: who })
      : tr.t('review.pane.assistant.for', { model: assistant.name, author: who });
  }

  function rowName(row: (typeof rows)[number]): string {
    const when = row.accessibleName.committedAt;
    const base = tr.t(when === '' ? 'review.pane.row.name' : 'review.pane.row.nameAt', {
      kind: tr.t(KIND_KEY[row.accessibleName.kind]),
      author: authorName(row.accessibleName.author),
      excerpt: row.excerpt ?? tr.t('review.pane.noText'),
      time: when === '' ? '' : tr.date(new Date(when), { dateStyle: 'medium', timeStyle: 'short' }),
    });
    const by = assistantLine(row.id, row.accessibleName.author);
    return by === '' ? base : `${base} (${by})`;
  }
</script>

<section class="de-review" aria-label={tr.t('pane.review')}>
  {#if tracked}
    <div class="de-review-tracked" data-tracked-setting data-on={tracked.current ? 'true' : 'false'}>
      <p data-tracked-state>
        {tr.t(tracked.current ? 'review.tracked.on' : 'review.tracked.off')}
      </p>
      {#if tracked.current}
        <p class="de-hint" data-tracked-who>{tr.t('review.tracked.who')}</p>
      {/if}
      {#if mayChangeTracked}
        <label class="de-check">
          <input type="checkbox" checked={tracked.current} onchange={setTracked} />
          <span>{tr.t('review.tracked.toggle')}</span>
        </label>
      {/if}
      {#if trackedFailed}
        <p class="de-error" role="alert">{tr.t('review.tracked.failed')}</p>
      {/if}
    </div>
  {/if}
  {#if authors.length > 0}
    <div class="de-review-filters">
      {#if regionIds.length > 0}
        <label for="de-review-region">{tr.t('review.pane.filter.region')}</label>
        <select id="de-review-region" bind:value={region}>
          <option value="">{tr.t('review.pane.filter.allRegions')}</option>
          {#each regionIds as id (id)}
            <option value={id}>{regionName(id)}</option>
          {/each}
        </select>
      {/if}
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
          >{bulkLabel('accept')}</button
        >
        <button type="button" class="de-list-button" data-review-reject-all onclick={() => resolveShown('reject')}
          >{bulkLabel('reject')}</button
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
            {#if item?.assistant}
              <span class="de-review-assistant" data-assistant={item.assistant.agent}
                >{assistantLine(row.id, row.author)}</span
              >
            {/if}
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
