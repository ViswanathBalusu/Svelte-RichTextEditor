<!--
  The field properties pane (FRW-073; 12 §3.2, §11): the properties of one form field of the
  document, in the panel of components/FieldPropertiesPanel.svelte. The field is the one the
  person selected in the document (its control has focus), or the one chosen from the list here,
  which also serves a keyboard user who is in the pane. A change the panel lets through is made by
  the core as one commit of attribute changes; what the core refuses is announced. The panel is
  read-only where the person may not change the field (no `edit` there, or a workflow that is sent
  or in progress). Field labels, keys and role names are the document's content.
-->
<script lang="ts">
  import FieldPropertiesPanel from '../components/FieldPropertiesPanel.svelte';
  import { useShell } from '../context.ts';
  import type { StringKey } from '../i18n/en-GB.ts';
  import { live } from '../live.ts';
  import { type FieldDraft, fieldPanelReadOnly } from '../shell/field-properties.ts';

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const service = shell.core.fieldProperties!;
  const fields = live(service.fields);
  const selected = live(service.selected);
  const roles = shell.core.roles ? live(shell.core.roles.list) : null;
  const revision = shell.core.revision ? live(shell.core.revision) : null;
  // The workflow's state, as the lock banner follows it (FRW-073 criterion 4); the service's own
  // `workflow()` is the fallback of a core that has no workflow service.
  const workflowState = shell.core.workflowSend ? live(shell.core.workflowSend.state) : null;
  const id = `${shell.idPrefix}-fields`;

  /** The field the person chose from the list; the document's selection replaces it when it moves. */
  let chosen: string | null = $state(null);
  let followed: string | null = null;
  $effect(() => {
    const now = selected.current;
    if (now !== null && now !== followed) chosen = now;
    followed = now;
  });

  const list = $derived(fields.current);
  const current = $derived(
    chosen !== null && list.some((f) => f.id === chosen) ? chosen : (list[0]?.id ?? null),
  );
  const original = $derived.by(() => {
    void revision?.current;
    return current === null ? null : service.read(current);
  });
  const readOnly = $derived.by(() => {
    void revision?.current;
    return current === null
      ? true
      : fieldPanelReadOnly(
          service.canChange(current),
          workflowState?.current ?? service.workflow?.() ?? null,
        );
  });
  const context = $derived.by(() => {
    void revision?.current;
    const others: string[] = [];
    for (const f of list) if (f.id !== current) others.push(f.key);
    return { otherKeys: others, roles: (roles?.current ?? []).map((r) => r.id) };
  });
  const roleNames = $derived(
    Object.fromEntries((roles?.current ?? []).map((r) => [r.id, r.name])),
  );

  const t = (key: string, params?: Readonly<Record<string, string | number>>): string =>
    tr.t(key as StringKey, params);

  const REASON: Record<string, StringKey> = {
    'read-only': 'field.panel.readOnly',
    'not-found': 'field.panel.gone',
    'no-change': 'field.panel.unchanged',
    invalid: 'field.panel.refused',
  };

  function commit(patch: Partial<FieldDraft>): void {
    if (current === null) return;
    const result = service.apply(current, patch);
    shell.announce(result.ok ? 'field.panel.applied' : (REASON[result.reason] ?? 'field.panel.refused'));
  }
</script>

<section class="de-fields-pane" aria-label={tr.t('pane.fields')}>
  {#if list.length === 0}
    <p data-fields="empty">{tr.t('field.panel.none')}</p>
  {:else}
    <label class="de-field" for={`${id}-choose`}>{tr.t('field.panel.choose')}</label>
    <select
      id={`${id}-choose`}
      class="de-input"
      data-fields="choose"
      value={current}
      onchange={(e) => (chosen = e.currentTarget.value)}
    >
      {#each list as field (field.id)}
        <option value={field.id}>{field.label} ({field.key})</option>
      {/each}
    </select>
    {#if original}
      <!-- The panel's inputs start from the field as given: a new field, or a change of this one
           (an apply, an undo, a change by someone else), draws the panel again. -->
      {#key `${current}:${JSON.stringify(original)}:${readOnly}`}
        <FieldPropertiesPanel {original} {context} {readOnly} {roleNames} {t} oncommit={commit} />
      {/key}
    {/if}
  {/if}
</section>
