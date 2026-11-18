<!--
  The lock a workflow puts on the document (FRW-029 criterion 6; 12 §3.3): a line under the toolbar
  that says the document is out for completion (or that its workflow was declined or voided and the
  document stays locked) and, while it runs, who may still act. It is a region with a name, shown
  only while the workflow locks the document; the words are the shell's external strings and the
  names are the owner's text.
-->
<script lang="ts">
  import { useShell } from '../context.ts';
  import type { WorkflowSendService } from '../core-api.ts';
  import { live } from '../live.ts';
  import { lockBanner, type LockBanner } from '../shell/workflow-lock.ts';

  interface Props {
    service: WorkflowSendService;
  }

  let { service }: Props = $props();

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  // svelte-ignore state_referenced_locally
  const state = live(service.state);
  // svelte-ignore state_referenced_locally
  const participants = live(service.participants);
  const banner: LockBanner | null = $derived(lockBanner(state.current, participants.current));
</script>

{#if banner}
  <div
    class="de-workflow-banner"
    role="region"
    aria-label={tr.t('workflow.banner.label')}
    data-workflow-lock={banner.kind}
    lang={tr.locale}
  >
    <svg class="de-workflow-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <rect x="3" y="7" width="10" height="7" fill="none" stroke="currentColor" stroke-width="1.5" />
      <path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="1.5" />
    </svg>
    <span data-banner="state">{tr.text(`workflow.banner.${banner.kind}`)}</span>
    {#if banner.kind === 'running'}
      <span data-banner="actors">
        {banner.actors.length > 0
          ? tr.t('workflow.banner.actors', { names: banner.actors.join(', ') })
          : tr.t('workflow.banner.nobody')}
      </span>
    {/if}
  </div>
{/if}
