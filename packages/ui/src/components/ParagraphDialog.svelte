<!--
  The paragraph dialog (UX-102 criterion 3; 02 §10; FE-104, FE-129): the indents and tab stops of
  the selected paragraphs as fields, the keyboard form of every drag on the ruler. Applying runs
  `setParagraphFormat`, the same command the ruler runs, so the guards are the same.
-->
<script lang="ts">
  import '../i18n/late/dialogs.ts';
  import { useShell } from '../context.ts';
  import type { ParagraphFormatView, TabStopView } from '../core-api.ts';
  import { dialogFields, dialogPatch, type DialogField } from '../shell/paragraph-dialog.ts';
  import { MAX_TABS } from '../shell/ruler.ts';
  import Dialog from './Dialog.svelte';

  interface Props {
    format: ParagraphFormatView;
    /** Runs the patch; true when the core took it. */
    onApply: (patch: Record<string, unknown>) => boolean;
    onClose: () => void;
  }

  let { format, onApply, onClose }: Props = $props();

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const id = `${shell.idPrefix}-paragraph`;

  // svelte-ignore state_referenced_locally
  let fields = $state(dialogFields(format));
  let invalid = $state<readonly DialogField[]>([]);

  const ALIGNS: readonly TabStopView['align'][] = ['left', 'center', 'right', 'decimal'];
  const LEADERS: readonly TabStopView['leader'][] = [
    'none',
    'dot',
    'hyphen',
    'underscore',
    'middleDot',
    'heavy',
  ];

  const mixed = $derived(
    format.indentLeft === null ||
      format.indentRight === null ||
      format.indentFirstLine === null ||
      format.tabs === null,
  );

  function addTab(): void {
    if (fields.tabs.length >= MAX_TABS) return;
    const last = fields.tabs[fields.tabs.length - 1];
    const next = last ? Number(last.position.replace(',', '.')) + 1 : 2;
    fields.tabs.push({
      position: String(Number.isFinite(next) ? next : 2),
      align: 'left',
      leader: 'none',
    });
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    const result = dialogPatch(format, { ...fields, tabs: fields.tabs.map((row) => ({ ...row })) });
    invalid = result.invalid;
    if (result.invalid.length > 0) return;
    if (result.patch === null) {
      onClose();
      return;
    }
    if (onApply(result.patch)) onClose();
  }

  const bad = (field: DialogField): boolean => invalid.includes(field);
</script>

<Dialog name="paragraph" title={tr.t('dialog.paragraph.title')} {onClose}>
  <form class="de-form" onsubmit={submit}>
    {#if mixed}
      <p class="de-hint">{tr.t('dialog.paragraph.mixed')}</p>
    {/if}
    {#each [{ key: 'left', label: 'dialog.paragraph.left' }, { key: 'right', label: 'dialog.paragraph.right' }, { key: 'firstLine', label: 'dialog.paragraph.firstLine' }] as const as row, i (row.key)}
      <label class="de-field" for={`${id}-${row.key}`}>{tr.t(row.label)}</label>
      <input
        id={`${id}-${row.key}`}
        class="de-input"
        type="text"
        inputmode="decimal"
        autocomplete="off"
        data-autofocus={i === 0 ? '' : undefined}
        bind:value={fields[row.key]}
        aria-invalid={bad(row.key) ? 'true' : undefined}
        aria-describedby={bad(row.key) ? `${id}-error` : undefined}
      />
    {/each}
    <fieldset class="de-fieldset">
      <legend>{tr.t('dialog.paragraph.tabs')}</legend>
      {#if fields.tabs.length === 0}
        <p class="de-hint">{tr.t('dialog.paragraph.tabs.none')}</p>
      {/if}
      {#each fields.tabs as row, i (i)}
        <div class="de-paragraph-tab">
          <input
            class="de-input"
            type="text"
            inputmode="decimal"
            autocomplete="off"
            aria-label={tr.t('dialog.paragraph.tabs.position', { n: i + 1 })}
            bind:value={row.position}
            aria-invalid={bad(`tab${i}`) ? 'true' : undefined}
            aria-describedby={bad(`tab${i}`) ? `${id}-error` : undefined}
          />
          <select
            class="de-input"
            aria-label={tr.t('dialog.paragraph.tabs.align', { n: i + 1 })}
            bind:value={row.align}
          >
            {#each ALIGNS as align (align)}
              <option value={align}>{tr.t(`dialog.paragraph.align.${align}`)}</option>
            {/each}
          </select>
          <select
            class="de-input"
            aria-label={tr.t('dialog.paragraph.tabs.leader', { n: i + 1 })}
            bind:value={row.leader}
          >
            {#each LEADERS as leader (leader)}
              <option value={leader}>{tr.t(`dialog.paragraph.leader.${leader}`)}</option>
            {/each}
          </select>
          <button
            type="button"
            class="de-button"
            onclick={() => fields.tabs.splice(i, 1)}
            >{tr.t('dialog.paragraph.tabs.remove', { n: i + 1 })}</button
          >
        </div>
      {/each}
      <button
        type="button"
        class="de-button"
        disabled={fields.tabs.length >= MAX_TABS}
        onclick={addTab}>{tr.t('dialog.paragraph.tabs.add')}</button
      >
    </fieldset>
    {#if invalid.length > 0}
      <p class="de-error" id={`${id}-error`} role="alert">{tr.t('dialog.paragraph.invalid')}</p>
    {/if}
    <div class="de-dialog-actions">
      <button type="submit" class="de-button de-button-primary">{tr.t('dialog.apply')}</button>
      <button type="button" class="de-button" onclick={() => onClose()}
        >{tr.t('dialog.cancel')}</button
      >
    </div>
  </form>
</Dialog>
