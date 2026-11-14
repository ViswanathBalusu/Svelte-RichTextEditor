<!--
  The header frame (UX-014; 13 §3): the title slot, the save state (UX-016), presence (UX-026) and
  the header's commands. The title comes from the host through `<slot name="title">` (or the
  `title` property); the editor never fetches or edits titles. A button for an optional feature
  (comments, catch-up) exists only when the backend announced the feature, and a count on it is
  part of its accessible name. The host can hide the header (`header="none"`).
-->
<script lang="ts">
  import { HEADER_GROUP } from '../commands/builtin.ts';
  import type { CommandView } from '../commands/types.ts';
  import { useShell } from '../context.ts';
  import { live } from '../live.ts';
  import type { StringKey } from '../i18n/en-GB.ts';
  import ModeSwitcher from './ModeSwitcher.svelte';
  import Presence from './Presence.svelte';
  import SaveState from './SaveState.svelte';

  interface Props {
    /** Fallback title when the host fills no title slot. */
    title?: string | undefined;
  }

  let { title }: Props = $props();

  const shell = useShell()!;
  const core = shell.core;
  const tr = $derived(shell.strings.current);
  const snapshot = live(shell.registry.view);
  const features = core.features ? live(core.features) : null;
  const counts = core.counts ? live(core.counts) : null;

  const presenceOn = $derived((features?.current ?? []).includes('presence'));
  const actions = $derived(
    snapshot.current.commands.filter((c) => c.offered && c.entry.group === HEADER_GROUP),
  );

  const COUNT_KEYS: Readonly<Record<string, { key: StringKey; count: 'comments' | 'catchUp' }>> = {
    'view.comments': { key: 'count.comments', count: 'comments' },
    'view.catchUp': { key: 'count.catchUp', count: 'catchUp' },
  };

  function countOf(action: CommandView): number | undefined {
    const spec = COUNT_KEYS[action.id];
    if (!spec) return undefined;
    const value = counts?.current[spec.count];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  function nameOf(action: CommandView): string | undefined {
    const spec = COUNT_KEYS[action.id];
    const count = countOf(action);
    return spec && count !== undefined ? tr.t(spec.key, { count }) : undefined;
  }
</script>

<div
  part="header"
  class="de-header"
  role="region"
  aria-label={tr.t('header.label')}
  data-landmark="header"
  lang={tr.locale}
>
  <div class="de-header-title" data-content={title ? '' : undefined}>
    <svelte:element this={'slot'} name="title">{title ?? tr.t('header.title.fallback')}</svelte:element>
  </div>
  {#if core.status}
    <SaveState status={core.status} />
  {/if}
  <ModeSwitcher />
  {#if presenceOn && core.presence}
    <Presence presence={core.presence} />
  {:else}
    <div class="de-header-space"></div>
  {/if}
  {#if actions.length > 0}
    <div class="de-header-actions" role="group" aria-label={tr.t('header.actions')}>
      {#each actions as action (action.id)}
        {@const count = countOf(action)}
        <button
          type="button"
          class="de-action"
          data-command-id={action.id}
          aria-label={nameOf(action)}
          aria-disabled={action.enabled ? undefined : 'true'}
          onclick={() => shell.registry.exec(action.id)}
        >
          <span>{tr.text(action.entry.label)}</span>
          {#if count !== undefined}
            <span class="de-count" aria-hidden="true">{tr.number(count)}</span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>
