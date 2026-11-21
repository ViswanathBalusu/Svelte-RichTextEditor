<!--
  The properties panel for one form field (FRW-073; 12 §3.2, §4.3, §11). One control per property
  of FIELD_PROPERTIES, in that order; `sensitive` is not offered. Entries are checked by the gate in
  shell/field-properties.ts. A draft with a problem shows every reason, in a live region, and is not
  committed. A draft without one commits only the attributes that changed (fieldPatch), through
  `oncommit`. When `readOnly` is set (no `edit`, or a workflow that is sent or in progress) every
  control is disabled and nothing is committed. Labels and reasons come from the string catalogue
  (`t`); a field's content is shown as text only.
-->
<script lang="ts">
  import '../i18n/late/fieldsPane.ts';
  import { draftFromForm, formFromDraft, type FieldForm } from '../shell/field-form.ts';
  import {
    FIELD_KINDS,
    type FieldContext,
    type FieldDraft,
    type FieldProblem,
    type FieldProperty,
    canCommitField,
    fieldPatch,
    validateFieldDraft,
  } from '../shell/field-properties.ts';

  interface Props {
    /** The field as it is now; the commit is the attributes that differ from it. */
    original: FieldDraft;
    /** The other fields' keys and the document's role identifiers. */
    context: FieldContext;
    /** Read-only: every control is disabled and nothing is committed. */
    readOnly: boolean;
    /** The roles' names by identifier, shown in the assignee list; an identifier without one shows itself. */
    roleNames?: Readonly<Record<string, string>>;
    /** The string catalogue's translator. */
    t: (key: string, params?: Readonly<Record<string, string | number>>) => string;
    /** Receives only the attributes that changed, and only when the draft has no problem. */
    oncommit?: (patch: Partial<FieldDraft>) => void;
  }

  let { original, context, readOnly, roleNames = {}, t, oncommit }: Props = $props();

  // The inputs start from the field as given. A later change of `original` does not reset them.
  // svelte-ignore state_referenced_locally
  let form = $state<FieldForm>(formFromDraft(original));
  let problems = $state<FieldProblem[]>([]);
  let status = $state('');

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (readOnly) return;
    const { draft, jsonErrors } = draftFromForm(form);
    const found: FieldProblem[] = [
      ...validateFieldDraft(draft, context),
      ...jsonErrors.map((property) => ({ property, code: 'badJson' as const })),
    ];
    problems = found;
    if (!canCommitField(found)) {
      status = t('field.panel.notApplied');
      return;
    }
    const patch = fieldPatch(original, draft);
    if (Object.keys(patch).length === 0) {
      status = t('field.panel.unchanged');
      return;
    }
    status = t('field.panel.applied');
    oncommit?.(patch);
  }

  function invalid(property: FieldProperty): boolean {
    return problems.some((p) => p.property === property);
  }

  // The role identifiers the assignee list offers. A field may name a role not in the list.
  const roles = $derived(context.roles);
</script>

<form class="de-field-properties" onsubmit={submit} novalidate aria-labelledby="fp-title">
  <h2 id="fp-title">{t('field.panel.title')}</h2>

  {#if readOnly}
    <p role="status" data-status="read-only">{t('field.panel.readOnly')}</p>
  {/if}

  <div class="de-field-grid">
    <label for="fp-key">{t('field.prop.key')}</label>
    <input
      id="fp-key"
      type="text"
      autocomplete="off"
      bind:value={form.key}
      disabled={readOnly}
      aria-invalid={invalid('key') ? 'true' : undefined}
    />

    <label for="fp-kind">{t('field.prop.kind')}</label>
    <select
      id="fp-kind"
      bind:value={form.kind}
      disabled={readOnly}
      aria-invalid={invalid('kind') ? 'true' : undefined}
    >
      {#each FIELD_KINDS as kind (kind)}
        <option value={kind}>{t(`command.insert.field.${kind}`)}</option>
      {/each}
    </select>

    <label for="fp-label">{t('field.prop.label')}</label>
    <input id="fp-label" type="text" bind:value={form.label} disabled={readOnly} />

    <label for="fp-assignee">{t('field.prop.assignee')}</label>
    <select
      id="fp-assignee"
      bind:value={form.assignee}
      disabled={readOnly}
      aria-invalid={invalid('assignee') ? 'true' : undefined}
    >
      <option value="">{t('field.panel.noRole')}</option>
      {#each roles as role (role)}
        <option value={role}>{roleNames[role] ?? role}</option>
      {/each}
    </select>

    <label for="fp-required">{t('field.prop.required')}</label>
    <input id="fp-required" type="checkbox" bind:checked={form.required} disabled={readOnly} />

    <label for="fp-readonly">{t('field.prop.readOnly')}</label>
    <input id="fp-readonly" type="checkbox" bind:checked={form.readOnly} disabled={readOnly} />

    <label for="fp-default">{t('field.prop.default')}</label>
    <input id="fp-default" type="text" bind:value={form.default} disabled={readOnly} />

    <label for="fp-placeholder">{t('field.prop.placeholder')}</label>
    <input id="fp-placeholder" type="text" bind:value={form.placeholder} disabled={readOnly} />

    <label for="fp-options">{t('field.prop.options')}</label>
    <textarea
      id="fp-options"
      rows="3"
      bind:value={form.options}
      disabled={readOnly}
      aria-describedby="fp-options-hint"
      aria-invalid={invalid('options') ? 'true' : undefined}
    ></textarea>
    <p id="fp-options-hint" class="de-hint">{t('field.panel.optionsHint')}</p>

    <label for="fp-format">{t('field.prop.format')}</label>
    <textarea
      id="fp-format"
      rows="2"
      bind:value={form.format}
      disabled={readOnly}
      aria-invalid={invalid('format') ? 'true' : undefined}
    ></textarea>

    <label for="fp-validation">{t('field.prop.validation')}</label>
    <textarea
      id="fp-validation"
      rows="2"
      bind:value={form.validation}
      disabled={readOnly}
      aria-invalid={invalid('validation') ? 'true' : undefined}
    ></textarea>

    <label for="fp-width">{t('field.prop.width')}</label>
    <input
      id="fp-width"
      type="text"
      inputmode="decimal"
      bind:value={form.width}
      disabled={readOnly}
      aria-invalid={invalid('width') ? 'true' : undefined}
    />
  </div>

  {#if problems.length > 0}
    <!-- The alert holds a list; it is not itself the list, so the items keep their list. -->
    <div id="fp-problems" class="de-problems" role="alert">
      <p class="de-problems-title">{t('field.panel.problems')}</p>
      <ul>
        {#each problems as problem, i (i)}
          <li data-property={problem.property}>
            {t(`field.prop.${problem.property}`)}: {t(`field.problem.${problem.code}`)}
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <p role="status" data-status="apply">{status}</p>
  <button type="submit" disabled={readOnly}>{t('field.panel.apply')}</button>
</form>
