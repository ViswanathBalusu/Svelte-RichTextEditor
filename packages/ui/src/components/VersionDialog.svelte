<!--
  Name the current version of the document (HIS-006; 08 §4): a name and an optional note, kept with
  the document as it is now. Both are the author's text and are shown as text everywhere. The
  host's history port stores them; a refusal (the user may not name versions) and any other
  failure are said in the dialog, which stays open so that nothing typed is lost.
-->
<script lang="ts">
  import { useShell } from '../context.ts';
  import type { HistoryPort } from '../core-api.ts';
  import Dialog from './Dialog.svelte';

  interface Props {
    history: HistoryPort;
    onNamed: () => void;
    onClose: () => void;
  }

  let { history, onNamed, onClose }: Props = $props();

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const id = `${shell.idPrefix}-version`;

  let name = $state('');
  let note = $state('');
  let tried = $state(false);
  let busy = $state(false);
  let problem = $state<'forbidden' | 'failed' | null>(null);
  const empty = $derived(name.trim() === '');

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    tried = true;
    if (empty || busy || !history.createVersion) return;
    busy = true;
    problem = null;
    try {
      const result = await history.createVersion({
        name: name.trim(),
        note: note.trim() === '' ? null : note.trim(),
      });
      if (result.ok) onNamed();
      else problem = result.reason;
    } catch {
      problem = 'failed';
    } finally {
      busy = false;
    }
  }
</script>

<Dialog name="version" title={tr.t('dialog.version.title')} {onClose}>
  <form class="de-form" onsubmit={submit} novalidate>
    <label class="de-field" for={`${id}-name`}>{tr.t('dialog.version.name')}</label>
    <input
      id={`${id}-name`}
      class="de-input"
      type="text"
      autocomplete="off"
      required
      data-autofocus
      bind:value={name}
      aria-invalid={tried && empty ? 'true' : undefined}
      aria-describedby={tried && empty ? `${id}-hint ${id}-error` : `${id}-hint`}
    />
    {#if tried && empty}
      <p class="de-error" id={`${id}-error`}>{tr.t('dialog.version.empty')}</p>
    {/if}
    <label class="de-field" for={`${id}-note`}>{tr.t('dialog.version.note')}</label>
    <textarea id={`${id}-note`} class="de-input" rows="3" bind:value={note}></textarea>
    <p class="de-hint" id={`${id}-hint`}>{tr.t('dialog.version.hint')}</p>
    {#if problem}
      <p class="de-error" role="alert" data-problem={problem}>
        {tr.t(problem === 'forbidden' ? 'dialog.version.forbidden' : 'dialog.version.failed')}
      </p>
    {/if}
    <div class="de-dialog-actions">
      <button type="submit" class="de-button de-button-primary" disabled={busy}
        >{tr.t('dialog.version.save')}</button
      >
      <button type="button" class="de-button" onclick={() => onClose()}
        >{tr.t('dialog.cancel')}</button
      >
    </div>
  </form>
</Dialog>
