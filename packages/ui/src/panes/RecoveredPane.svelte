<!--
  Recovered edits (UX-017; 13 §3, §9; 07 §9; 05 §8.1 `de-recovered-edits`): work the server
  rejected or the client set aside, with the reason in words, the region it was in when this
  reader may see its title, and who changed the permission when that is known. Each item can be
  copied out, inserted at the caret (through the registry and the core's guards, like typing) or
  discarded, which needs a second, deliberate step; nothing leaves the pane by itself. The text is
  the author's own words.
-->
<script lang="ts">
  import { useShell } from '../context.ts';
  import type { RecoveredItem } from '../core-api.ts';
  import type { StringKey } from '../i18n/en-GB.ts';
  import { live } from '../live.ts';
  import { changedByLine, refusedParts } from '../shell/rejection-words.ts';

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const core = shell.core;
  const recovered = core.recovered ? live(core.recovered) : null;
  const regions = core.regions ? live(core.regions) : null;
  const directory = live(shell.people.view);
  const snapshot = live(shell.registry.view);

  const items = $derived(recovered?.current.items ?? []);
  let confirming = $state<string | null>(null);

  const WHY: Readonly<Record<string, StringKey>> = {
    permission_denied: 'recovered.why.permission',
    forbidden: 'recovered.why.permission',
    read_only: 'recovered.why.readOnly',
    invalid_op: 'recovered.why.invalid',
    conflict: 'recovered.why.conflict',
    field_invalid: 'recovered.why.field',
    too_large: 'recovered.why.tooLarge',
    rebase: 'recovered.why.rebase',
    rebase_failed: 'recovered.why.rebase',
    stale: 'recovered.why.rebase',
    stale_base: 'recovered.why.rebase',
    reload: 'recovered.why.reload',
    reset: 'recovered.why.reload',
  };

  function keyOf(item: RecoveredItem, index: number): string {
    return item.id ?? String(index);
  }

  /** The parts refused, in words: regions by title, or body, definitions, header or footer (PRM-024). */
  function partsOf(item: RecoveredItem): string[] {
    return refusedParts(item, regions?.current ?? [], tr);
  }

  /** Who changed the permissions, named through the directory, or null when unknown (PRM-024). */
  function changedBy(item: RecoveredItem): string | null {
    void directory.current;
    if (!item.changedBy) return null;
    shell.people.request([item.changedBy]);
    return changedByLine(item, tr, (p) => shell.people.lookup(p).name ?? tr.t('people.fallback'));
  }

  const insertCommand = $derived(
    snapshot.current.commands.find((c) => c.id === 'edit.insertRecovered' && c.offered) ?? null,
  );
  const discardCommand = $derived(
    snapshot.current.commands.find((c) => c.id === 'edit.discardRecovered' && c.offered) ?? null,
  );

  async function copy(item: RecoveredItem): Promise<void> {
    try {
      await navigator.clipboard.writeText(item.text);
      shell.announce('announce.recovered.copied');
    } catch {
      shell.announce('announce.recovered.copyFailed');
    }
  }

  function insert(item: RecoveredItem, index: number): void {
    const result = shell.registry.exec('edit.insertRecovered', { id: keyOf(item, index) });
    if (result.ran) shell.announce('announce.recovered.inserted');
    else if (insertCommand && !insertCommand.enabled && insertCommand.reasonKey)
      shell.announceText(tr.text(insertCommand.reasonKey));
    else shell.announce('announce.recovered.notInserted');
  }

  function discard(item: RecoveredItem, index: number): void {
    const result = shell.registry.exec('edit.discardRecovered', { id: keyOf(item, index) });
    confirming = null;
    if (result.ran) shell.announce('announce.recovered.discarded');
  }
</script>

<section class="de-recovered" aria-label={tr.t('recovered.label')}>
  {#if items.length === 0}
    <p>{tr.t('recovered.empty')}</p>
  {:else}
    <ol class="de-list de-recovered-list">
      {#each items as item, i (keyOf(item, i))}
        {@const key = keyOf(item, i)}
        {@const parts = partsOf(item)}
        {@const who = changedBy(item)}
        <li class="de-recovered-item" data-item={key} data-reason={item.reason}>
          <p class="de-recovered-why">
            <span class="de-notice-mark" aria-hidden="true"></span>
            <span>{tr.t(WHY[item.reason] ?? 'recovered.why.other')}</span>
          </p>
          {#each parts as part (part)}
            <p class="de-hint" data-part>{part}</p>
          {/each}
          {#if who}
            <p class="de-hint">{who}</p>
          {/if}
          <blockquote class="de-recovered-text" data-content>{item.text}</blockquote>
          {#if confirming === key}
            <p>{tr.t('recovered.discard.question')}</p>
            <div class="de-actions">
              <button
                type="button"
                class="de-button de-button-danger"
                {@attach (node) => node.focus()}
                onclick={() => discard(item, i)}>{tr.t('recovered.discard.confirm')}</button
              >
              <button type="button" class="de-button" onclick={() => (confirming = null)}
                >{tr.t('recovered.discard.keep')}</button
              >
            </div>
          {:else}
            <div class="de-actions">
              <button type="button" class="de-button" onclick={() => void copy(item)}
                >{tr.t('recovered.copy')}</button
              >
              {#if insertCommand}
                <button
                  type="button"
                  class="de-button"
                  aria-disabled={insertCommand.enabled ? undefined : 'true'}
                  onclick={() => insert(item, i)}>{tr.t('recovered.insert')}</button
                >
              {/if}
              {#if discardCommand}
                <button type="button" class="de-button" onclick={() => (confirming = key)}
                  >{tr.t('recovered.discard')}</button
                >
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</section>
