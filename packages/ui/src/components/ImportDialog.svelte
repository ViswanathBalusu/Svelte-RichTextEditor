<!--
  Import a file through the client import filters of extensions (UX-055; 13 §7.1). The author
  chooses a file; the filter that reads its extension produces a CDM fragment, and the core inserts
  it in place of the selection through the guards of typing (`CoreApi.insertContent`, FE-027): the
  region guard, the identifier plugin and the read restrictions. A filter that throws, or a
  fragment the core refuses, is reported here and in the shell's live region, and the document is
  unchanged. The formats are listed with the labels the extensions gave them.
-->
<script lang="ts">
  import '../i18n/late/dialogs.ts';
  import { onDestroy } from 'svelte';
  import { useShell } from '../context.ts';
  import type { FilterRegistry } from '../extensions/filters.ts';
  import { live } from '../live.ts';
  import Dialog from './Dialog.svelte';

  interface Props {
    /** The registry that holds the extensions' import filters. */
    filters: FilterRegistry;
    onClose: () => void;
  }

  let { filters, onClose }: Props = $props();

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const id = `${shell.idPrefix}-import`;
  // svelte-ignore state_referenced_locally
  const changes = live(filters.view);
  const choices = $derived.by(() => {
    void changes.current;
    return filters.choices('import');
  });
  const accept = $derived.by(() => {
    void changes.current;
    return filters.importExtensions().join(',');
  });

  let file = $state<File | null>(null);
  let busy = $state(false);
  let done = $state<string | null>(null);
  let failed = $state(false);
  let refused = $state<string | null>(null);
  let unknownType = $state(false);
  let closed = false;
  onDestroy(() => {
    closed = true;
  });

  function choose(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    file = input.files?.[0] ?? null;
    done = null;
    failed = false;
    refused = null;
    unknownType = false;
  }

  async function start(event: Event): Promise<void> {
    event.preventDefault();
    const chosen = file;
    if (!chosen || busy) return;
    done = null;
    failed = false;
    refused = null;
    const filter = filters.importFor(chosen.name);
    unknownType = filter === null;
    if (!filter) return;
    busy = true;
    let message = '';
    let outcome: Awaited<ReturnType<FilterRegistry['runImport']>>;
    try {
      const bytes = new Uint8Array(await chosen.arrayBuffer());
      outcome = await filters.runImport(
        filter.id,
        { bytes, name: chosen.name },
        (fragment) => {
          const result = shell.core.insertContent?.(fragment);
          if (result && !result.ok) message = result.message;
          return result?.ok === true;
        },
      );
    } catch (error) {
      outcome = { ok: false, reason: 'failed', error };
    }
    busy = false;
    if (closed) return;
    if (outcome.ok) {
      done = chosen.name;
      shell.announce('announce.import.completed');
    } else if (outcome.reason === 'refused') {
      refused = message;
      shell.announce('announce.import.failed');
    } else {
      failed = true;
      shell.announce('announce.import.failed');
    }
  }
</script>

<Dialog name="import" title={tr.t('dialog.import.title')} {onClose}>
  {#if choices.length === 0}
    <p class="de-hint" data-import="none">{tr.t('dialog.import.none')}</p>
  {:else}
    <form class="de-form" onsubmit={start}>
      <p id={`${id}-formats`}>{tr.t('dialog.import.format')}</p>
      <ul aria-labelledby={`${id}-formats`} data-import="formats">
        {#each choices as c (c.id)}
          <li data-import-format={c.id}>{c.label}</li>
        {/each}
      </ul>
      <label class="de-field">
        <span>{tr.t('dialog.import.file')}</span>
        <input type="file" {accept} onchange={choose} data-import="file" />
      </label>
      <button type="submit" class="de-button" disabled={busy || file === null} data-import="start"
        >{tr.t('dialog.import.start')}</button
      >
    </form>
    {#if done}
      <p role="status" data-import="done">{tr.t('import.filter.done', { name: done })}</p>
    {/if}
    {#if failed}
      <p role="alert" data-import="failed">{tr.t('import.filter.failed')}</p>
    {/if}
    {#if refused !== null}
      <p role="alert" data-import="refused">{tr.t('import.filter.refused', { message: refused })}</p>
    {/if}
    {#if unknownType}
      <p role="alert" data-import="unknown">{tr.t('dialog.import.none')}</p>
    {/if}
  {/if}
</Dialog>
