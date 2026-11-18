<!--
  Send for completion (FRW-028; 12 §6.2, §11): the pre-send checklist and the send control. The four
  checks are listed with a word and an icon each, never colour alone. A failed check has a link to
  what fixes it: the field, the roles, the rules or the suggestion. The send control asks for
  confirmation; it is off, with the reason in words, for a reader without `manage`, for a workflow
  that is no longer a draft and while a check fails. When the server refuses a send the editor
  thought valid, its verdict replaces the list. A change in the number of failed checks is
  announced in a live region inside the dialog (the rest of the page is inert while it is open).
  The rows come from `shell/send-checklist.ts`; the strings are the shell's external keys.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { useShell } from '../context.ts';
  import type { WorkflowSendService } from '../core-api.ts';
  import type { StringKey } from '../i18n/en-GB.ts';
  import { live } from '../live.ts';
  import { capabilitiesAnywhere } from '../shell/modes.ts';
  import {
    checklistAnnouncement,
    checklistRows,
    sendControl,
    type ChecklistRow,
    type CheckTarget,
    type SendFailure,
  } from '../shell/send-checklist.ts';
  import Dialog from './Dialog.svelte';

  interface Props {
    service: WorkflowSendService;
    /** Called when the dialog asks to close. */
    onClose: () => void;
    /** A failed check's link: the shell closes the dialog and moves to the place. */
    onNavigate: (target: CheckTarget) => void;
    /** Called once the server has sent the document. */
    onSent?: () => void;
  }

  let { service, onClose, onNavigate, onSent }: Props = $props();

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const id = `${shell.idPrefix}-send`;

  // svelte-ignore state_referenced_locally
  const local = live(service.failures);
  // svelte-ignore state_referenced_locally
  const workflow = live(service.state);
  const permissions = shell.core.permissions ? live(shell.core.permissions) : null;
  const manage = $derived(
    permissions ? capabilitiesAnywhere(permissions.current).has('manage') : false,
  );

  // The server's verdict after it refused a send, which replaces the editor's own (criterion 4).
  let verdict = $state.raw<readonly SendFailure[] | null>(null);
  let confirming = $state(false);
  let busy = $state(false);
  let sentState = $state<string | null>(null);
  let problem = $state<'refused' | 'forbidden' | 'not_draft' | 'failed' | null>(null);

  const rows = $derived(checklistRows(verdict ?? local.current));
  const workflowState = $derived(sentState ?? workflow.current);
  const control = $derived(
    workflowState === null
      ? { enabled: false, reasonKey: 'send.control.unknown', confirm: false }
      : sendControl({ manage }, workflowState, rows),
  );

  // The live region: said when the failed checks change, and once when the dialog opens.
  let announcement = $state('');
  let before: readonly ChecklistRow[] | null = null;
  $effect(() => {
    const now = rows;
    untrack(() => {
      const said = checklistAnnouncement(before, now);
      before = now;
      if (said === null) return;
      announcement =
        said.failed === 0
          ? tr.t('send.check.announce.none')
          : tr.t('send.check.announce', { count: said.failed });
    });
  });

  // The resource is read again each time the dialog opens, so the participants are current.
  $effect(() => {
    void untrack(() => service.refresh());
  });

  function stateWord(value: string): string {
    return tr.has(`send.state.${value}`) ? tr.text(`send.state.${value}`) : value;
  }

  function linkLabel(row: ChecklistRow, item: string | null): string {
    const target = row.target;
    if (target === null) return '';
    switch (target.kind) {
      case 'field':
        return tr.t('send.link.field', { name: item ?? '' });
      case 'participants':
        return tr.t('send.link.participants', { name: item ?? '' });
      case 'rules':
        return tr.t('send.link.rules');
      case 'suggestion':
        return item === null
          ? tr.t('send.link.suggestionUnnamed')
          : tr.t('send.link.suggestion', { name: item });
    }
  }

  /** The targets of a failed row, one link for each named item; one for a row that names none. */
  function links(row: ChecklistRow): { item: string | null; target: CheckTarget }[] {
    const target = row.target;
    if (target === null) return [];
    switch (target.kind) {
      case 'field':
        return target.keys.map((key) => ({ item: key, target: { kind: 'field', keys: [key] } }));
      case 'participants':
        return target.roles.map((role) => ({
          item: role,
          target: { kind: 'participants', roles: [role] },
        }));
      case 'suggestion':
        return target.ids.length === 0
          ? [{ item: null, target }]
          : target.ids.map((suggestion) => ({
              item: suggestion,
              target: { kind: 'suggestion', ids: [suggestion] },
            }));
      case 'rules':
        return [{ item: null, target }];
    }
  }

  async function send(): Promise<void> {
    if (!control.enabled || busy) return;
    busy = true;
    problem = null;
    try {
      const outcome = await service.send();
      if (outcome.ok) {
        sentState = outcome.state;
        confirming = false;
        shell.announce('announce.workflow.sent');
        onSent?.();
      } else if (outcome.reason === 'checklist_failed') {
        verdict = outcome.failures;
        confirming = false;
        problem = 'refused';
      } else {
        confirming = false;
        problem = outcome.reason;
        if (outcome.reason === 'not_draft') void service.refresh();
      }
    } catch {
      confirming = false;
      problem = 'failed';
    } finally {
      busy = false;
    }
  }

  const problemKey: Record<'refused' | 'forbidden' | 'not_draft' | 'failed', StringKey> = {
    refused: 'send.result.refused',
    forbidden: 'send.result.forbidden',
    not_draft: 'send.result.not_draft',
    failed: 'send.result.failed',
  };
