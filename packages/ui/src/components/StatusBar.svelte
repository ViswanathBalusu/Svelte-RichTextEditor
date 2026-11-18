<!--
  The status bar (UX-018; 13 §3; 02 §7; PRODUCT principles 3 and 4): where the caret is (body or
  region, the style), the word count, the page count only when it comes from a typeset result
  (the web view shows no pages), the language at the caret, the save and connection state, and
  the zoom. Region titles, style names and language names describe the document, not the
  interface. It exposes the `statusbar` part.

  A change that did not happen (a refusal of the region guard, a rejected or set-aside commit) is
  shown here as a notice in plain words until the author dismisses it; the shell announces it at
  the same time (11 §3; 07 §9). Hidden content at the caret is explained here, with a way to ask
  for access when the host handles that (UX-104). None of it takes focus, so typing goes on.
-->
<script lang="ts">
  import { useShell } from '../context.ts';
  import { live } from '../live.ts';
  import type { Notice } from '../shell/notices.ts';
  import { languageAt } from '../shell/status.ts';
  import { classificationName } from '../shell/classification.ts';
  import { proofingBarItem } from '../proofing/present.ts';
  import type { StatusItemRegistry } from '../extensions/contributions.ts';
  import SaveState from './SaveState.svelte';

  interface Props {
    paneFailed: boolean;
    notice?: Notice | null;
    onDismiss?: () => void;
    /** The zoom factor (1 is 100 per cent). */
    zoom?: number;
    /** The host handles access requests (UX-104). */
    onAccessRequest?: (() => void) | undefined;
    accessRequested?: boolean;
    /** Status-bar items the host's extensions contribute (UX-052). */
    statusItems?: StatusItemRegistry | undefined;
  }

  let {
    paneFailed,
    notice = null,
    onDismiss,
    zoom = 1,
    onAccessRequest,
    accessRequested = false,
    statusItems = undefined,
  }: Props = $props();

  const shell = useShell()!;
  const core = shell.core;
  const tr = $derived(shell.strings.current);
  const selection = live(core.selection);
  const access = core.access ? live(core.access) : null;
  const stats = core.stats ? live(core.stats) : null;
  const language = core.language ? live(core.language) : null;
  const classification = core.classification ? live(core.classification) : null;
  const snapshot = live(shell.registry.view);
  const extensionView = statusItems ? live(statusItems.view) : null;
  const proofing = core.proofing ? live(core.proofing) : null;
  /** The proofing state, or null without a proofing port (UX-041 criteria 4 and 5). */
  const proofingItem = $derived(
    proofingBarItem(proofing?.current, (key, params) => tr.t(key, params)),
  );

  /** Extension items at the bar's start and end edges, in registration order (UX-052; 13 §3). */
  const startItems = $derived.by(() => {
    void extensionView?.current;
    return statusItems ? statusItems.list().filter((item) => item.position === 'start') : [];
  });
  const endItems = $derived.by(() => {
    void extensionView?.current;
    return statusItems ? statusItems.list().filter((item) => item.position === 'end') : [];
  });

  const scope = $derived(
    selection.current.scope === 'region'
      ? tr.t('status.scope.region', { title: selection.current.region ?? '' })
      : tr.t('status.scope.body'),
  );

  const hidden = $derived(access?.current.limit === 'hidden');

  function languageName(tag: string): string {
    try {
      return new Intl.DisplayNames([tr.locale], { type: 'language' }).of(tag) ?? tag;
    } catch {
      return tag;
    }
  }

  /** The language at the caret: its mark, else the document's default (UX-018 criterion 3). */
  const languageText = $derived.by(() => {
    const at = languageAt(selection.current.lang ?? null, language?.current ?? null);
    if (at.source === 'mark') return tr.t('status.language', { language: languageName(at.tag) });
    if (at.source === 'document')
      return tr.t('status.language', {
        language: tr.t('status.language.default', { language: languageName(at.tag) }),
      });
    return language ? tr.t('status.language', { language: tr.t('status.language.none') }) : null;
  });

  /** The classification label as text, when the document has one (UX-085 criterion 2). */
  const classificationText = $derived.by(() => {
    const name = classificationName(classification?.current ?? null);
    return name === null ? null : tr.t('status.classification', { label: name });
  });

  const zoomText = $derived(
    new Intl.NumberFormat(tr.locale, { style: 'percent', maximumFractionDigits: 0 }).format(zoom),
  );

  function command(id: string) {
    return snapshot.current.commands.find((c) => c.id === id && c.offered) ?? null;
  }

  const languageCommand = $derived(command('format.language'));
  const zoomCommands = $derived(
    (['view.zoomOut', 'view.zoomIn', 'view.zoomReset'] as const)
      .map((id) => command(id))
      .filter((c) => c !== null),
  );

  function exec(id: string): void {
    const result = shell.registry.exec(id);
    const c = command(id);
    if (!result.ran && c && !c.enabled && c.reasonKey) shell.announceText(tr.text(c.reasonKey));
  }
