<!--
  What is left to fill (FRW-078; 12 §11): every required field of this participant that is still
  empty, and every field of theirs whose value is invalid, with its label, the reason and a link
  that moves focus to the field. A field leaves the list as soon as it is fixed; when nothing is
  left, a status says so and is announced. The count is computed with the bar's, so they agree.

  Below it, every field the core lists, in document order, with its role marker (FRW-077): "Yours"
  for the participant's own, the role's name, colour and icon for another role's, "No role" for an
  unassigned one, and "Read-only" for each the participant cannot change now. The marker and the
  read-only state come from `fieldMarker`, the rule the counts use too. Field labels and role names
  are the document's content.
-->
<script lang="ts">
  import { useShell } from '../context.ts';
  import { live } from '../live.ts';
  import { fieldMarker, roleIcon } from '../shell/fields.ts';
  import { fillProgress, fillReasonKey } from '../shell/fill.ts';

  const shell = useShell()!;
  const id = `${shell.idPrefix}-fill`;
  const tr = $derived(shell.strings.current);
  const fill = shell.core.fill ? live(shell.core.fill) : null;
  const summary = $derived(fill?.current ?? null);
  const progress = $derived(summary ? fillProgress(summary) : null);
  const rows = $derived(
    summary
      ? summary.fields.map((field) => ({
          field,
          marker: fieldMarker(field, summary.roles ?? [], summary.active, tr),
        }))
      : [],
  );

  // The legend (FRW-074 criterion 2): each role once, with the shape and the name its markers use.
  // The roles come from the fields the core lists, so a role the reader may not see is not named.
  const legend = $derived.by(() => {
    const seen = new Map<string, { id: string; name: string; color: string; order: number }>();
    for (const field of summary?.fields ?? [])
      if (field.assignee && field.role && !seen.has(field.assignee))
        seen.set(field.assignee, { id: field.assignee, ...field.role });
    return [...seen.values()].sort((a, b) => a.order - b.order);
  });

  function go(id: string): void {
    shell.core.focusField?.(id);
  }
</script>

<section class="de-fill-summary" aria-label={tr.t('pane.fill')}>
  {#if progress}
    <p data-status="fill-progress"
      >{tr.t('fill.progress', { done: progress.done, count: progress.total })}</p
    >
    {#if progress.left.length > 0}
      <ul class="de-list">
        {#each progress.left as field (field.id)}
          <li data-field={field.id}>
            <button type="button" class="de-list-button" onclick={() => go(field.id)}>
              <span data-content>{field.label}</span>
              <span class="de-badge">{tr.t(fillReasonKey(field))}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
  <p role="status" data-status="fill-left">
    {#if progress && progress.left.length === 0}{tr.t('fill.summary.empty')}{/if}
  </p>
  {#if rows.length > 0}
    <h3 class="de-subhead" id={`${id}-fields`}>{tr.t('fill.fields')}</h3>
    <ul class="de-list" aria-labelledby={`${id}-fields`}>
      {#each rows as { field, marker } (field.id)}
        <li
          data-field-row={field.id}
          data-ownership={marker.ownership}
          data-read-only={marker.readOnly ? 'true' : 'false'}
        >
          <button
            type="button"
            class="de-list-button"
            aria-label={marker.name}
            onclick={() => go(field.id)}
          >
            {#if marker.icon}
              <span
                class="de-role-icon"
                data-icon={marker.icon}
                style:color={marker.color}
                aria-hidden="true"
              ></span>
            {/if}
            <span data-content>{field.label}</span>
            {#if marker.roleName !== null && marker.ownership === 'other'}
              <span class="de-badge" data-marker data-content dir="auto">{marker.text}</span>
            {:else}
              <span class="de-badge" data-marker>{marker.text}</span>
            {/if}
            {#if marker.readOnly}
              <span class="de-badge" data-state="read-only">{tr.t('field.readOnly')}</span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  {#if legend.length > 0}
    <h3 class="de-subhead" id={`${id}-legend`}>{tr.t('roles.legend')}</h3>
    <ul class="de-list de-role-legend" aria-labelledby={`${id}-legend`}>
      {#each legend as role (role.id)}
        <li data-legend-role={role.id}>
          <span
            class="de-role-icon"
            data-icon={roleIcon(role.order)}
            style:color={role.color}
            aria-hidden="true"
          ></span>
          <span data-content dir="auto">{role.name}</span>
        </li>
      {/each}
    </ul>
  {/if}
</section>
