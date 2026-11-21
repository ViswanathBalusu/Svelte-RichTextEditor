<!--
  The guided bar of fill mode (FRW-076; 12 §11): how many of the required fields the participant
  has filled, a control to the next required field still empty, the summary of what is left
  (FRW-078) and a control to finish. While the participant may not fill (an earlier participant
  first, or paused) the bar says so. Field labels are the document's content. The fields
  themselves are the core's node views (FRW-079); the core decides which are the participant's.
-->
<script lang="ts">
  import '../i18n/late/fillBar.ts';
  import type { FillSummary, ReadView } from '../core-api.ts';
  import { useShell } from '../context.ts';
  import { live } from '../live.ts';
  import { fillProgress } from '../shell/fill.ts';
  import AccessCodeForm from './AccessCodeForm.svelte';

  interface Props {
    fill: ReadView<FillSummary | null>;
    onFinish: () => void;
  }

  let { fill, onFinish }: Props = $props();

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  // svelte-ignore state_referenced_locally
  const view = live(fill);
  const summary = $derived(view.current);
  const progress = $derived(summary ? fillProgress(summary) : null);

  function next(): void {
    const target = progress?.next;
    if (target) shell.core.focusField?.(target.id);
  }
</script>

{#if summary && progress}
  <div class="de-fill-bar" role="region" aria-label={tr.t('fill.label')} lang={tr.locale}>
    {#if !summary.active && summary.inactive === 'unverified' && shell.core.accessCode}
      <AccessCodeForm service={shell.core.accessCode} />
    {:else if !summary.active}
      <span data-status="fill-inactive"
        >{summary.inactive === 'paused' ? tr.t('fill.paused') : tr.t('fill.waiting')}</span
      >
    {:else}
      <span data-status="fill-progress"
        >{tr.t('fill.progress', { done: progress.done, count: progress.total })}</span
      >
      {#if progress.next}
        <button type="button" class="de-action" onclick={next}>{tr.t('fill.next')}</button>
      {:else}
        <span data-status="fill-done">{tr.t('fill.done')}</span>
      {/if}
      <button
        type="button"
        class="de-action"
        aria-pressed={shell.panes.isOpen('fill')}
        onclick={() => shell.panes.toggle('fill')}>{tr.t('fill.summary')}</button
      >
      <button type="button" class="de-action" onclick={() => onFinish()}
        >{tr.t('fill.finish')}</button
      >
    {/if}
  </div>
{/if}
