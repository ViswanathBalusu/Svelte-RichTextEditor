<!--
  The styles pane (UX-022; 13 §2, §12; 07 §5.3, §7): the document's paragraph, character and table
  styles with their names and kinds; the paragraph style in effect at the caret is marked in words.
  Choosing a style applies it to the selection through the registry (`format.applyStyle`), so the
  permissions apply as for typing: a user who may edit only a region can apply an existing style
  there. Style names are the document's content.
-->
<script lang="ts">
  import { useShell } from '../context.ts';
  import type { StyleSummary } from '../core-api.ts';
  import type { StringKey } from '../i18n/en-GB.ts';
  import { live } from '../live.ts';

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const selection = live(shell.core.selection);
  const styles = shell.core.styles ? live(shell.core.styles) : null;
  const snapshot = live(shell.registry.view);

  const KINDS: ReadonlyArray<{ kind: StyleSummary['kind']; key: StringKey }> = [
    { kind: 'paragraph', key: 'styles.kind.paragraph' },
    { kind: 'character', key: 'styles.kind.character' },
    { kind: 'table', key: 'styles.kind.table' },
  ];

  const apply = $derived(
    snapshot.current.commands.find((c) => c.id === 'format.applyStyle' && c.offered) ?? null,
  );
  const list = $derived(styles?.current ?? []);
  const id = `${shell.idPrefix}-styles`;

  function isCurrent(style: StyleSummary): boolean {
    const s = selection.current;
    if (style.kind !== 'paragraph') return false;
    return s.styleId != null ? s.styleId === style.id : s.style === style.name;
  }

  function choose(style: StyleSummary): void {
    const result = shell.registry.exec('format.applyStyle', { style: style.id, kind: style.kind });
    if (!result.ran && apply && !apply.enabled && apply.reasonKey)
      shell.announceText(tr.text(apply.reasonKey));
  }
</script>

<section class="de-styles" aria-label={tr.t('styles.label')}>
  {#if list.length === 0}
    <p>{tr.t('styles.empty')}</p>
  {/if}
  {#each KINDS as { kind, key } (kind)}
    {@const group = list.filter((s) => s.kind === kind)}
    {#if group.length > 0}
      <h3 class="de-subhead" id={`${id}-${kind}`}>{tr.t(key)}</h3>
      <ul class="de-list" aria-labelledby={`${id}-${kind}`}>
        {#each group as style (style.id)}
          {@const here = isCurrent(style)}
          <li data-style={style.id} data-current={here ? '' : undefined}>
            <button
              type="button"
              class="de-list-button"
              aria-current={here ? 'true' : undefined}
              aria-disabled={apply?.enabled ? undefined : 'true'}
              aria-describedby={here ? `${id}-current` : undefined}
              onclick={() => choose(style)}
            >
              <span data-content>{style.name}</span>
              {#if here}
                <span class="de-badge">{tr.t('styles.current')}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/each}
  <span id={`${id}-current`} hidden>{tr.t('styles.current')}</span>
</section>
