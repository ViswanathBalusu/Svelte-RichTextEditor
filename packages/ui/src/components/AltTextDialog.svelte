<!--
  Ask for the alternative text of a picture that has just been inserted (FE-132 criterion 5). The
  text is for people who cannot see the picture, so it is asked for at once; "Later" closes the
  dialog and leaves the picture without text, and the accessibility checker lists it (UX-066).
  Applying runs the core's `setAltText` through the registry's guards, as typing is.
-->
<script lang="ts">
  import '../i18n/late/dialogs.ts';
  import { useShell } from '../context.ts';
  import Dialog from './Dialog.svelte';

  interface Props {
    onApply: (alt: string) => void;
    onClose: () => void;
  }

  let { onApply, onClose }: Props = $props();

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const id = `${shell.idPrefix}-alt-text`;

  let text = $state('');
  const blank = $derived(text.trim() === '');

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (!blank) onApply(text.trim());
  }
</script>

<Dialog name="alt-text" title={tr.t('dialog.altText.title')} {onClose}>
  <form class="de-form" onsubmit={submit}>
    <label class="de-field" for={`${id}-text`}>{tr.t('dialog.altText.field')}</label>
    <textarea
      id={`${id}-text`}
      class="de-input"
      rows="3"
      data-autofocus
      bind:value={text}
      aria-describedby={`${id}-hint`}
    ></textarea>
    <p class="de-hint" id={`${id}-hint`}>{tr.t('dialog.altText.hint')}</p>
    <div class="de-dialog-actions">
      <button type="submit" class="de-button de-button-primary" disabled={blank}
        >{tr.t('dialog.apply')}</button
      >
      <button type="button" class="de-button" onclick={() => onClose()}
        >{tr.t('dialog.altText.later')}</button
      >
    </div>
  </form>
</Dialog>
