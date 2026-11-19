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
  import { capabilitiesAnywhere } from '../shell/modes.ts';
  import { lockBanner, reuseSeq, type LockBanner } from '../shell/workflow-lock.ts';

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

  // A declined or voided document can be reused: the owner asks the host to copy it as it was sent,
  // and the host calls the fork with its service credential (FRW-033 criterion 5; HIS-022).
  // svelte-ignore state_referenced_locally
  const sentSeq = service.sentSeq ? live(service.sentSeq) : null;
  const permissions = shell.core.permissions ? live(shell.core.permissions) : null;
  const manage = $derived(
    permissions ? capabilitiesAnywhere(permissions.current).has('manage') : false,
  );
  const reuse = $derived(
    reuseSeq(
      state.current,
      sentSeq?.current ?? null,
      manage,
      shell.requestFork !== undefined,
    ),
  );

  function requestReuse(): void {
    if (reuse === null || shell.requestFork === undefined) return;
    shell.requestFork(reuse);
    shell.announce('workflow.banner.reuseRequested');
  }
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
    {#if reuse !== null}
      <button type="button" class="de-list-button" data-workflow-reuse onclick={requestReuse}>
        {tr.t('workflow.banner.reuse')}
      </button>
    {/if}
  </div>
{/if}
