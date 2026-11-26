<!--
  The participants of the workflow (FRW-026; 12 §6.1): the people bound to the roles of the
  document, each with a name, the host's identifier (`sub`), the roles they act for, what they do
  and their order. People with the same order act together; a higher order acts later. The owner
  adds, changes and removes them while the workflow is a draft and with `manage`; people a host
  wrote through the API are in the list without being entered again, and the list follows the
  server. No e-mail address or telephone number is asked for or shown. Names and identifiers are
  the owner's or the host's text. Every control is a native control, so the keyboard reaches all
  of them in order.
-->
<script lang="ts">
  import '../i18n/late/participantsPane.ts';
  import type {
    ParticipantChangeResult,
    ParticipantInput,
    ParticipantItem,
  } from '../core-api.ts';

  interface Props {
    people: readonly ParticipantItem[];
    /** The roles of the document: identifier and name (the name is document content). */
    roles: readonly { readonly id: string; readonly name: string }[];
    /** True while the caller has `manage` and the workflow is a draft. */
    canEdit: boolean;
    /** The workflow's state; null before it is read. */
    workflowState: string | null;
    t: (key: string, params?: Readonly<Record<string, string | number>>) => string;
    onsave: (input: ParticipantInput) => Promise<ParticipantChangeResult>;
    onremove: (id: string) => Promise<ParticipantChangeResult>;
    announce: (key: string) => void;
  }

  let { people, roles, canEdit, workflowState, t, onsave, onremove, announce }: Props = $props();
  

  const KINDS = ['filler', 'signer', 'approver', 'cc'] as const;
  const KIND_KEY: Record<ParticipantItem['kind'], string> = {
    filler: 'participants.kind.filler',
    signer: 'participants.kind.signer',
    approver: 'participants.kind.approver',
    cc: 'participants.kind.cc',
  };
  const STATE_KEY: Record<string, string> = {
    pending: 'participants.state.pending',
    active: 'participants.state.active',
    completed: 'participants.state.completed',
    declined: 'participants.state.declined',
  };

  /** `null`: no form. `''`: a new participant. Otherwise the identifier of the one being changed. */
  let editing: string | null = $state(null);
  let name = $state('');
  let sub = $state('');
  let chosen: string[] = $state([]);
  let kind: ParticipantItem['kind'] = $state('filler');
  let order = $state('1');
  let bad: readonly string[] = $state([]);
  let formErrors: string[] = $state([]);
  let busy = $state(false);

  const roleName = (roleId: string): string => roles.find((r) => r.id === roleId)?.name ?? roleId;
  const who = (p: ParticipantItem): string => p.name ?? p.sub ?? t('participants.unnamed');

  const REASON: Record<string, string> = {
    forbidden: 'participants.error.forbidden',
    'read-only': 'participants.error.forbidden',
    not_draft: 'participants.error.notDraft',
    stale: 'participants.error.stale',
    invalid: 'participants.error.invalid',
    failed: 'participants.error.failed',
  };
  const FIELD_ERROR: Record<string, string> = {
    roles: 'participants.error.roles',
    name: 'participants.error.name',
    order: 'participants.error.order',
    kind: 'participants.error.kind',
  };

  /** The order of a new participant: after everyone, which is the common case. */
  const nextOrder = (): number => people.reduce((m, p) => Math.max(m, p.order), 0) + 1;

  function startAdd(): void {
    editing = '';
    name = '';
    sub = '';
    chosen = [];
    kind = 'filler';
    order = String(nextOrder());
    bad = [];
    formErrors = [];
  }

  function startEdit(p: ParticipantItem): void {
    editing = p.id;
    name = p.name ?? '';
    sub = p.sub ?? '';
    chosen = [...p.roles];
    kind = p.kind;
    order = String(p.order);
    bad = [];
    formErrors = [];
  }

  function cancel(): void {
    editing = null;
    bad = [];
    formErrors = [];
  }

  function toggleRole(roleId: string, on: boolean): void {
    chosen = on ? [...chosen.filter((r) => r !== roleId), roleId] : chosen.filter((r) => r !== roleId);
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    busy = true;
    const number = /^\d+$/.test(order.trim()) ? Number(order.trim()) : Number.NaN;
    const result = await onsave({
      ...(editing ? { id: editing } : {}),
      name,
      sub,
      roles: chosen,
      kind,
      order: number,
    });
    busy = false;
    if (result.ok) {
      announce('announce.participants.saved');
      editing = null;
      bad = [];
      formErrors = [];
      return;
    }
    bad = result.fields ?? [];
    const named = bad.flatMap((b) => FIELD_ERROR[b] ?? []);
    formErrors = named.length > 0 ? named : [REASON[result.reason] ?? 'participants.error.failed'];
    announce(formErrors[0] ?? 'participants.error.failed');
  }

  async function remove(p: ParticipantItem): Promise<void> {
    const result = await onremove(p.id);
    if (result.ok) {
      announce('announce.participants.removed');
      if (editing === p.id) cancel();
      return;
    }
    announce(REASON[result.reason] ?? 'participants.error.failed');
  }
</script>

