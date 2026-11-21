<!--
  The history pane (HIS-009; 08 §1, §4): the groups of editing sessions and the named versions of
  the document, newest first, with the author names the host resolves (UX-025), the times, the
  number of changes and the origins. The filters are named versions, one region, one field and one
  person; the chips say which are set. A reader who sees named versions only is told why the rest
  is not shown. Erased people (HIS-038) show the unknown-person label. Every state (loading, empty,
  error) has a message. The pane is loaded on demand (02 §2) and reads only the host's history port;
  without the port the history control is not offered and the pane says so.

  Restoring (HIS-021; 08 §8): an open version offers a restore of the whole document or of one
  region, as far as the host says the user may. The first step is always a preview: the dry run is
  shown with the comparison view over the open version, and nothing is changed. The real restore is
  asked for only by the confirmation that the preview shows.
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import AssistantMark from '../components/AssistantMark.svelte';
  import { useShell } from '../context.ts';
  import type { CoreApi, HistoryPaneItem, HistoryRestoreRefusal } from '../core-api.ts';
  import {
    createRestoreController,
    WHOLE_TARGET,
    restoreTargets,
    type RestoreController,
    type RestoreState,
  } from '../shell/history-restore.ts';
  import {
    createWhoController,
    type WhoController,
    type WhoScope,
    type WhoState,
  } from '../shell/history-who.ts';
  import {
    agentOf,
    assistantChanges,
    authorOf,
    compareChoices,
    createCompareController,
    CURRENT_KEY,
    fieldChanges,
    summaryByRegion,
    type CompareController,
    type CompareState,
  } from '../shell/history-compare.ts';
  import { sourceTranslator } from '../i18n/strings.ts';
  import {
    activeFilters,
    authorLabel,
    createHistoryController,
    itemKey,
    NO_FILTER,
    openingOf,
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
  let canOpen = $state(false);
  let canCompare = $state(false);
  let canAsk = $state(false);
  let who: WhoController | null = null;
  let answer = $state.raw<WhoState | null>(null);
  let askScope = $state('document');
  let compare: CompareController | null = null;
  let cmp = $state.raw<CompareState | null>(null);
  let pickFrom = $state('');
  let pickTo = $state('current');
  let restore: RestoreController | null = null;
  let rst = $state.raw<RestoreState | null>(null);
  let canRestore = $state(false);
  let restoreScope = $state(WHOLE_TARGET);
  let restoreTitleEl = $state.raw<HTMLElement | null>(null);
  let restoreRunEl = $state.raw<HTMLElement | null>(null);
  /** Where focus was when a version was opened; it returns there when the user leaves (HIS-010). */
  let returnTo: HTMLElement | null = null;
  let viewHost = $state.raw<HTMLElement | null>(null);
  let titleEl = $state.raw<HTMLElement | null>(null);

  onMount(() => {
    const port = props.core?.history;
    if (port === undefined) {
      hasPort = false;
      return;
    }
    const ctl = createHistoryController(port);
    controller = ctl;
    canOpen = port.openVersion !== undefined;
    canCompare = port.compare !== undefined && canOpen;
    canAsk = port.whoWrote !== undefined && canOpen;
    const wc = createWhoController(port, ctl);
    who = wc;
    answer = wc.state();
    const offWho = wc.subscribe(() => {
      answer = wc.state();
    });
    const cc = createCompareController(port, ctl);
    compare = cc;
    cmp = cc.state();
    const offCompare = cc.subscribe(() => {
      cmp = cc.state();
    });
    const rc = createRestoreController(port, ctl, cc);
    restore = rc;
    canRestore = rc.offered;
    rst = rc.state();
    const offRestore = rc.subscribe(() => {
      rst = rc.state();
    });
    snapshot = ctl.state();
    const off = ctl.subscribe(() => {
      snapshot = ctl.state();
    });
    void ctl.reload();
    // A version named from the command shows at once (HIS-006): the host says the list changed.
    const offChange = port.onChange?.(() => void ctl.reload());
    return () => {
      off();
      offWho();
      offCompare();
      offRestore();
      offChange?.();
      rc.dispose();
      ctl.dispose();
    };
  });

  // The open version is drawn in its own host, apart from the live editor; leaving removes it.
  // $derived keeps the same view while other parts of the state change, so it is not drawn again.
  const openView = $derived(snapshot?.viewing?.status === 'open' ? snapshot.viewing.view : null);
  $effect(() => {
    // Another version, or none: an answer about the earlier one no longer stands.
    void openView;
    who?.clear();
    // Nor does a restore preview of it (a restore that was sent, and its result, are kept).
    restore?.reset();
  });

  // What the user may restore: the whole document and the regions the host names (07 §13).
  const targets = $derived(restoreTargets(rst?.scopes ?? null, snapshot?.choices.regions ?? []));
  $effect(() => {
    if (!targets.some((target) => target.key === restoreScope))
      restoreScope = targets[0]?.key ?? WHOLE_TARGET;
  });
  $effect(() => {
    const v = openView;
    const host = viewHost;
    if (v === null || host === null) return;
    return v.mount(host);
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

  function ask(patch: Parameters<HistoryController['setFilter']>[0]): void {
    void controller?.setFilter(patch);
  }

  /** The `<button>` the user pressed, remembered so that focus can return to it (HIS-010). */
  function openItem(item: HistoryPaneItem, event: MouseEvent): void {
    const root = (event.currentTarget as HTMLElement).getRootNode() as Document | ShadowRoot;
    returnTo = (root.activeElement as HTMLElement | null) ?? (event.currentTarget as HTMLElement);
    void controller?.open(item);
  }

  /**
   * Leaves the version. Focus goes back to the control that opened it, or to the pane's heading if
   * that control is gone; the live editor is not touched.
   */
  // The older end of a comparison starts at the newest state the list offers.
  $effect(() => {
    if (snapshot === null) return;
    const keys = compareChoices(snapshot.items).map((c) => c.key);
    if (!keys.includes(pickFrom)) pickFrom = keys[0] ?? '';
  });

  function kindText(kind: string): string {
    const known = [
      'modified',
      'added',
      'removed',
      'moved',
      'formatted',
      'field',
      'definition',
    ] as const;
    return known.includes(kind as (typeof known)[number])
      ? tr.t(`history.compare.kind.${kind as (typeof known)[number]}`)
      : kind;
  }

  function personName(userId: string | null, names: ReadonlyMap<string, string | null>): string {
    if (userId === null) return tr.t('history.unknown-person');
    return names.get(userId) ?? tr.t('history.unknown-person');
  }

  /** What the live region says on a move: the position, the kind and the author (HIS-013 criterion 2). */
  function announcement(state: CompareState): string {
    const row = state.rows[state.index];
    if (row === undefined) return '';
    const author = authorOf(row.change);
    const agent = agentOf(row.change);
    const params = { n: state.index + 1, m: state.rows.length, kind: kindText(row.change.kind) };
    if (agent !== null)
      return tr.t('history.compare.announce.assistant', {
        ...params,
        agent,
        name: personName(author, state.names),
      });
    return author === null
      ? tr.t('history.compare.announce.nobody', params)
      : tr.t('history.compare.announce', { ...params, name: personName(author, state.names) });
  }

  function choiceLabel(choice: { time: string; name: string | null }): string {
    return choice.name === null
      ? tr.t('history.compare.option.group', { when: when(choice.time) })
      : tr.t('history.compare.option.version', { name: choice.name, when: when(choice.time) });
  }

  function regionLabel(region: string | null, state: HistoryPaneState): string {
    return region === null
      ? tr.t('history.compare.region.none')
      : (state.choices.regions.find((r) => r.id === region)?.label ?? region);
  }

  function fieldLabel(field: string, state: HistoryPaneState): string {
    return state.choices.fields.find((f) => f.id === field)?.label ?? field;
  }

  function runCompare(state: HistoryPaneState, event: MouseEvent): void {
    const choices = compareChoices(state.items);
    const a = choices.find((c) => c.key === pickFrom) ?? choices[0];
    const b = pickTo === 'current' ? null : (choices.find((c) => c.key === pickTo) ?? null);
    if (a === undefined) return;
    const button = event.currentTarget as HTMLElement;
    returnTo = button;
    void compare?.run(a, b);
  }

  function onViewKey(event: KeyboardEvent): void {
    if (event.key !== 'F3' || event.ctrlKey || event.altKey || event.metaKey) return;
    if (cmp?.status !== 'ready') return;
    event.preventDefault();
    if (event.shiftKey) compare?.previous();
    else compare?.next();
  }

  function whoScope(): WhoScope {
    if (askScope === 'selection') return { kind: 'selection' };
    if (askScope.startsWith('region:')) return { kind: 'region', id: askScope.slice(7) };
    return { kind: 'document' };
  }

  /** Asks the host to copy the open version into a new document; the fork is the host's call (HIS-022). */
  function forkFrom(seq: number): void {
    if (shell?.requestFork === undefined) return;
    shell.requestFork(seq);
    shell.announce('history.fork.requested');
  }

  /**
   * The first step of a restore (HIS-021): the dry run, shown with the comparison view. When the
   * preview is drawn, the confirmation has replaced the control that had focus, so the heading of
   * the restore takes it and the text below it is read next.
   */
  async function previewRestore(): Promise<void> {
    const target = targets.find((t) => t.key === restoreScope) ?? targets[0];
    if (restore === null || target === undefined) return;
    if (rst?.status === 'previewing' || rst?.status === 'restoring') return;
    const shown = await restore.preview(target.region);
    await tick();
    if (shown) restoreTitleEl?.focus();
  }

  /** The second step: the real restore, asked for only from the confirmation of a preview. */
  async function confirmRestore(): Promise<void> {
    if (restore === null || rst?.status !== 'preview' || rst.unchanged) return;
    const done = await restore.confirm();
    await tick();
    if (done) {
      // The version is closed and the list shows the restore; the pane's heading takes focus.
      shell?.announce('history.restore.done');
      returnTo = null;
      titleEl?.focus();
    } else restoreRunEl?.focus();
  }

  function cancelRestore(): void {
    restore?.cancel();
    void tick().then(() => restoreRunEl?.focus());
  }

  /** What a restore is of, in words: the whole document, or a region by the name the list gives it. */
  function targetText(region: string | null): string {
    if (region === null) return tr.t('history.restore.scope.document');
    const name = snapshot?.choices.regions.find((r) => r.id === region)?.label ?? region;
    return tr.t('history.restore.scope.region', { name });
  }

  function restoreRefusal(step: 'preview' | 'restore' | null, reason: HistoryRestoreRefusal): string {
    if (reason === 'forbidden') return tr.t('history.restore.refused.forbidden');
    if (reason === 'not_found') return tr.t('history.restore.refused.not-found');
    if (reason === 'conflict') return tr.t('history.restore.refused.conflict');
    if (reason === 'workflow_active') return tr.t('history.restore.refused.workflow');
    if (reason === 'too_large') return tr.t('history.restore.refused.too-large');
    return step === 'preview'
      ? tr.t('history.restore.refused.preview-failed')
      : tr.t('history.restore.refused.failed');
  }

  function leave(): void {
    // A restore that was sent is not walked away from: its answer closes the version or says why not.
    if (rst?.status === 'restoring') return;
    compare?.close();
    controller?.leave();
    const target = returnTo !== null && returnTo.isConnected ? returnTo : titleEl;
    returnTo = null;
    // The list draws again after this call; focus moves once it has.
    void tick().then(() => {
      const again = target !== null && target.isConnected ? target : titleEl;
      again?.focus();
    });
  }

  function viewLabel(v: { time: string; name: string | null }): string {
    const whenText = when(v.time);
    return v.name === null
      ? tr.t('history.view.label', { when: whenText })
      : tr.t('history.view.label.named', { name: v.name, when: whenText });
  }

  function refusal(reason: 'forbidden' | 'not_found' | 'failed'): string {
    if (reason === 'forbidden') return tr.t('history.view.forbidden');
    return reason === 'not_found' ? tr.t('history.view.not-found') : tr.t('history.view.failed');
  }
</script>

<section class="de-history" aria-labelledby={`${id}-title`}>
  <h2 class="de-subhead" id={`${id}-title`} tabindex="-1" bind:this={titleEl}>
    {tr.t('history.label')}
  </h2>

  {#if !hasPort}
    <p role="status" data-status="unavailable">{tr.t('history.unavailable')}</p>
  {:else if snapshot}
    {#if snapshot.viewing?.status === 'open'}
      <!-- The old version: a second, read-only state, apart from the live editor (HIS-010). -->
      <!-- F3 and Shift+F3 move between changes from anywhere in the view, also from the document,
           where focus lands on a change (HIS-013 criterion 2). -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <section
        class="de-history-view"
        data-version-view
        aria-label={viewLabel(snapshot.viewing)}
        onkeydown={onViewKey}
      >
        <p>{tr.t('history.view.note')}</p>
        <button type="button" class="de-list-button" onclick={leave}>
          {tr.t('history.view.leave')}
        </button>
        {#if shell?.requestFork !== undefined}
          <button
            type="button"
            class="de-list-button"
            data-fork-request
            onclick={() => forkFrom(snapshot!.viewing!.status === 'open' ? snapshot!.viewing!.view.seq : 0)}
          >
            {tr.t('history.fork.request')}
          </button>
        {/if}
        {#if canRestore && rst !== null && targets.length > 0 && snapshot.viewing.key !== CURRENT_KEY}
          <!-- Restore (HIS-021): a preview first; the confirmation it shows is the only way on.
               The current document, open as the newer end of a comparison, is not restored to. -->
          <div class="de-history-restore" data-restore>
            <h3 class="de-subhead" id={`${id}-restore`} tabindex="-1" bind:this={restoreTitleEl}>
              {tr.t('history.restore.title')}
            </h3>
            <p role="status" aria-live="polite" data-restore-status={rst.status}>
              {#if rst.status === 'previewing'}{tr.t('history.restore.previewing')}{/if}
              {#if rst.status === 'preview'}
                {rst.unchanged
                  ? tr.t('history.restore.unchanged')
                  : tr.t('history.restore.preview', { count: rst.changes })}
              {/if}
              {#if rst.status === 'restoring'}{tr.t('history.restore.restoring')}{/if}
            </p>
            {#if rst.status === 'preview' || rst.status === 'restoring'}
              <div role="group" aria-labelledby={`${id}-restore`} data-restore-confirmation>
                <!-- The list of what to restore is gone by now, so the choice is said again. -->
                <p data-restore-target>
                  {tr.t('history.restore.target', { what: targetText(rst.request?.region ?? null) })}
                </p>
                {#if rst.recreated.length > 0}
                  <p data-restore-note="recreated">
                    {tr.t('history.restore.recreated', { names: rst.recreated.join(', ') })}
                  </p>
                {/if}
                {#if rst.replaced.length > 0}
                  <p data-restore-note="replaced">
                    {tr.t('history.restore.replaced', { names: rst.replaced.join(', ') })}
                  </p>
                {/if}
                <button
                  type="button"
                  class="de-list-button"
                  data-restore-confirm
                  aria-disabled={rst.unchanged || rst.status === 'restoring'}
                  onclick={() => void confirmRestore()}
                >
                  {tr.t('history.restore.confirm')}
                </button>
                <button
                  type="button"
                  class="de-list-button"
                  data-restore-cancel
                  aria-disabled={rst.status === 'restoring'}
                  onclick={cancelRestore}
                >
                  {tr.t('history.restore.cancel')}
                </button>
              </div>
            {:else}
              <label>
                {tr.t('history.restore.scope')}
                <select data-restore-scope bind:value={restoreScope}>
                  {#each targets as target (target.key)}
                    <option value={target.key}>{targetText(target.region)}</option>
                  {/each}
                </select>
              </label>
              <button
                type="button"
                class="de-list-button"
                data-restore-preview
                aria-disabled={rst.status === 'previewing'}
                bind:this={restoreRunEl}
                onclick={() => void previewRestore()}
              >
                {tr.t('history.restore.preview.run')}
              </button>
            {/if}
            {#if rst.status === 'refused' && rst.reason !== null}
              <p
                role="alert"
                data-status="restore-refused"
                data-reason={rst.reason}
                data-step={rst.step}
              >
                {restoreRefusal(rst.step, rst.reason)}
              </p>
            {/if}
          </div>
        {/if}
        {#if cmp?.status === 'ready'}
          <div class="de-history-compare" data-compare>
            {#if cmp.rows.length === 0}
              <p data-status="no-differences">{tr.t('history.compare.none')}</p>
            {:else}
              <div role="group" aria-label={tr.t('history.compare.navigate')}>
                <button
                  type="button"
                  class="de-list-button"
                  aria-keyshortcuts="Shift+F3"
                  onclick={() => compare?.previous()}
                >
                  {tr.t('history.compare.previous')}
                </button>
                <button
                  type="button"
                  class="de-list-button"
                  aria-keyshortcuts="F3"
                  onclick={() => compare?.next()}
                >
                  {tr.t('history.compare.next')}
                </button>
                <label class="de-check">
                  <input
                    type="checkbox"
                    checked={cmp.showDeleted}
                    onchange={(e) => compare?.setShowDeleted(e.currentTarget.checked)}
                  />
                  {tr.t('history.compare.deletions')}
                </label>
              </div>
              <p role="status" aria-live="polite" data-compare-announce>{announcement(cmp)}</p>
              <h3 class="de-subhead">{tr.t('history.compare.summary')}</h3>
              <ul data-compare-summary>
                {#each summaryByRegion(cmp.rows.map((r) => r.change)) as row (row.region ?? '')}
                  <li>
                    {tr.t('history.compare.region.row', {
                      region: regionLabel(row.region, snapshot),
                      count: row.count,
                    })}
                  </li>
                {/each}
              </ul>
              {#if assistantChanges(cmp.rows.map((r) => r.change)).length > 0}
                <h3 class="de-subhead">{tr.t('history.compare.assistant.title')}</h3>
                <ul data-compare-assistant>
                  {#each assistantChanges(cmp.rows.map((r) => r.change)) as a (a.index)}
                    <li data-assistant>
                      <AssistantMark />
                      {tr.t('history.compare.assistant.row', {
                        n: a.index + 1,
                        kind: kindText(a.change.kind),
                        agent: a.agent,
                        name: personName(a.user, cmp.names),
                      })}
                    </li>
                  {/each}
                </ul>
              {/if}
              {#if fieldChanges(cmp.rows.map((r) => r.change)).length > 0}
                <h3 class="de-subhead">{tr.t('history.compare.fields')}</h3>
                <ul data-compare-fields>
                  {#each fieldChanges(cmp.rows.map((r) => r.change)) as f (f.index)}
                    <li>
                      {tr.t('history.compare.field.row', {
                        field: fieldLabel(f.field, snapshot),
                        name: personName(f.user, cmp.names),
                      })}
                    </li>
                  {/each}
                </ul>
              {/if}
            {/if}
          </div>
        {/if}
        {#if canAsk}
          <div class="de-history-who" data-who>
            <h3 class="de-subhead" id={`${id}-who`}>{tr.t('history.who.title')}</h3>
            <label>
              {tr.t('history.who.scope')}
              <select data-who-scope bind:value={askScope}>
                <option value="document">{tr.t('history.who.scope.document')}</option>
                {#if openView?.selectedBlocks !== undefined}
                  <option value="selection">{tr.t('history.who.scope.selection')}</option>
                {/if}
                {#each snapshot.choices.regions as region (region.id)}
                  <option value={`region:${region.id}`}>
                    {tr.t('history.who.scope.region', { name: region.label })}
                  </option>
                {/each}
              </select>
            </label>
            <button
              type="button"
              class="de-list-button"
              data-who-ask
              onclick={() => void who?.ask(whoScope())}
            >
              {tr.t('history.who.ask')}
            </button>
            <div role="status" aria-live="polite" data-who-status={answer?.status ?? 'idle'}>
              {#if answer?.status === 'loading'}{tr.t('history.who.loading')}{/if}
              {#if answer?.status === 'nothing'}{tr.t('history.who.nothing-selected')}{/if}
              {#if answer?.status === 'refused'}
                {answer.reason === 'forbidden'
                  ? tr.t('history.who.forbidden')
                  : tr.t('history.who.failed')}
              {/if}
              {#if answer?.status === 'ready' && answer.authors.length === 0}
                {tr.t('history.who.empty')}
              {/if}
            </div>
            {#if answer?.status === 'ready' && answer.authors.length > 0}
              <ul data-who-answer aria-labelledby={`${id}-who`}>
                {#each answer.authors as line (`${line.user}|${line.agent ?? ''}|${line.restoredBy ?? ''}`)}
                  <li>
                    {tr.t('history.who.line', {
                      name: personName(line.user, answer.names),
                      count: line.runs,
                      first: when(line.firstTime),
                      last: when(line.lastTime),
                    })}
                    {#if line.agent !== undefined}
                      <span data-assistant><AssistantMark />
                        {tr.t('history.who.assistant', { agent: line.agent })}</span
                      >
                    {/if}
                    {#if line.restoredBy !== undefined}
                      {tr.t('history.who.restored', { by: personName(line.restoredBy, answer.names) })}
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
        <div class="de-history-view-body" bind:this={viewHost}></div>
      </section>
    {/if}
    {#if snapshot.viewing?.status === 'opening'}
      <p role="status" data-status="opening">{tr.t('history.view.opening')}</p>
    {/if}
    {#if snapshot.viewing?.status === 'refused'}
      <p role="alert" data-status="refused" data-reason={snapshot.viewing.reason}>
        {refusal(snapshot.viewing.reason)}
      </p>
    {/if}
    {#if cmp?.status === 'loading'}
      <p role="status" data-status="comparing">{tr.t('history.compare.loading')}</p>
    {/if}
    {#if cmp?.status === 'refused'}
      <p role="alert" data-status="compare-refused" data-reason={cmp.reason}>
        {cmp.reason === 'forbidden'
          ? tr.t('history.compare.forbidden')
          : tr.t('history.compare.failed')}
      </p>
    {/if}
    {#if rst?.status === 'done'}
      <!-- Said in the shell's live region when it happens; this line stays to be read again. -->
      <p data-status="restored">{tr.t('history.restore.done')}</p>
    {/if}
    <div class="de-history-list" hidden={snapshot.viewing?.status === 'open'}>
      {#if canCompare && compareChoices(snapshot.items).length > 0}
        {@const choices = compareChoices(snapshot.items)}
        <form
          class="de-history-compare-form"
          aria-labelledby={`${id}-compare`}
          onsubmit={(e) => e.preventDefault()}
        >
          <h3 class="de-subhead" id={`${id}-compare`}>{tr.t('history.compare.title')}</h3>
          <label>
            {tr.t('history.compare.from')}
            <select data-compare-from bind:value={pickFrom}>
              {#each choices as choice (choice.key)}
                <option value={choice.key}>{choiceLabel(choice)}</option>
              {/each}
            </select>
          </label>
          <label>
            {tr.t('history.compare.to')}
            <select data-compare-to bind:value={pickTo}>
              <option value="current">{tr.t('history.compare.current')}</option>
              {#each choices as choice (choice.key)}
                <option value={choice.key}>{choiceLabel(choice)}</option>
              {/each}
            </select>
          </label>
          <button
            type="button"
            class="de-list-button"
            data-compare-run
            onclick={(e) => runCompare(snapshot!, e)}
          >
            {tr.t('history.compare.run')}
          </button>
        </form>
      {/if}
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
              {#each item.assisted ?? [] as a (`${a.user}|${a.agent}`)}
                <p data-assistant>
                  <AssistantMark />
                  {tr.t('history.group.assisted', {
                    name: authors([a.user], snapshot),
                    agent: a.agent,
                  })}
                </p>
              {/each}
              <p>{tr.t('history.group.origins', { origins: item.origins.join(', ') })}</p>
              {@render openButton(item)}
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
              {@render openButton(item)}
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
    </div>
  {/if}
</section>

{#snippet openButton(item: HistoryPaneItem)}
  {@const what = openingOf(item)}
  {#if canOpen && what !== null}
    <button
      type="button"
      class="de-list-button"
      data-open-version
      aria-label={tr.t('history.version.open-at', { when: when(what.time) })}
      onclick={(e) => openItem(item, e)}
    >
      {tr.t('history.version.open')}
    </button>
  {/if}
{/snippet}
