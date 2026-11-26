<!--
  Insert a citation (FE-140 criterion 1; 03 §4.4 `citation`; 13 §2). The document's sources are
  listed; the person ticks one or more, in the order they are to be cited, and may give each a
  prefix, a locator and a suffix. The core inserts a citation node at the caret through the same
  guards as typing; the text of the citation is generated from the citation style. Every control is
  a native one, so the dialog is operated from the keyboard alone.
-->
<script lang="ts">
  import '../i18n/late/dialogs.ts';
  import type { SourceSummary } from '../core-api.ts';
  import { useShell } from '../context.ts';
  import { sourceLine } from '../shell/sources.ts';
  import Dialog from './Dialog.svelte';

  type Mode = 'normal' | 'narrative' | 'suppressAuthor';
  interface Item {
    source: string;
    prefix?: string;
    suffix?: string;
    locator?: string;
  }

  interface Props {
    sources: readonly SourceSummary[];
    onInsert: (items: readonly Item[], mode: Mode) => void;
    onClose: () => void;
  }

  let { sources, onInsert, onClose }: Props = $props();

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const id = `${shell.idPrefix}-citation`;

  /** The most sources the CDM lets one citation cite (citations.ts). */
  const MAX_ITEMS = 32;
  const MODES: readonly Mode[] = ['normal', 'narrative', 'suppressAuthor'];

  /** The chosen sources, in the order they were chosen, each with its optional parts. */
  let picked = $state<{ source: string; prefix: string; locator: string; suffix: string }[]>([]);
  let mode = $state<Mode>('normal');

  const name = (source: SourceSummary): string => sourceLine(source).title || source.id;
  const chosen = (source: SourceSummary) => picked.find((p) => p.source === source.id);

  function toggle(source: SourceSummary, on: boolean): void {
    if (!on) picked = picked.filter((p) => p.source !== source.id);
    else if (!chosen(source) && picked.length < MAX_ITEMS)
      picked.push({ source: source.id, prefix: '', locator: '', suffix: '' });
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (picked.length === 0) return;
    onInsert(
      picked.map((p) => ({
        source: p.source,
        ...(p.prefix.trim() === '' ? {} : { prefix: p.prefix.trim() }),
        ...(p.locator.trim() === '' ? {} : { locator: p.locator.trim() }),
        ...(p.suffix.trim() === '' ? {} : { suffix: p.suffix.trim() }),
      })),
      mode,
    );
  }
</script>

<Dialog name="citation" title={tr.t('dialog.citation.title')} {onClose}>
  <form class="de-form" onsubmit={submit}>
    {#if sources.length === 0}
      <p class="de-hint" role="status">{tr.t('dialog.citation.empty')}</p>
    {:else}
      <fieldset class="de-fieldset">
        <legend>{tr.t('dialog.citation.sources')}</legend>
        {#each sources as source, i (source.id)}
          {@const own = chosen(source)}
          <label class="de-check">
            <input
              type="checkbox"
              checked={own !== undefined}
              data-autofocus={i === 0 ? '' : undefined}
              onchange={(event) => toggle(source, event.currentTarget.checked)}
            />
            <span data-citation-source={source.id}>{name(source)}</span>
          </label>
          {#if own}
            <div class="de-paragraph-tab">
              <input
                class="de-input"
                type="text"
                autocomplete="off"
                aria-label={tr.t('dialog.citation.prefix', { source: name(source) })}
                bind:value={own.prefix}
              />
              <input
                class="de-input"
                type="text"
                autocomplete="off"
                aria-label={tr.t('dialog.citation.locator', { source: name(source) })}
                bind:value={own.locator}
              />
              <input
                class="de-input"
                type="text"
                autocomplete="off"
                aria-label={tr.t('dialog.citation.suffix', { source: name(source) })}
                bind:value={own.suffix}
              />
            </div>
          {/if}
        {/each}
      </fieldset>
      <label class="de-field" for={`${id}-mode`}>{tr.t('dialog.citation.mode')}</label>
      <select id={`${id}-mode`} class="de-input" bind:value={mode}>
        {#each MODES as m (m)}
          <option value={m}>{tr.t(`dialog.citation.mode.${m}`)}</option>
        {/each}
      </select>
      <p class="de-hint">{tr.t('dialog.citation.hint')}</p>
    {/if}
    <div class="de-dialog-actions">
      <button
        type="submit"
        class="de-button de-button-primary"
        disabled={picked.length === 0 || sources.length === 0}
        >{tr.t('dialog.citation.insert')}</button
      >
      <button type="button" class="de-button" onclick={() => onClose()}
        >{tr.t('dialog.cancel')}</button
      >
    </div>
  </form>
</Dialog>
