<!--
  A command that is chosen from a list (`CommandEntry.picker`; ADR 0490): the paragraph style, the
  font size, the text colour and the highlight of the ribbon's Home tab. It is a menu button: the
  button names the command (and shows the current style or size), and opens a menu of radio items;
  choosing one runs the command through the registry with the choice as its arguments, so the
  permissions apply as for any other command. It is one control of the toolbar it stands in: the
  toolbar owns the roving tab stop and the Left, Right, Home and End keys; this component owns Down,
  Up and Enter on the button, and the keys of its open menu (Up, Down, Home, End, Enter, Space, Escape
  and Tab). The menu closes on a click or a key outside it, and focus goes back to the button.
-->
<script lang="ts">
  import '../i18n/late/ribbonToolbar.ts';
  import { tick } from 'svelte';
  import { on } from 'svelte/events';
  import type { CommandView } from '../commands/types.ts';
  import { useShell } from '../context.ts';
  import type { StyleSummary } from '../core-api.ts';
  import type { StringKey } from '../i18n/en-GB.ts';
  import type { IconDrawing } from '../icons/icons.ts';
  import { live } from '../live.ts';
  import { pickerChoices, pickerSummary, type PickerChoice } from '../shell/ribbon-pickers.ts';
  import Icon from './Icon.svelte';

  interface Props {
    item: CommandView;
    /** The icon name, for the lists that show one (colour, highlight). */
    icon: string | undefined;
    drawings: Readonly<Record<string, IconDrawing>>;
    /** 0 or -1: the toolbar's roving tab stop. */
    tabindex: number;
    /** Hands the button to the toolbar, which focuses it; returns the function that lets it go. */
    register: (node: HTMLElement) => () => void;
  }

  let { item, icon, drawings, tabindex, register }: Props = $props();

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const selection = live(shell.core.selection);
  const emptyStyles: readonly StyleSummary[] = [];
  const styles = shell.core.styles ? live(shell.core.styles) : null;
  const kind = $derived(item.entry.picker ?? 'style');
  const uid = $derived(`${shell.idPrefix}-picker-${item.id.replace(/\W/g, '-')}`);

  const context = $derived({
    styles: styles?.current ?? emptyStyles,
    selection: selection.current,
    text: (key: StringKey) => tr.t(key),
  });
  let open = $state(false);
  let active = $state(0);
  let button: HTMLButtonElement | undefined = $state();
  let menu: HTMLElement | undefined = $state();
  let wrapper: HTMLElement | undefined = $state();

  const summary = $derived(pickerSummary(kind, context));
  const choices = $derived<PickerChoice[]>(open ? pickerChoices(kind, context) : []);
  const shown = $derived(
    summary ?? (kind === 'style' ? tr.t('ribbon.picker.style') : tr.t('ribbon.picker.size')),
  );
  const showsText = $derived(kind === 'style' || kind === 'fontSize');

  $effect(() => (button ? register(button) : undefined));

  function items(): HTMLElement[] {
    return menu ? [...menu.querySelectorAll<HTMLElement>('[data-choice]')] : [];
  }

  function focusChoice(index: number): void {
    const list = items();
    if (list.length === 0) return;
    active = ((index % list.length) + list.length) % list.length;
    list[active]?.focus();
    list[active]?.scrollIntoView?.({ block: 'nearest' });
  }

  async function openMenu(): Promise<void> {
    if (!item.enabled) {
      if (item.reasonKey) shell.announceText(tr.text(item.reasonKey));
      return;
    }
    open = true;
    await tick();
    const checked = choices.findIndex((c) => c.checked === true);
    focusChoice(checked >= 0 ? checked : 0);
  }

  function closeMenu(returnFocus: boolean): void {
    open = false;
    if (returnFocus) button?.focus();
  }

  function choose(choice: PickerChoice): void {
    const result = shell.registry.exec(item.id, choice.args);
    if (!result.ran && item.reasonKey && !item.enabled) shell.announceText(tr.text(item.reasonKey));
    closeMenu(true);
  }

  function onButtonKeydown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    void openMenu();
  }

  function onMenuKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown') focusChoice(active + 1);
    else if (event.key === 'ArrowUp') focusChoice(active - 1);
    else if (event.key === 'Home') focusChoice(0);
    else if (event.key === 'End') focusChoice(choices.length - 1);
    else if (event.key === 'Escape') closeMenu(true);
    // The toolbar's arrows do not carry focus out of an open menu: they stay in it.
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') active = active;
    else if (event.key === 'Tab') {
      closeMenu(false);
      return;
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }

  /** Focus that leaves the button and its menu closes the menu. */
  function onFocusout(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (open && !(next instanceof Node && wrapper?.contains(next))) open = false;
  }

  $effect(() => {
    if (!open || !button) return;
    const root = button.getRootNode() as Document | ShadowRoot;
    return on(root, 'pointerdown', (event: Event) => {
      const path = event.composedPath();
      if ((menu && path.includes(menu)) || path.includes(button!)) return;
      closeMenu(false);
    });
  });
