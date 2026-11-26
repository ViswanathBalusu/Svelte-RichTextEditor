<!--
  The roles manager (FRW-074; 12 §3.1, §11; 07 §4): the roles fields are assigned to, each with
  its colour, the shape derived from its place in the list, and its name as text, so a role is never
  told apart by colour alone. An author with `structure` adds, renames and recolours roles and
  deletes one no field is assigned to; each change is a commit to the role definition, made by the
  core. A role that fields still name is not deleted, and the pane lists those fields (I13). A
  user without `structure` sees the list and gets no control that changes a definition. Role names
  and field labels are the document's content.
-->
<script lang="ts">
  import '../i18n/late/rolesPane.ts';
  import { useShell } from '../context.ts';
  import type { RoleChangeResult, RoleSummary } from '../core-api.ts';
  import type { StringKey } from '../i18n/en-GB.ts';
  import { live } from '../live.ts';
  import { roleIcon } from '../shell/fields.ts';
  import ParticipantsPanel from '../components/ParticipantsPanel.svelte';

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const service = shell.core.roles!;
  const roles = live(service.list);
  const canChange = live(service.canChange);
  const id = `${shell.idPrefix}-roles`;
  const participants = shell.core.participants;
  const people = participants ? live(participants.participants) : null;
  const mayEdit = participants ? live(participants.canEdit) : null;
  const workflowState = participants ? live(participants.state) : null;
  const tt = (key: string, params?: Readonly<Record<string, string | number>>): string =>
    tr.t(key as StringKey, params);
  const preview = shell.core.rolePreview ? live(shell.core.rolePreview) : null;

  /** Previews the document as the role, or leaves the preview when it is already that role's (FRW-075). */
  function togglePreview(role: RoleSummary): void {
    const core = shell.core;
    if (preview?.current === role.id) {
      core.endRolePreview?.();
      return;
    }
    if (!core.startRolePreview?.(role.id)) shell.announce('announce.rolePreview.failed');
  }

  /** A colour for a new role that differs between the first roles; the author may change it. */
  const NEW_COLOURS = ['#1f77b4', '#d95f02', '#2ca02c', '#9467bd', '#8c564b', '#17becf'];

  /** `null`: no form. `''`: a new role. Otherwise the identifier of the role being changed. */
  let editing: string | null = $state(null);
  let name = $state('');
  let color = $state('#1f77b4');
  let bad: readonly string[] = $state([]);
  let formError: StringKey | null = $state(null);
  /** The role whose deletion was refused because fields are assigned to it. */
  let refusedDelete: string | null = $state(null);

  const list = $derived(roles.current);

  const REASON: Record<string, StringKey> = {
    'read-only': 'roles.error.readOnly',
    duplicate: 'roles.error.duplicate',
    'not-defined': 'roles.error.gone',
    'no-change': 'roles.error.noChange',
    'no-feature': 'roles.error.noFeature',
    invalid: 'roles.error.invalid',
    'in-use': 'roles.error.inUse',
  };

  function startAdd(): void {
    editing = '';
    name = '';
    color = NEW_COLOURS[list.length % NEW_COLOURS.length]!;
    bad = [];
    formError = null;
  }

  function startEdit(role: RoleSummary): void {
    editing = role.id;
    name = role.name;
    color = role.color.toLowerCase();
    bad = [];
    formError = null;
  }

  function cancel(): void {
    editing = null;
    bad = [];
    formError = null;
  }

  function save(event: SubmitEvent): void {
    event.preventDefault();
    const adding = editing === '';
    const values = { name: name.trim(), color };
    const result: RoleChangeResult = adding
      ? service.add(values)
      : service.update(editing!, values);
    if (result.ok) {
      shell.announce(adding ? 'announce.roles.added' : 'announce.roles.changed');
      editing = null;
      bad = [];
      formError = null;
      return;
    }
    bad = result.fields ?? [];
    formError = REASON[result.reason] ?? 'roles.error.readOnly';
    shell.announce(formError);
  }

  function remove(role: RoleSummary): void {
    const result = service.remove(role.id);
    if (result.ok) {
      refusedDelete = null;
      shell.announce('announce.roles.deleted');
      return;
    }
    if (result.reason === 'in-use') refusedDelete = role.id;
    shell.announce(REASON[result.reason] ?? 'roles.error.readOnly');
  }
</script>

