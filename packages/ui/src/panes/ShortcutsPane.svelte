<!--
  The shortcut reference (UX-013 criterion 6): generated from the registry, which holds every
  command's keys, and from the shortcut table, which adds the alternatives bound where a browser
  gives a key a meaning of its own, and the shell's own keys. Nothing here is written by hand: a
  command registered later (an extension's) appears with its keys. Keys are named for this
  platform (Ctrl or Command).
-->
<script lang="ts">
  import { ariaShortcut, isApplePlatform } from '../commands/keys.ts';
  import { useShell } from '../context.ts';
  import { live } from '../live.ts';
  import { shortcutReferenceRows } from '../shortcuts/reference.ts';

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const snapshot = live(shell.registry.view);
  const apple = isApplePlatform();
  const id = `${shell.idPrefix}-shortcuts`;

  interface Row {
    readonly id: string;
    readonly label: string;
    readonly keys: readonly string[];
    readonly when: string;
  }

  /** Keys as people read them, in the interface's language: `Ctrl+Shift+Z`, `⌘+Shift+Z`. */
  function shown(key: string): string {
    return ariaShortcut(key, apple)
      .split('+')
      .map((part) => {
        const name = `key.${part}`;
        return tr.has(name) ? tr.text(name) : part;
      })
      .join('+');
  }

  const rows: Row[] = $derived(shortcutReferenceRows(snapshot.current.commands, tr));
</script>

<section class="de-shortcuts" aria-labelledby={`${id}-caption`}>
  <table class="de-table">
    <caption id={`${id}-caption`}>{tr.t('shortcuts.label')}</caption>
    <thead>
      <tr>
        <th scope="col">{tr.t('shortcuts.command')}</th>
        <th scope="col">{tr.t('shortcuts.keys')}</th>
        <th scope="col">{tr.t('shortcuts.when')}</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as row (row.id)}
        <tr data-shortcut={row.id}>
          <th scope="row">{row.label}</th>
          <td>
            {#each row.keys as key, i (key)}
              {#if i > 0}<span class="de-or">{tr.t('shortcuts.or')}</span>{/if}
              <kbd class="de-kbd">{shown(key)}</kbd>
            {/each}
          </td>
          <td>{row.when}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</section>