<section class="de-participants" aria-labelledby="de-participants-heading" data-participants="section">
  <h3 class="de-subhead" id="de-participants-heading">{t('participants.heading')}</h3>
  <p class="de-hint">{t('participants.intro')}</p>
  {#if !canEdit}
    <p class="de-hint" data-participants="read-only">
      {workflowState !== null && workflowState !== 'draft' ? t('participants.notDraft') : t('participants.readOnly')}
    </p>
  {/if}
  {#if people.length === 0}
    <p data-participants="empty">{t('participants.empty')}</p>
  {:else}
    <ol class="de-list" data-participants="list" aria-label={t('participants.label')}>
      {#each people as p (p.id)}
        <li class="de-participants-item" data-participant={p.id} data-order={p.order}>
          <p class="de-participants-name">
            <span data-content dir="auto" data-participants="name">{who(p)}</span>
            <span class="de-badge" data-participants="order"
              >{t('participants.order', { order: p.order })}</span
            >
          </p>
          {#if p.sub !== null && p.name !== null}
            <p class="de-hint" data-participants="sub">
              <span data-content dir="auto">{t('participants.sub', { sub: p.sub })}</span>
            </p>
          {/if}
          <p class="de-hint" data-participants="kind">
            {t('participants.kind', { kind: t(KIND_KEY[p.kind]) })}
          </p>
          <p class="de-hint" data-participants="roles">
            <span data-content dir="auto"
              >{t('participants.roles', { roles: p.roles.map(roleName).join(', ') })}</span
            >
          </p>
          {#if p.state !== null}
            <p class="de-hint" data-participants="state">
              {t('participants.state', {
                state: STATE_KEY[p.state] !== undefined ? t(STATE_KEY[p.state]!) : p.state,
              })}
            </p>
          {/if}
          {#if canEdit}
            <div class="de-actions">
              <button
                type="button"
                class="de-button"
                data-participants="edit"
                aria-label={t('participants.edit.name', { name: who(p) })}
                onclick={() => startEdit(p)}>{t('participants.edit')}</button
              >
              <button
                type="button"
                class="de-button"
                data-participants="remove"
                aria-label={t('participants.remove.name', { name: who(p) })}
                onclick={() => void remove(p)}>{t('participants.remove')}</button
              >
            </div>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}

  {#if canEdit}
    {#if editing === null}
      <div class="de-actions">
        <button type="button" class="de-button" data-participants="add" onclick={startAdd}
          >{t('participants.add')}</button
        >
      </div>
    {:else}
      <form
        class="de-form"
        novalidate
        data-participants="form"
        onsubmit={save}
        aria-labelledby="de-participants-form"
      >
        <h4 class="de-subhead" id="de-participants-form">
          {editing === '' ? t('participants.add') : t('participants.edit')}
        </h4>
        <label class="de-field" for="de-participants-name">{t('participants.field.name')}</label>
        <input
          id="de-participants-name"
          class="de-input"
          name="name"
          autocomplete="off"
          bind:value={name}
          aria-invalid={bad.includes('name') ? 'true' : undefined}
          aria-describedby={formErrors.length > 0 ? 'de-participants-error' : undefined}
          {@attach (node) => node.focus()}
        />
        <label class="de-field" for="de-participants-sub">{t('participants.field.sub')}</label>
        <input
          id="de-participants-sub"
          class="de-input"
          name="sub"
          autocomplete="off"
          bind:value={sub}
          aria-describedby="de-participants-sub-hint"
        />
        <p class="de-hint" id="de-participants-sub-hint">{t('participants.hint.sub')}</p>
        <fieldset class="de-fieldset" data-participants="roles-input">
          <legend>{t('participants.field.roles')}</legend>
          {#each roles as role (role.id)}
            <label class="de-check">
              <input
                type="checkbox"
                name="roles"
                value={role.id}
                checked={chosen.includes(role.id)}
                aria-invalid={bad.includes('roles') ? 'true' : undefined}
                onchange={(e) => toggleRole(role.id, e.currentTarget.checked)}
              />
              <span data-content dir="auto">{role.name}</span>
            </label>
          {/each}
        </fieldset>
        <label class="de-field" for="de-participants-kind">{t('participants.field.kind')}</label>
        <select
          id="de-participants-kind"
          class="de-input"
          name="kind"
          bind:value={kind}
          aria-invalid={bad.includes('kind') ? 'true' : undefined}
        >
          {#each KINDS as k (k)}
            <option value={k}>{t(KIND_KEY[k])}</option>
          {/each}
        </select>
        <label class="de-field" for="de-participants-order">{t('participants.field.order')}</label>
        <input
          id="de-participants-order"
          class="de-input"
          name="order"
          inputmode="numeric"
          autocomplete="off"
          bind:value={order}
          aria-invalid={bad.includes('order') ? 'true' : undefined}
          aria-describedby="de-participants-order-hint"
        />
        <p class="de-hint" id="de-participants-order-hint">{t('participants.hint.order')}</p>
        {#if formErrors.length > 0}
          <div class="de-error" id="de-participants-error" role="alert" data-participants="error">
            {#each formErrors as key (key)}<p>{t(key)}</p>{/each}
          </div>
        {/if}
        <div class="de-actions">
          <button type="submit" class="de-button" data-participants="save" disabled={busy}
            >{t('participants.save')}</button
          >
          <button type="button" class="de-button" onclick={cancel}>{t('participants.cancel')}</button>
        </div>
      </form>
    {/if}
  {/if}
</section>
