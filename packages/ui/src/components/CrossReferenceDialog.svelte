<!--
  Insert a cross-reference (FE-134 criterion 2; 03 §4.4 `ref`). The core lists what a reference may
  point at: numbered headings, numbered paragraphs, captions, labelled equations and bookmarks on
  numbered blocks. The person picks one and a format, and the core inserts a `ref` field at the
  caret through the same guards as typing. The reference prints the number of its target and follows
  it when content moves. The texts of the targets are the document's content.
-->
<script lang="ts">
  import '../i18n/late/dialogs.ts';
  import type { ReferenceTargetItem } from '../core-api.ts';
  import { useShell } from '../context.ts';
  import Dialog from './Dialog.svelte';

  interface Props {
    targets: readonly ReferenceTargetItem[];
    onInsert: (target: string, format: string | null) => void;
    onClose: () => void;
  }

  let { targets, onInsert, onClose }: Props = $props();

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const id = `${shell.idPrefix}-cross-ref`;

  type Kind = ReferenceTargetItem['kind'];
  const KINDS: readonly Kind[] = ['heading', 'numbered', 'caption', 'equation', 'bookmark'];

  let kind = $state<'all' | Kind>('all');
  let chosen = $state<string | null>(null);
  let format = $state<'number' | 'page'>('number');

  // Only the kinds the document has are offered as filters.
  const present = $derived(KINDS.filter((k) => targets.some((t) => t.kind === k)));
  const shown = $derived(kind === 'all' ? targets : targets.filter((t) => t.kind === kind));

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (chosen !== null) onInsert(chosen, format === 'page' ? 'page' : null);
  }
</script>

<Dialog name="cross-reference" title={tr.t('dialog.crossRef.title')} {onClose}>
  <form class="de-form" onsubmit={submit}>
    {#if targets.length === 0}
      <p class="de-hint" role="status">{tr.t('dialog.crossRef.empty')}</p>
    {:else}
      <label class="de-field" for={`${id}-kind`}>{tr.t('dialog.crossRef.kind')}</label>
      <select
        id={`${id}-kind`}
        class="de-input"
        data-autofocus
        bind:value={kind}
        onchange={() => (chosen = null)}
      >
        <option value="all">{tr.t('dialog.crossRef.kind.all')}</option>
        {#each present as k (k)}
          <option value={k}>{tr.t(`dialog.crossRef.kind.${k}`)}</option>
        {/each}
      </select>

      <fieldset class="de-fieldset">
        <legend>{tr.t('dialog.crossRef.list')}</legend>
        {#each shown as t (t.target)}
          <label class="de-check">
            <input type="radio" name={`${id}-target`} value={t.target} bind:group={chosen} />
            <span data-cross-ref-target={t.target}
              >{tr.t('dialog.crossRef.item', { text: t.text, label: t.label })}</span
            >
          </label>
        {/each}
      </fieldset>

      <fieldset class="de-fieldset">
        <legend>{tr.t('dialog.crossRef.format')}</legend>
        <label class="de-check">
          <input type="radio" name={`${id}-format`} value="number" bind:group={format} />
          <span>{tr.t('dialog.crossRef.format.number')}</span>
        </label>
        <label class="de-check">
          <input type="radio" name={`${id}-format`} value="page" bind:group={format} />
          <span>{tr.t('dialog.crossRef.format.page')}</span>
        </label>
      </fieldset>
      <p class="de-hint" id={`${id}-hint`}>{tr.t('dialog.crossRef.hint')}</p>
    {/if}
    <div class="de-dialog-actions">
      <button
        type="submit"
        class="de-button de-button-primary"
        disabled={chosen === null || targets.length === 0}>{tr.t('dialog.crossRef.insert')}</button
      >
      <button type="button" class="de-button" onclick={() => onClose()}
        >{tr.t('dialog.cancel')}</button
      >
    </div>
  </form>
</Dialog>
