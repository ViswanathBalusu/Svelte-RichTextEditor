<!--
  The history pane (HIS-009; 08 §1, §4): the groups of editing sessions and the named versions of
  the document, newest first, with the author names the host resolves (UX-025), the times, the
  number of changes and the origins. The filters are named versions, one region, one field and one
  person; the chips say which are set. A reader who sees named versions only is told why the rest
  is not shown. Erased people (HIS-038) show the unknown-person label. Every state (loading, empty,
  error) has a message. The pane is loaded on demand (02 §2) and reads only the host's history port;
  without the port the history control is not offered and the pane says so.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { useShell } from '../context.ts';
  import type { CoreApi, HistoryPaneItem } from '../core-api.ts';
  import { sourceTranslator } from '../i18n/strings.ts';
  import {
    activeFilters,
    authorLabel,
    createHistoryController,
    NO_FILTER,
    type HistoryController,
    type HistoryPaneState,
  } from '../shell/history-pane.ts';

  interface Props {
    core?: CoreApi;
    close?: () => void;
  }

  let props: Props = $props();

  const shell = useShell();
  const fallback = sourceTranslator();
  const tr = $derived(shell?.strings.current ?? fallback);
  const id = `${shell?.idPrefix ?? 'de'}-history`;

  let controller: HistoryController | null = null;
  let snapshot = $state.raw<HistoryPaneState | null>(null);
  let hasPort = $state(true);

  onMount(() => {
    const port = props.core?.history;
    if (port === undefined) {
      hasPort = false;
      return;
    }
    const ctl = createHistoryController(port);
    controller = ctl;
    snapshot = ctl.state();
    const off = ctl.subscribe(() => {
      snapshot = ctl.state();
    });
    void ctl.reload();
    return off;
  });

  function when(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return new Intl.DateTimeFormat(tr.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
      date,
    );
  }

  function authors(ids: readonly string[], state: HistoryPaneState): string {
    return ids
      .map((authorId) => {
        const label = authorLabel(authorId, state.names);
        return label.known ? label.name : tr.t('history.unknown-person');
      })
      .join(', ');
  }

  function choiceName(kind: 'regions' | 'fields' | 'people', key: string, state: HistoryPaneState): string {
    return state.choices[kind].find((choice) => choice.id === key)?.label ?? key;
  }

  function chips(state: HistoryPaneState): { key: string; text: string }[] {
    return activeFilters(state.filter).map((name) => {
      if (name === 'named') return { key: name, text: tr.t('history.chip.named') };
      if (name === 'region')
        return {
          key: name,
          text: tr.t('history.chip.region', {
            name: choiceName('regions', state.filter.region ?? '', state),
          }),
        };
      if (name === 'field')
        return {
          key: name,
          text: tr.t('history.chip.field', {
            name: choiceName('fields', state.filter.field ?? '', state),
          }),
        };
      return {
        key: name,
        text: tr.t('history.chip.user', {
          name: choiceName('people', state.filter.user ?? '', state),
        }),
      };
    });
  }

  function itemKey(item: HistoryPaneItem): string {
    return `${item.kind}:${item.id}`;
  }

  function ask(patch: Parameters<HistoryController['setFilter']>[0]): void {
    void controller?.setFilter(patch);
  }
</script>

<section class="de-history" aria-labelledby={`${id}-title`}>
  <h2 class="de-subhead" id={`${id}-title`}>{tr.t('history.label')}</h2>

  {#if !hasPort}
    <p role="status" data-status="unavailable">{tr.t('history.unavailable')}</p>
  {:else if snapshot}
    <form class="de-history-filters" aria-labelledby={`${id}-filters`} onsubmit={(e) => e.preventDefault()}>
      <h3 class="de-subhead" id={`${id}-filters`}>{tr.t('history.filters')}</h3>
      <label class="de-check">
        <input
          type="checkbox"
          checked={snapshot.filter.namedOnly}
          onchange={(e) => ask({ namedOnly: e.currentTarget.checked })}
        />
        {tr.t('history.filter.named')}
      </label>
      <label>
        {tr.t('history.filter.region')}
        <select onchange={(e) => ask({ region: e.currentTarget.value || null })}>
          <option value="" selected={snapshot.filter.region === null}>{tr.t('history.filter.any')}</option>
          {#each snapshot.choices.regions as region (region.id)}
            <option value={region.id} selected={snapshot.filter.region === region.id}>{region.label}</option>
          {/each}
        </select>
      </label>
      <label>
        {tr.t('history.filter.field')}
        <select onchange={(e) => ask({ field: e.currentTarget.value || null })}>
          <option value="" selected={snapshot.filter.field === null}>{tr.t('history.filter.any')}</option>
          {#each snapshot.choices.fields as field (field.id)}
            <option value={field.id} selected={snapshot.filter.field === field.id}>{field.label}</option>
          {/each}
        </select>
      </label>
      <label>
        {tr.t('history.filter.user')}
        <select onchange={(e) => ask({ user: e.currentTarget.value || null })}>
          <option value="" selected={snapshot.filter.user === null}>{tr.t('history.filter.any')}</option>
          {#each snapshot.choices.people as person (person.id)}
            <option value={person.id} selected={snapshot.filter.user === person.id}>{person.label}</option>
          {/each}
        </select>
      </label>
      {#if activeFilters(snapshot.filter).length > 0}
        <ul class="de-history-chips" aria-label={tr.t('history.active')}>
          {#each chips(snapshot) as chip (chip.key)}
            <li data-filter={chip.key}>{chip.text}</li>
          {/each}
        </ul>
        <button type="button" class="de-list-button" onclick={() => ask(NO_FILTER)}>
          {tr.t('history.filter.clear')}
        </button>
      {/if}
    </form>

    <p role="status" aria-live="polite" data-status={snapshot.status}>
      {#if snapshot.status === 'loading'}{tr.t('history.loading')}{/if}
      {#if snapshot.status === 'empty'}{tr.t('history.empty')}{/if}
      {#if snapshot.status === 'error'}
        {tr.t('history.error')}
        <button type="button" class="de-list-button" onclick={() => void controller?.reload()}
          >{tr.t('history.retry')}</button
        >
      {/if}
    </p>

    {#if snapshot.namedOnly}
      <p data-status="named-only">{tr.t('history.named-only')}</p>
    {/if}

    {#if snapshot.items.length > 0}
      <ol class="de-list" aria-label={tr.t('history.label')}>
        {#each snapshot.items as item (itemKey(item))}
          {#if item.kind === 'group'}
            <li data-history="group">
              <p>
                <span>{tr.t('history.group.range', { from: when(item.from), to: when(item.to) })}</span>
                <span>{tr.t('history.group.changes', { count: item.changes })}</span>
              </p>
              <p>{tr.t('history.group.authors', { authors: authors(item.authors, snapshot) })}</p>
              <p>{tr.t('history.group.origins', { origins: item.origins.join(', ') })}</p>
            </li>
          {:else}
            <li data-history="version">
              <p>
                <span class="de-badge">{tr.t('history.group.named')}</span>
                <strong data-content>{item.name}</strong>
              </p>
              {#if item.note}<p data-content>{item.note}</p>{/if}
              <p>
                {tr.t('history.version.by', {
                  name: authors([item.creator], snapshot),
                  time: when(item.time),
                })}
              </p>
            </li>
          {/if}
        {/each}
      </ol>
      {#if snapshot.nextCursor !== null}
        <button type="button" class="de-list-button" onclick={() => void controller?.loadMore()}>
          {tr.t('history.more')}
        </button>
      {/if}
    {/if}
  {/if}
</section>