</script>

<Dialog name="send" title={tr.t('dialog.send.title')} {onClose}>
  <div class="de-form de-send">
    <p class="de-hint" id={`${id}-intro`}>{tr.t('dialog.send.intro')}</p>
    <ul class="de-list de-send-checks" aria-label={tr.t('send.checks.label')}>
      {#each rows as row (row.check)}
        <li class="de-send-check" data-check={row.check} data-passed={row.passed}>
          <p class="de-send-check-head">
            <svg
              class="de-send-icon"
              data-icon={row.icon}
              viewBox="0 0 16 16"
              width="16"
              height="16"
              aria-hidden="true"
              focusable="false"
            >
              {#if row.passed}
                <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5" />
                <path d="M4.5 8.5l2.5 2.5 4.5-5" fill="none" stroke="currentColor" stroke-width="1.5" />
              {:else}
                <rect x="1.5" y="1.5" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" />
                <path d="M5 5l6 6M11 5l-6 6" fill="none" stroke="currentColor" stroke-width="1.5" />
              {/if}
            </svg>
            <span class="de-send-label">{tr.text(row.labelKey)}</span>
            <span class="de-badge" data-status={row.passed ? 'passed' : 'failed'}
              >{tr.text(row.statusKey)}</span
            >
            {#if !row.passed}
              <span class="de-hint">{tr.t('send.check.count', { count: row.count })}</span>
            {/if}
          </p>
          {#if !row.passed}
            <ul class="de-list de-send-links">
              {#each links(row) as link (link.item ?? link.target.kind)}
                <li>
                  <button
                    type="button"
                    class="de-button de-list-button"
                    data-link={link.target.kind}
                    onclick={() => onNavigate(link.target)}
                    >{linkLabel(row, link.item)}</button
                  >
                </li>
              {/each}
            </ul>
          {/if}
        </li>
      {/each}
    </ul>

    {#if problem}
      <p class="de-error" role="alert" data-problem={problem}>{tr.t(problemKey[problem])}</p>
    {/if}
    {#if sentState !== null}
      <p class="de-hint" data-sent="true">{tr.t('send.result.sent')}</p>
      <p data-workflow-state={sentState}>
        {tr.t('send.result.state', { state: stateWord(sentState) })}
      </p>
    {:else if !control.enabled && control.reasonKey}
      <p class="de-hint" id={`${id}-reason`} data-reason={control.reasonKey}>
        {tr.text(control.reasonKey)}
      </p>
    {/if}
    {#if confirming && control.enabled}
      <p class="de-hint" id={`${id}-confirm`}>{tr.t('send.control.confirmText')}</p>
    {/if}

    <div class="de-dialog-actions">
      {#if sentState !== null}
        <button type="button" class="de-button de-button-primary" onclick={() => onClose()}
          >{tr.t('dialog.close')}</button
        >
      {:else if confirming && control.enabled}
        <button
          type="button"
          class="de-button de-button-primary"
          data-autofocus
          disabled={busy}
          aria-describedby={`${id}-confirm`}
          onclick={send}>{tr.t('send.control.confirm')}</button
        >
        <button type="button" class="de-button" onclick={() => (confirming = false)}
          >{tr.t('send.control.back')}</button
        >
      {:else}
        <button
          type="button"
          class="de-button de-button-primary"
          disabled={!control.enabled}
          aria-describedby={control.enabled ? undefined : `${id}-reason`}
          onclick={() => (confirming = true)}>{tr.t('send.control.send')}</button
        >
        <button type="button" class="de-button" onclick={() => onClose()}
          >{tr.t('dialog.cancel')}</button
        >
      {/if}
    </div>
    <div class="de-visually-hidden" role="status" data-send-live>{announcement}</div>
  </div>
</Dialog>
