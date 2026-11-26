<!--
  The table size dialog (FE-104 criterion 1; 02 §10): the width of every column and the height of the
  caret's row as fields, the keyboard form of dragging a column border or a row edge. Applying runs
  `setTableSize`, so the guards and the stored values are the ones a drag would meet.
-->
<script lang="ts">
  import '../i18n/late/dialogs.ts';
  import { useShell } from '../context.ts';
  import type { TableSizeView } from '../core-api.ts';
  import {
    tableSizeArgs,
    tableSizeFields,
    type TableSizeField,
  } from '../shell/table-size-dialog.ts';
  import Dialog from './Dialog.svelte';

  interface Props {
    view: TableSizeView;
    /** Runs the arguments; true when the core took them. */
    onApply: (args: Record<string, unknown>) => boolean;
    onClose: () => void;
  }

  let { view, onApply, onClose }: Props = $props();

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const id = `${shell.idPrefix}-table-size`;

  // svelte-ignore state_referenced_locally
  let fields = $state(tableSizeFields(view));
  let invalid = $state<readonly TableSizeField[]>([]);

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    const result = tableSizeArgs(view, { ...fields, columns: [...fields.columns] });
    invalid = result.invalid;
    if (result.invalid.length > 0) return;
    if (result.args === null) {
      onClose();
      return;
    }
    if (onApply(result.args)) onClose();
  }

  const bad = (field: TableSizeField): boolean => invalid.includes(field);
</script>

<Dialog name="tableSize" title={tr.t('dialog.tableSize.title')} {onClose}>
  <form class="de-form" onsubmit={submit}>
    <fieldset class="de-fieldset">
      <legend>{tr.t('dialog.tableSize.columns')}</legend>
      {#each fields.columns as _, i (i)}
        <label class="de-field" for={`${id}-column${i}`}
          >{tr.t('dialog.tableSize.column', { n: i + 1 })}</label
        >
        <input
          id={`${id}-column${i}`}
          class="de-input"
          type="text"
          inputmode="decimal"
          autocomplete="off"
          data-autofocus={i === view.column ? '' : undefined}
          bind:value={fields.columns[i]}
          aria-invalid={bad(`column${i}`) ? 'true' : undefined}
          aria-describedby={bad(`column${i}`) ? `${id}-error` : undefined}
        />
      {/each}
    </fieldset>
    <label class="de-field" for={`${id}-row`}
      >{tr.t('dialog.tableSize.row', { n: view.row + 1 })}</label
    >
    <input
      id={`${id}-row`}
      class="de-input"
      type="text"
      inputmode="decimal"
      autocomplete="off"
      bind:value={fields.rowHeight}
      aria-invalid={bad('rowHeight') ? 'true' : undefined}
      aria-describedby={bad('rowHeight') ? `${id}-error` : `${id}-hint`}
    />
    <p class="de-hint" id={`${id}-hint`}>{tr.t('dialog.tableSize.hint')}</p>
    {#if invalid.length > 0}
      <p class="de-error" id={`${id}-error`} role="alert">{tr.t('dialog.tableSize.invalid')}</p>
    {/if}
    <div class="de-dialog-actions">
      <button type="submit" class="de-button de-button-primary">{tr.t('dialog.apply')}</button>
      <button type="button" class="de-button" onclick={() => onClose()}
        >{tr.t('dialog.cancel')}</button
      >
    </div>
  </form>
</Dialog>