</script>

<div
  part="statusbar"
  class="de-status"
  role="region"
  aria-label={tr.t('status.label')}
  data-landmark="status"
  lang={tr.locale}
>
  {#each startItems as item (item.id)}
    <span class="de-status-item" data-status="extension" data-status-item={item.id} data-position="start"
      ><span aria-hidden="true">{item.text}</span><span class="de-visually-hidden">{item.label}</span
      ></span
    >
  {/each}
  <span data-status="scope">{scope}</span>
  <span data-status="style" data-content>{selection.current.style ?? ''}</span>
  {#if stats && stats.current.words !== null}
    <span data-status="words">{tr.t('status.words', { count: stats.current.words })}</span>
  {/if}
  {#if stats?.current.pages}
    {@const pages = stats.current.pages}
    <span data-status="pages" data-stale={pages.stale ? '' : undefined}
      >{pages.stale
        ? tr.t('status.pages.stale', { count: pages.count })
        : tr.t('status.pages', { count: pages.count })}</span
    >
  {/if}
  {#if languageText}
    {#if languageCommand}
      <button
        type="button"
        class="de-status-button"
        data-status="language"
        aria-disabled={languageCommand.enabled ? undefined : 'true'}
        title={languageCommand.enabled || !languageCommand.reasonKey
          ? undefined
          : tr.text(languageCommand.reasonKey)}
        onclick={() => exec('format.language')}>{languageText}</button
      >
    {:else}
      <span data-status="language">{languageText}</span>
    {/if}
  {/if}
  {#if classificationText}
    <span data-status="classification">{classificationText}</span>
  {/if}
  {#if proofingItem}
    <!-- Quiet: text only, never an error that blocks typing (UX-041 criterion 4). Absent without a port. -->
    <span
      data-status="proofing"
      data-state={proofingItem.state}
      role="group"
      aria-label={tr.t('status.proofing.label')}>{proofingItem.text}</span
    >
  {/if}
  {#if core.status}
    <SaveState status={core.status} />
  {/if}
  {#if zoomCommands.length > 0}
    <span class="de-zoom" role="group" aria-label={tr.t('status.zoom')}>
      {#each zoomCommands as c (c.id)}
        {#if c.id === 'view.zoomIn'}
          <span class="de-zoom-level" data-status="zoom">{zoomText}</span>
        {/if}
        <button
          type="button"
          class="de-status-button"
          data-command-id={c.id}
          aria-disabled={c.enabled ? undefined : 'true'}
          onclick={() => exec(c.id)}>{tr.text(c.entry.label)}</button
        >
      {/each}
    </span>
  {/if}
  {#if paneFailed}
    <span data-status="error">{tr.t('pane.failed')}</span>
  {/if}
  {#if hidden}
    <span class="de-notice" data-status="hidden">
      <span class="de-notice-mark" aria-hidden="true"></span>
      <span>{tr.t('reason.access.hidden')}</span>
      {#if onAccessRequest}
        {#if accessRequested}
          <span>{tr.t('hidden.requested')}</span>
        {:else}
          <button type="button" class="de-notice-dismiss" onclick={() => onAccessRequest?.()}
            >{tr.t('hidden.request')}</button
          >
        {/if}
      {/if}
    </span>
  {/if}
  {#if notice}
    {#key notice.serial}
      <span class="de-notice" data-status="notice" data-kind={notice.kind}>
        <span class="de-notice-mark" aria-hidden="true"></span>
        <span class="de-notice-text">{tr.t(notice.key, { count: notice.count })}</span>
        {#if notice.action === 'showReferences' && core.runNamed && core.commandNames?.includes('showReferences')}
          <button
            type="button"
            class="de-notice-dismiss"
            data-notice-action="showReferences"
            onclick={() => core.runNamed?.('showReferences')}
            >{tr.t('notice.action.showReferences')}</button
          >
        {/if}
        <button type="button" class="de-notice-dismiss" onclick={() => onDismiss?.()}
          >{tr.t('notice.dismiss')}</button
        >
      </span>
    {/key}
  {/if}
  {#each endItems as item (item.id)}
    <span class="de-status-item" data-status="extension" data-status-item={item.id} data-position="end"
      ><span aria-hidden="true">{item.text}</span><span class="de-visually-hidden">{item.label}</span
      ></span
    >
  {/each}
</div>