<section class="de-roles" aria-label={tr.t('roles.label')}>
  {#if !canChange.current}
    <p class="de-hint" data-roles="read-only">{tr.t('roles.readOnly')}</p>
  {/if}
  {#if list.length === 0}
    <p data-roles="empty">{tr.t('roles.empty')}</p>
  {:else}
    <ul class="de-list" data-roles="list">
      {#each list as role (role.id)}
        {@const icon = roleIcon(role.order)}
        <li class="de-roles-item" data-role={role.id}>
          <p class="de-roles-name">
            <span class="de-role-icon" data-icon={icon} style:color={role.color} aria-hidden="true"
            ></span>
            <span data-content dir="auto">{role.name}</span>
            <span class="de-badge" data-roles="shape"
              >{tr.t('roles.icon', { icon: tr.t(`roles.icon.${icon}`) })}</span
            >
          </p>
          <p class="de-hint" data-roles="count">
            {role.fields.length === 0
              ? tr.t('roles.noFields')
              : tr.t('roles.fieldCount', { count: role.fields.length })}
          </p>
          {#if refusedDelete === role.id && role.fields.length > 0}
            <div data-roles="in-use" role="group" aria-labelledby={`${id}-used-${role.id}`}>
              <p class="de-error" id={`${id}-used-${role.id}`}>{tr.t('roles.error.inUse')}</p>
              <ol class="de-list">
                {#each role.fields as field (field.id)}
                  <li data-content data-field={field.id}>{field.label}</li>
                {/each}
              </ol>
            </div>
          {/if}
          {#if shell.core.startRolePreview}
            <div class="de-actions">
              <button
                type="button"
                class="de-button"
                data-roles="preview"
                aria-pressed={preview?.current === role.id}
                aria-label={tr.t('roles.preview.name', { role: role.name })}
                onclick={() => togglePreview(role)}>{tr.t('roles.preview')}</button
              >
            </div>
          {/if}
          {#if canChange.current}
            <div class="de-actions">
              <button
                type="button"
                class="de-button"
                aria-label={tr.t('roles.edit.name', { role: role.name })}
                onclick={() => startEdit(role)}>{tr.t('roles.edit')}</button
              >
              <button
                type="button"
                class="de-button"
                aria-label={tr.t('roles.delete.name', { role: role.name })}
                onclick={() => remove(role)}>{tr.t('roles.delete')}</button
              >
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if canChange.current}
    {#if editing === null}
      <div class="de-actions">
        <button type="button" class="de-button" data-roles="add" onclick={startAdd}
          >{tr.t('roles.add')}</button
        >
      </div>
    {:else}
      <form class="de-form" novalidate onsubmit={save} aria-labelledby={`${id}-form`}>
        <h3 class="de-subhead" id={`${id}-form`}>
          {editing === '' ? tr.t('roles.add') : tr.t('roles.edit')}
        </h3>
        <label class="de-field" for={`${id}-name`}>{tr.t('roles.field.name')}</label>
        <input
          id={`${id}-name`}
          class="de-input"
          name="name"
          autocomplete="off"
          bind:value={name}
          aria-invalid={bad.includes('name') ? 'true' : undefined}
          aria-describedby={formError ? `${id}-error` : undefined}
          {@attach (node) => node.focus()}
        />
        <label class="de-field" for={`${id}-color`}>{tr.t('roles.field.color')}</label>
        <input
          id={`${id}-color`}
          type="color"
          name="color"
          bind:value={color}
          aria-invalid={bad.includes('color') ? 'true' : undefined}
          aria-describedby={`${id}-color-hint`}
        />
        <p class="de-hint" id={`${id}-color-hint`}>{tr.t('roles.hint.color')}</p>
        {#if formError}
          <p class="de-error" id={`${id}-error`} data-roles="error">{tr.t(formError)}</p>
        {/if}
        <div class="de-actions">
          <button type="submit" class="de-button" data-roles="save">{tr.t('roles.save')}</button>
          <button type="button" class="de-button" onclick={cancel}>{tr.t('roles.cancel')}</button>
        </div>
      </form>
    {/if}
  {/if}
</section>

{#if participants && people && mayEdit && workflowState}
  <ParticipantsPanel
    people={people.current}
    roles={roles.current.map((r) => ({ id: r.id, name: r.name }))}
    canEdit={mayEdit.current}
    workflowState={workflowState.current}
    t={tt}
    onsave={(input) => participants.save(input)}
    onremove={(participantId) => participants.remove(participantId)}
    announce={(key) => shell.announce(key as StringKey)}
  />
{/if}
