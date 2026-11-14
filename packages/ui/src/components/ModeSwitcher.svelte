<!--
  The mode switcher (UX-015; 13 §3; 05 §8.1 `mode`; 07 §7): a menu button that shows the mode in
  effect and lists the modes this build supports, each a registry command (`mode.*`). A mode the
  user may not choose is listed disabled with its reason: `edit` without edit rights, while the
  document is locked, archived or out for completion, or where the user may only suggest. The
  mode in effect is visible as text and announced when it changes (the shell does that).
-->
<script lang="ts">
  import { tick } from 'svelte';
  import { on } from 'svelte/events';
  import type { CommandView } from '../commands/types.ts';
  import { useShell } from '../context.ts';
  import { live } from '../live.ts';
  import { trackedModeFor } from '../shell/tracked-for-everyone.ts';

  const shell = useShell()!;
  const snapshot = live(shell.registry.view);
  const tr = $derived(shell.strings.current);
  const id = `${shell.idPrefix}-modes`;

  const modes: CommandView[] = $derived(
    snapshot.current.commands.filter((c) => c.offered && c.entry.group === 'mode'),
  );
  // UX-038: while `settings.trackChanges` is `everyone`, a chosen `edit` is shown as `review`, with
  // the reason (`trackedModeFor`). Without the setting the registry's own `active` flags stand.
  const coreMode = shell.core.mode ? live(shell.core.mode) : null;
  const trackedView = shell.core.trackedForEveryone ? live(shell.core.trackedForEveryone) : null;
  const effective = $derived(
    coreMode ? trackedModeFor(coreMode.current, trackedView?.current === true) : null,
  );
  const effectiveId = $derived(effective ? `mode.${effective.mode}` : null);
  const reasonShown = $derived(effective?.reason ? tr.text('reason.mode.trackedForEveryone') : null);
  const current = $derived(
    effectiveId !== null
      ? (modes.find((m) => m.id === effectiveId) ?? null)
      : (modes.find((m) => m.active === true) ?? null),
  );
  const isChecked = (m: CommandView): boolean =>
    effectiveId !== null ? m.id === effectiveId : m.active === true;

  let open = $state(false);
  let index = $state(0);
  let button: HTMLButtonElement | undefined = $state();
  let menu: HTMLElement | undefined = $state();

  async function show(): Promise<void> {
    open = true;
    index = Math.max(0, modes.findIndex((m) => isChecked(m)));
    await tick();
    focusItem(index);
  }

  function hide(restore: boolean): void {
    open = false;
    if (restore) button?.focus();
  }

  function focusItem(i: number): void {
    const list = menu ? [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')] : [];
    if (list.length === 0) return;
    index = ((i % list.length) + list.length) % list.length;
    list[index]?.focus();
  }

  function onMenuKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown') focusItem(index + 1);
    else if (event.key === 'ArrowUp') focusItem(index - 1);
    else if (event.key === 'Home') focusItem(0);
    else if (event.key === 'End') focusItem(modes.length - 1);
    else if (event.key === 'Escape') hide(true);
    else if (event.key === 'Tab') {
      hide(false);
      return;
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }

  function onButtonKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      void show();
    }
  }

  function choose(mode: CommandView): void {
    const result = shell.registry.exec(mode.id);
    if (!result.ran && !mode.enabled) {
      if (mode.reasonKey) shell.announceText(tr.text(mode.reasonKey));
      return;
    }
    hide(true);
  }

  $effect(() => {
    if (!open || !menu) return;
    const root = menu.getRootNode() as ShadowRoot | Document;
    return on(root, 'pointerdown', (event: Event) => {
      const path = event.composedPath();
      if ((menu && path.includes(menu)) || (button && path.includes(button))) return;
      hide(false);
    });
  });

  function reasonId(mode: CommandView): string {
    return `${id}-reason-${mode.id.replace(/\W/g, '-')}`;
  }
</script>

{#if modes.length > 0}
  <div class="de-modes">
    <button
      bind:this={button}
      type="button"
      class="de-action de-mode-button"
      data-mode={current?.id.slice(5)}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? `${id}-menu` : undefined}
      aria-label={tr.t('mode.button', {
        mode: current ? tr.text(current.entry.label) : tr.t('mode.label'),
      })}
      onclick={() => (open ? hide(true) : void show())}
      onkeydown={onButtonKeydown}
    >
      <span class="de-mode-mark" data-mode={current?.id.slice(5)} aria-hidden="true"></span>
      <span>{current ? tr.text(current.entry.label) : tr.t('mode.label')}</span>
    </button>
    {#if reasonShown}
      <span class="de-mode-reason" data-reason="trackedForEveryone">{reasonShown}</span>
    {/if}
    {#if open}
      <div
        bind:this={menu}
        id={`${id}-menu`}
        class="de-menu de-modes-menu"
        role="menu"
        tabindex="-1"
        aria-label={tr.t('mode.menu')}
        onkeydown={onMenuKeydown}
      >
        {#each modes as mode, i (mode.id)}
          <button
            type="button"
            class="de-menu-item"
            role="menuitemradio"
            data-command-id={mode.id}
            tabindex={i === index ? 0 : -1}
            aria-checked={isChecked(mode)}
            aria-disabled={mode.enabled ? undefined : 'true'}
            aria-describedby={mode.enabled ? undefined : reasonId(mode)}
            onclick={() => choose(mode)}>{tr.text(mode.entry.label)}</button
          >
        {/each}
      </div>
    {/if}
    <div hidden>
      {#each modes as mode (mode.id)}
        {#if !mode.enabled && mode.reasonKey}
          <span id={reasonId(mode)}>{tr.text(mode.reasonKey)}</span>
        {/if}
      {/each}
    </div>
  </div>
{/if}
