<!--
  Presence avatars in the header (UX-026; 13 §5). One entry per person from the core's presence
  view, which holds only what this user may see (ADR 0019); names and avatars come from the host's
  directory (UX-025) and are shown as text and as an image address, never as markup. Idle people
  have a dashed outline and the word "idle" in their name: the two states never differ by colour
  alone. When not everyone fits, a "+n" button discloses the full list.
-->
<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import type { PresencePeer, ReadView } from '../core-api.ts';
  import { useShell } from '../context.ts';
  import { live } from '../live.ts';
  import type { Person } from '../people/directory.ts';
  import { colourSlot, initials, peopleOf, visibleAvatars } from '../shell/presence.ts';
  import { useSuspension } from '../shell/suspension.ts';

  interface Props {
    presence: ReadView<readonly PresencePeer[]>;
  }

  let { presence }: Props = $props();
  const suspended = useSuspension();

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const peers = $derived(live(presence));
  const directory = live(shell.people.view);
  const id = shell.idPrefix;

  const people = $derived(peopleOf(peers.current));

  $effect(() => {
    shell.people.request(people.map((p) => p.user));
  });

  interface Shown {
    readonly user: string;
    readonly status: 'active' | 'idle';
    readonly person: Person;
    readonly name: string;
    readonly slot: number;
  }

  const shown: Shown[] = $derived.by(() => {
    void directory.current;
    return people.map((p) => {
      const person = shell.people.lookup(p.user, p.serviceName);
      return {
        user: p.user,
        status: p.status,
        person,
        name: person.name ?? tr.t('people.fallback'),
        slot: colourSlot(p.user),
      };
    });
  });

  let region: HTMLElement | undefined = $state();
  let list: HTMLElement | undefined = $state();
  let moreButton: HTMLButtonElement | undefined = $state();
  let available = $state(0);
  let open = $state(false);
  const failed = new SvelteSet<string>();

  $effect(() => {
    // Not observed while the shell is suspended (FE-005).
    if (!region || suspended()) return;
    const host = region;
    const observer = new ResizeObserver(() => {
      available = host.clientWidth;
    });
    observer.observe(host);
    return () => observer.disconnect();
  });

  /** Avatar size and gap come from the stylesheet (a theme can change them): measured, not assumed. */
  let avatarWidth = $state(0);
  let gap = $state(0);
  let moreWidth = $state(0);

  function measure(): void {
    if (!list) return;
    const first = list.querySelector('.de-avatar');
    if (first) avatarWidth = first.getBoundingClientRect().width;
    gap = parseFloat(getComputedStyle(list).columnGap) || 0;
    if (moreButton) moreWidth = moreButton.getBoundingClientRect().width;
  }

  $effect(() => {
    void available;
    void shown.length;
    void moreButton;
    measure();
  });

  const visible = $derived(
    visibleAvatars(shown.length, available, avatarWidth, gap, moreWidth || avatarWidth * 1.5),
  );

  const hiddenCount = $derived(shown.length - visible);

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && open) {
      open = false;
      event.preventDefault();
    }
  }

  function personLabel(p: Shown): string {
    return p.status === 'idle'
      ? tr.t('presence.person.idle', { name: p.name })
      : tr.t('presence.person.active', { name: p.name });
  }
</script>

{#if shown.length > 0}
  <div bind:this={region} class="de-presence">
    <ul bind:this={list} class="de-avatars" aria-label={tr.t('presence.label')}>
      {#each shown.slice(0, visible) as p (p.user)}
        <li class="de-person" data-user={p.user} data-status={p.status}>
          <span
            class="de-avatar de-person-{p.slot}"
            data-status={p.status}
            title={personLabel(p)}
            aria-hidden="true"
          >
            {#if p.person.avatarUrl && !failed.has(p.user)}
              <img
                src={p.person.avatarUrl}
                alt=""
                referrerpolicy="no-referrer"
                onerror={() => failed.add(p.user)}
              />
            {:else}
              <span class="de-initials" data-content>{initials(p.name)}</span>
            {/if}
          </span>
          <span class="de-visually-hidden" data-content>{personLabel(p)}</span>
        </li>
      {/each}
    </ul>
    {#if hiddenCount > 0}
      <button
        bind:this={moreButton}
        type="button"
        class="de-presence-more"
        aria-expanded={open}
        aria-controls={`${id}-presence-all`}
        aria-label={tr.t('presence.more.label', { count: hiddenCount })}
        onclick={() => (open = !open)}
        onkeydown={onKeydown}>{tr.t('presence.more', { count: hiddenCount })}</button
      >
      <div id={`${id}-presence-all`} class="de-popover de-presence-all" hidden={!open}>
        <ul aria-label={tr.t('presence.all.label')}>
          {#each shown as p (p.user)}
            <li class="de-presence-row" data-user={p.user} data-status={p.status}>
              <span class="de-avatar de-person-{p.slot}" data-status={p.status} aria-hidden="true">
                <span class="de-initials" data-content>{initials(p.name)}</span>
              </span>
              <span class="de-presence-name" data-content>{p.name}</span>
              {#if p.status === 'idle'}
                <span class="de-presence-idle">{tr.t('presence.idle')}</span>
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>
{/if}
