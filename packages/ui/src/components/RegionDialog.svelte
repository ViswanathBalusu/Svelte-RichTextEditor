<!--
  Mark the selected blocks as a region (PRM-033; 07 §2, §5.2 P2): the author gives a title, and the
  core wraps the blocks in a region with policy `inherit` through the same guards as typing. Who
  may edit it is then set in the permissions pane (PRM-035). The title is the author's content.
-->
<script lang="ts">
  import { useShell } from '../context.ts';
  import Dialog from './Dialog.svelte';

  interface Props {
    onCreate: (title: string) => void;
    onClose: () => void;
  }

  let { onCreate, onClose }: Props = $props();

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const id = `${shell.idPrefix}-region`;

  let title = $state('');
  let tried = $state(false);
  const empty = $derived(title.trim() === '');

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    tried = true;
    if (!empty) onCreate(title.trim());
  }
</script>

<Dialog name="region" title={tr.t('dialog.region.title')} {onClose}>
  <form class="de-form" onsubmit={submit} novalidate>
    <label class="de-field" for={`${id}-title`}>{tr.t('dialog.region.field')}</label>
    <input
      id={`${id}-title`}
      class="de-input"
      type="text"
      autocomplete="off"
      required
      data-autofocus
      bind:value={title}
      aria-invalid={tried && empty ? 'true' : undefined}
      aria-describedby={tried && empty ? `${id}-hint ${id}-error` : `${id}-hint`}
    />
    <p class="de-hint" id={`${id}-hint`}>{tr.t('dialog.region.hint')}</p>
    {#if tried && empty}
      <p class="de-error" id={`${id}-error`}>{tr.t('dialog.region.empty')}</p>
    {/if}
    <div class="de-dialog-actions">
      <button type="submit" class="de-button de-button-primary"
        >{tr.t('dialog.region.create')}</button
      >
      <button type="button" class="de-button" onclick={() => onClose()}
        >{tr.t('dialog.cancel')}</button
      >
    </div>
  </form>
</Dialog>
