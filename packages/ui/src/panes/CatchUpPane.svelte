<!--
  The catch-up pane (HIS-028; 08 §10; 13 §3, §5): what others changed since the user's last visit,
  as a summary per region and the list of changes, with what waits for the user first: the mentions
  of them and the tasks assigned to them. The number of changes is announced in a polite live
  region. "Mark as seen" and leaving the pane move the user's marker to the head. Every state
  (loading, nothing new, error) has a message. The pane is loaded on demand (02 §2) and reads only
  the catch-up the shell keeps; without the host's port it says so.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { useShell } from '../context.ts';
  import type { CoreApi, HistoryChange } from '../core-api.ts';
  import type { StringKey } from '../i18n/en-GB.ts';
  import { sourceTranslator } from '../i18n/strings.ts';
  import { createCatchUpController, type CatchUpController, type CatchUpState } from '../shell/catch-up.ts';
  import { authorOf, changeRows } from '../shell/history-compare.ts';

  interface Props {
    core?: CoreApi;
    close?: () => void;
  }

  let props: Props = $props();

  const shell = useShell();
  const fallback = sourceTranslator();
  const tr = $derived(shell?.strings.current ?? fallback);
  const id = `${shell?.idPrefix ?? 'de'}-catch-up`;

  let controller: CatchUpController | null = null;
  let snapshot = $state.raw<CatchUpState | null>(null);
  let hasPort = $state(true);
  let titleEl = $state.raw<HTMLElement | null>(null);

  onMount(() => {
    // The shell keeps one catch-up for the header and the pane; a pane used on its own makes its own.
    let own = false;
    let ctl = shell?.catchUp ?? null;
    if (ctl === null) {
      const port = props.core?.catchUp;
      if (port === undefined) {
        hasPort = false;
        return;
      }
      ctl = createCatchUpController(port);
      own = true;
    }
    controller = ctl;
    snapshot = ctl.state();
    const off = ctl.subscribe(() => {
      snapshot = ctl.state();
    });
    // Opening the pane asks again, so that what the shell read at the start is not stale.
    void ctl.refresh();
    return () => {
      off();
      if (own) {
        void ctl.finish();
        ctl.dispose();
      }
    };
  });

  function name(userId: string | null, state: CatchUpState): string | null {
    if (userId === null) return null;
    const known = state.names.get(userId);
    return known === undefined ? userId : (known ?? tr.t('history.unknown-person'));
  }

  const KINDS: Readonly<Record<string, StringKey>> = {
    modified: 'history.compare.kind.modified',
    added: 'history.compare.kind.added',
    removed: 'history.compare.kind.removed',
    moved: 'history.compare.kind.moved',
    formatted: 'history.compare.kind.formatted',
    field: 'history.compare.kind.field',
    definition: 'history.compare.kind.definition',
  };

  function kindLabel(change: HistoryChange): string {
    const key = KINDS[change.kind];
    return key === undefined ? change.kind : tr.t(key);
  }

  function changeText(change: HistoryChange, state: CatchUpState): string {
    const who = name(authorOf(change), state);
    return who === null
      ? tr.t('catchUp.change.row.nobody', { kind: kindLabel(change) })
      : tr.t('catchUp.change.row', { kind: kindLabel(change), name: who });
  }

  function regionLabel(region: string | null): string {
    return region === null ? tr.t('history.compare.region.none') : region;
  }

  /** The live region says the number of changes once for each load that found some. */
  function announcement(state: CatchUpState): string {
    return state.announcement === null
      ? ''
      : tr.t('catchUp.announce', { count: state.announcement.changes });
  }

  async function dismiss(): Promise<void> {
    await controller?.finish();
    titleEl?.focus();
  }
</script>

<section class="de-catch-up" aria-labelledby={`${id}-title`}>
  <h2 class="de-subhead" id={`${id}-title`} tabindex="-1" bind:this={titleEl}>
    {tr.t('catchUp.label')}
  </h2>

  {#if !hasPort}
    <p role="status" data-status="unavailable">{tr.t('catchUp.unavailable')}</p>
  {:else if snapshot !== null}
    <p role="status" aria-live="polite" data-status={snapshot.status} data-catch-up-announce>
      {#if snapshot.status === 'loading'}{tr.t('catchUp.loading')}{/if}
      {#if snapshot.status === 'empty'}{tr.t('catchUp.empty')}{/if}
      {#if snapshot.status === 'forbidden'}{tr.t('catchUp.forbidden')}{/if}
      {#if snapshot.status === 'error'}
        {tr.t('catchUp.error')}
        <button type="button" class="de-list-button" onclick={() => void controller?.refresh()}
          >{tr.t('catchUp.retry')}</button
        >
      {/if}
      {#if snapshot.status === 'ready'}{announcement(snapshot)}{/if}
    </p>

    {#if snapshot.status === 'ready' && snapshot.activity !== null}
      {#if snapshot.forYou.length > 0}
        <h3 class="de-subhead" id={`${id}-for-you`}>{tr.t('catchUp.foryou')}</h3>
        <ul class="de-list" aria-labelledby={`${id}-for-you`} data-catch-up="for-you">
          {#each snapshot.forYou as item (`${item.kind}:${item.thread}`)}
            <li data-for-you={item.kind}>
              {#if item.kind === 'mention'}
                {@const who = name(item.author, snapshot)}
                <span data-content>
                  {who === null
                    ? tr.t('catchUp.foryou.mention.nobody', { text: item.excerpt ?? '' })
                    : tr.t('catchUp.foryou.mention', { name: who, text: item.excerpt ?? '' })}
                </span>
              {:else}
                {tr.t('catchUp.foryou.task')}
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if snapshot.activity.changes.length > 0}
        <h3 class="de-subhead" id={`${id}-summary`}>{tr.t('catchUp.summary')}</h3>
        <ul aria-labelledby={`${id}-summary`} data-catch-up="summary">
          {#each snapshot.regions as row (row.region ?? '')}
            <li>
              {tr.t('history.compare.region.row', {
                region: regionLabel(row.region),
                count: row.count,
              })}
            </li>
          {/each}
        </ul>
        <h3 class="de-subhead" id={`${id}-changes`}>{tr.t('catchUp.changes')}</h3>
        <ol class="de-list" aria-labelledby={`${id}-changes`} data-catch-up="changes">
          {#each changeRows(snapshot.activity.changes) as row (row.index)}
            <li><span data-content>{changeText(row.change, snapshot)}</span></li>
          {/each}
        </ol>
      {/if}

      {#if snapshot.activity.comments > 0}
        <p data-catch-up="comments">
          {tr.t('catchUp.comments', { count: snapshot.activity.comments })}
        </p>
      {/if}

      <button type="button" class="de-list-button" data-catch-up="dismiss" onclick={() => void dismiss()}>
        {tr.t('catchUp.dismiss')}
      </button>
      {#if snapshot.markFailed}
        <p role="status" data-status="mark-failed">{tr.t('catchUp.mark-failed')}</p>
      {/if}
    {/if}
  {/if}
</section>