</script>

<!-- Its few rules are set here, not in shell.css, which the first load carries whole. -->
<span
  class="de-picker"
  data-picker={kind}
  bind:this={wrapper}
  onfocusout={onFocusout}
  style:position={'relative'}
  style:display={'inline-flex'}
>
  <button
    bind:this={button}
    type="button"
    class="de-tool de-tool-small de-picker-button"
    style:flex-direction={'row'}
    style:gap={'0.35em'}
    style:min-inline-size={showsText ? '5em' : undefined}
    style:justify-content={'space-between'}
    style:white-space={'nowrap'}
    style:max-inline-size={'none'}
    data-command={item.entry.aliases?.[0] ?? item.id}
    data-command-id={item.id}
    data-group={item.entry.group}
    {tabindex}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls={open ? `${uid}-menu` : undefined}
    aria-disabled={item.enabled ? undefined : 'true'}
    aria-describedby={item.enabled ? undefined : `${uid}-reason`}
    title={item.enabled || !item.reasonKey
      ? showsText
        ? undefined
        : tr.text(item.entry.label)
      : tr.text(item.reasonKey)}
    onclick={() => (open ? closeMenu(true) : void openMenu())}
    onkeydown={onButtonKeydown}
    >{#if showsText}<span class="de-visually-hidden">{tr.text(item.entry.label)}: </span><span
        class="de-picker-value">{shown}</span
      >{:else}<Icon name={icon} extra={drawings} /><span class="de-visually-hidden"
        >{tr.text(item.entry.label)}</span
      >{/if}<svg
      class="de-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      style:inline-size={'0.8em'}
      style:block-size={'0.8em'}
      style:margin={'0'}><path d="M6 9l6 6 6-6" /></svg
    ></button
  >
  {#if !item.enabled && item.reasonKey}
    <span id={`${uid}-reason`} hidden>{tr.text(item.reasonKey)}</span>
  {/if}
  {#if open}
    <div
      bind:this={menu}
      id={`${uid}-menu`}
      class="de-menu de-picker-menu"
      style:inset-inline={'0 auto'}
      style:max-block-size={'18em'}
      style:overflow-y={'auto'}
      role="menu"
      tabindex="-1"
      aria-label={tr.text(item.entry.label)}
      onkeydown={onMenuKeydown}
    >
      {#each choices as choice, i (choice.id)}
        <button
          type="button"
          class="de-menu-item"
          style:display={'flex'}
          style:align-items={'center'}
          style:gap={'0.5em'}
          style:white-space={'nowrap'}
          data-choice={choice.id}
          role={choice.checked === null ? 'menuitem' : 'menuitemradio'}
          aria-checked={choice.checked === null ? undefined : choice.checked}
          tabindex={i === active ? 0 : -1}
          onclick={() => choose(choice)}
          >{#if choice.swatch}<span
              class="de-swatch"
              style:background-color={choice.swatch}
              style:flex={'none'}
              style:inline-size={'1em'}
              style:block-size={'1em'}
              style:border={'1px solid var(--_de-text)'}
              style:forced-color-adjust={'none'}
              aria-hidden="true"
            ></span>{/if}{choice.label}</button
        >
      {/each}
    </div>
  {/if}
</span>
