<!--
  The permissions pane (13 §3; 07 §7; PRM-026, PRM-032, PRM-035, PRM-036). It lists the regions as
  this reader may see them (a hidden one only as such, ADR 0019), with their state, who may edit
  each and who can edit it. For a chosen region, someone who manages the document sets the policy,
  with what each policy means in plain words, and gives people and groups a role, found through the
  host's directory (`searchPrincipals`) and named through `resolveUsers`. The document's role
  placeholders are offered beside them (`role:<id>`, FRW-012), found among its own roles. Grants are saved with
  `If-Match`; when someone else saved first, the pane reloads them and says so, and nothing is
  overwritten. Without `manage` the controls are absent or disabled, with the reason. Roles are
  shown with a colour, a shape and their name. Titles and names are content.
-->
<script lang="ts">
  import '../i18n/late/permissionsPane.ts';
  import { onMount } from 'svelte';
  import { useShell } from '../context.ts';
  import type {
    GrantsSnapshot,
    PrincipalInfo,
    RegionGrant,
    RegionRole,
    RegionSummary,
  } from '../core-api.ts';
  import type { StringKey } from '../i18n/en-GB.ts';
  import { live } from '../live.ts';
  import { checkOutState, leaseFailureKey } from '../shell/leases.ts';
  import { capabilitiesAnywhere } from '../shell/modes.ts';
  import {
    grantableCandidates,
    mayEditRegion,
    roleCandidates,
    whoCanEdit,
  } from '../shell/regions.ts';

  const shell = useShell()!;
  const core = shell.core;
  const tr = $derived(shell.strings.current);
  const regionsView = core.regions ? live(core.regions) : null;
  const permissions = core.permissions ? live(core.permissions) : null;
  const directory = live(shell.people.view);
  const rolesView = core.roles ? live(core.roles.list) : null;
  /** The document's role placeholders: offered beside users and groups as principals (FRW-012). */
  const roleList = $derived(rolesView?.current ?? []);
  const id = `${shell.idPrefix}-permissions`;

  const ROLES: readonly RegionRole[] = ['viewer', 'commenter', 'suggester', 'editor'];
  const regions = $derived([...(regionsView?.current ?? [])].sort((a, b) => a.order - b.order));
  /** `manage` is document-level (07 §2): only then are the grant and policy controls offered. */
  const manage = $derived(
    permissions ? capabilitiesAnywhere(permissions.current).has('manage') : false,
  );

  let selectedId = $state<string | null>(null);
  const selected = $derived(regions.find((r) => r.id === selectedId) ?? null);

  // Group names learnt from the directory search; groups have no `resolveUsers`.
  const groupNames = new Map<string, string>();

  function nameOf(principal: string): string {
    void directory.current;
    if (principal === 'everyone') return tr.t('principal.everyone');
    if (principal.startsWith('role:'))
      return roleList.find((r) => `role:${r.id}` === principal)?.name ?? tr.t('principal.role');
    if (principal.startsWith('group:')) return groupNames.get(principal) ?? tr.t('principal.group');
    const user = principal.startsWith('user:') ? principal.slice(5) : principal;
    shell.people.request([user]);
    return shell.people.lookup(user).name ?? tr.t('people.fallback');
  }

  function titleOf(region: RegionSummary): string {
    return region.title ?? tr.t('permissions.hiddenRegion');
  }

  // Grants (PRM-035).
  let grants = $state.raw<GrantsSnapshot | null>(null);
  let message = $state<StringKey | null>(null);
  let saving = $state(false);

  async function load(): Promise<void> {
    if (!core.grants) return;
    try {
      grants = await core.grants.load();
    } catch {
      message = 'permissions.loadFailed';
    }
  }

  onMount(() => {
    void load();
  });

  const regionGrants = $derived(
    selected && grants ? grants.grants.filter((g) => g.region === selected.id) : [],
  );

  async function save(next: readonly RegionGrant[]): Promise<void> {
    if (!core.grants || !grants) return;
    saving = true;
    message = null;
    try {
      grants = await core.grants.save(next, grants.etag);
      message = 'permissions.saved';
      shell.announce('permissions.saved');
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'precondition_failed') {
        await load();
        message = 'permissions.conflict';
        shell.announce('permissions.conflict');
      } else {
        message = 'permissions.failed';
        shell.announce('permissions.failed');
      }
    } finally {
      saving = false;
    }
  }

  function remove(grant: RegionGrant): void {
    if (!grants) return;
    void save(
      grants.grants.filter((g) => !(g.region === grant.region && g.principal === grant.principal)),
    );
  }

  // Adding a grant: find a principal, choose a role and an optional expiry.
  let query = $state('');
  let candidates = $state.raw<PrincipalInfo[]>([]);
  let searched = $state(false);
  let active = $state(-1);
  let chosen = $state.raw<PrincipalInfo | null>(null);
  let role = $state<RegionRole>('editor');
  let until = $state('');
  let timer: ReturnType<typeof setTimeout> | undefined;

  function onInput(): void {
    chosen = null;
    clearTimeout(timer);
    const text = query.trim();
    if (!text) {
      candidates = [];
      searched = false;
      return;
    }
    // Role placeholders are the document's own: they are found here, not asked of the host.
    const own = roleCandidates(roleList, text);
    if (!shell.searchPrincipals) {
      candidates = own;
      active = own.length ? 0 : -1;
      searched = true;
      return;
    }
    timer = setTimeout(async () => {
      try {
        const found = await shell.searchPrincipals!({
          text,
          docId: shell.docId ?? '',
          purpose: 'grant',
          kinds: ['user', 'group'],
          limit: 20,
        });
        if (query.trim() !== text) return;
        candidates = [
          ...(Array.isArray(found) ? grantableCandidates(found, selected?.policy) : []),
          ...own,
        ];
        for (const p of candidates)
          if (p.principal.startsWith('group:') && typeof p.name === 'string')
            groupNames.set(p.principal, p.name);
        active = candidates.length ? 0 : -1;
        searched = true;
      } catch {
        candidates = own;
        active = own.length ? 0 : -1;
        searched = true;
      }
    }, 200);
  }

  function pick(p: PrincipalInfo): void {
    chosen = p;
    query = p.name;
    candidates = [];
    searched = false;
  }

  function onSearchKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' && candidates.length) active = (active + 1) % candidates.length;
    else if (event.key === 'ArrowUp' && candidates.length)
      active = (active - 1 + candidates.length) % candidates.length;
    else if (event.key === 'Enter' && candidates[active]) pick(candidates[active]!);
    else if (event.key === 'Escape' && candidates.length) {
      candidates = [];
      searched = false;
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }

  function add(event: SubmitEvent): void {
    event.preventDefault();
    if (!selected || !chosen || !grants) return;
    const expiresAt = until ? new Date(`${until}T23:59:59`).toISOString() : null;
    const grant: RegionGrant = {
      region: selected.id,
      principal: chosen.principal,
      role,
      ...(expiresAt ? { expiresAt } : {}),
    };
    const rest = grants.grants.filter(
      (g) => !(g.region === grant.region && g.principal === grant.principal),
    );
    chosen = null;
    query = '';
    until = '';
    void save([...rest, grant]);
  }

  // Rename (PRM-034 criterion 1 and 5): a commit through the core, which needs `structure` and `edit`
  // in the region (07 §2). Without them the control is disabled and the text says which is missing.
  const structure = $derived(
    permissions ? capabilitiesAnywhere(permissions.current).has('structure') : false,
  );
  const offersRename = $derived(core.commandNames?.includes('renameRegion') ?? false);
  const mayRename = $derived(
    selected !== null && structure && mayEditRegion(permissions?.current, selected.id),
  );
  const renameWhy = $derived<StringKey | null>(
    mayRename ? null : structure ? 'permissions.rename.noEdit' : 'permissions.rename.noStructure',
  );
  const selectedTitle = $derived(selected?.title ?? null);
  let renameTo = $state('');
  $effect(() => {
    renameTo = selectedTitle ?? '';
  });

  function rename(event: SubmitEvent): void {
    event.preventDefault();
    if (!selected || !mayRename) return;
    const title = renameTo.trim();
    if (title === '' || title === selected.title) return;
    const done = core.runNamed?.('renameRegion', { region: selected.id, title }) ?? false;
    shell.announce(done ? 'permissions.rename.done' : 'permissions.rename.failed');
  }

  // Policy (PRM-036): a commit through the core, which needs `manage` (07 §5.2 P2).
  function setPolicy(policy: 'inherit' | 'restricted'): void {
    if (!selected || !manage) return;
    const done = core.runNamed?.('setRegionPolicy', { region: selected.id, policy }) ?? false;
    shell.announce(done ? 'permissions.policy.set' : 'permissions.policy.failed');
  }

  // State (PRM-048 criterion 4): only with `manage`, and only when the backend offers the route. The
  // list follows the change by itself (a state change raises `perm.changed`).
  const STATES = ['draft', 'in_review', 'approved'] as const;
  let stateChoice = $state<{ region: string; state: RegionSummary['state'] } | null>(null);
  let stateBusy = $state(false);
  const chosenState = $derived(
    stateChoice && stateChoice.region === selected?.id
      ? stateChoice.state
      : (selected?.state ?? 'draft'),
  );

  async function changeState(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!selected || !manage || !core.setRegionState || chosenState === selected.state) return;
    stateBusy = true;
    try {
      await core.setRegionState(selected.id, chosenState);
      stateChoice = null;
      shell.announce('permissions.state.changed');
    } catch {
      shell.announce('permissions.state.failed');
    } finally {
      stateBusy = false;
    }
  }

  const POLICY_HELP:Readonly<Record<'inherit' | 'restricted', StringKey>> = {
    inherit: 'permissions.policy.inherit.help',
    restricted: 'permissions.policy.restricted.help',
  };

  // Check-out (PRM-043): offered only when the core has a leases service, which is when the backend
  // announces `leases`. The region list follows the change by itself (a lease raises `perm.changed`).
  const leasesView = core.leases ? live(core.leases.held) : null;
  const checkOut = $derived(
    selected && core.leases
      ? checkOutState(selected, permissions?.current, leasesView?.current ?? [])
      : null,
  );
  let leaseBusy = $state(false);
  let leaseMessage = $state<StringKey | null>(null);

  async function toggleLease(): Promise<void> {
    if (!core.leases || !selected || !checkOut) return;
    const region = selected.id;
    const taking = checkOut.kind === 'offer';
    leaseBusy = true;
    leaseMessage = null;
    try {
      if (taking) await core.leases.acquire(region);
      else await core.leases.release(region);
      leaseMessage = taking ? 'lease.taken' : 'lease.released';
      shell.announce(leaseMessage);
    } catch (error) {
      leaseMessage = leaseFailureKey(error);
      shell.announce(leaseMessage);
    } finally {
      leaseBusy = false;
    }
  }

  // A state is shown by its icon and its text, never by colour alone (PRM-048 criterion 1).
  const STATE_ICON: Readonly<Record<'draft' | 'in_review' | 'approved', string>> = {
    draft: '○',
    in_review: '◐',
    approved: '●',
  };

  function expiryText(value: string | null | undefined): string {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : tr.date(date, { dateStyle: 'medium' });
  }
</script>

<section class="de-permissions" aria-label={tr.t('permissions.label')}>
  <h3 class="de-subhead" id={`${id}-regions`}>{tr.t('permissions.regions')}</h3>
  {#if regions.length === 0}
    <p>{tr.t('permissions.empty')}</p>
  {:else}
    <ul class="de-list" aria-labelledby={`${id}-regions`}>
      {#each regions as region (region.id)}
        <li data-region={region.id} data-state={region.state}>
          <button
            type="button"
            class="de-list-button"
            aria-pressed={region.id === selectedId}
            disabled={region.title === null}
            onclick={() => (selectedId = region.id)}
          >
            <span data-content={region.title === null ? undefined : ''}>{titleOf(region)}</span>
            <span class="de-badge" data-state={region.state}
              ><span class="de-badge-icon" aria-hidden="true">{STATE_ICON[region.state]}</span
              >{tr.t(`permissions.state.${region.state}`)}</span
            >
          </button>
          {#if region.title !== null}
            <p class="de-hint" data-region-editors>{whoCanEdit(region, tr, nameOf)}</p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if selected}
    <section class="de-permissions-region" aria-labelledby={`${id}-title`}>
      <h3 class="de-subhead" id={`${id}-title`} data-content>{titleOf(selected)}</h3>
      {#if offersRename && selected.title !== null}
        <form class="de-form" onsubmit={rename} data-rename>
          <label class="de-field" for={`${id}-rename`}>{tr.t('permissions.rename.label')}</label>
          <input
            id={`${id}-rename`}
            class="de-input"
            type="text"
            bind:value={renameTo}
            disabled={!mayRename}
            aria-describedby={renameWhy ? `${id}-rename-why` : undefined}
          />
          <button
            type="submit"
            class="de-button"
            disabled={!mayRename || renameTo.trim() === '' || renameTo.trim() === selected.title}
            >{tr.t('permissions.rename.save')}</button
          >
          {#if renameWhy}
            <p class="de-hint" id={`${id}-rename-why`}>{tr.t(renameWhy)}</p>
          {/if}
        </form>
      {/if}
      {#if selected.policy !== 'confidential'}
        <fieldset class="de-fieldset" disabled={!manage} aria-describedby={manage ? undefined : `${id}-readonly`}>
          <legend>{tr.t('permissions.policy.label')}</legend>
          {#each ['inherit', 'restricted'] as const as policy (policy)}
            <label class="de-check">
              <input
                type="radio"
                name={`${id}-policy`}
                value={policy}
                checked={selected.policy === policy}
                aria-describedby={`${id}-help-${policy}`}
                onchange={() => setPolicy(policy)}
              />
              <span>{tr.t(`permissions.policy.${policy}`)}</span>
            </label>
            <p class="de-hint" id={`${id}-help-${policy}`}>{tr.t(POLICY_HELP[policy])}</p>
          {/each}
        </fieldset>
      {:else}
        <p>{tr.t('permissions.policy.confidential')}</p>
      {/if}
      {#if manage && core.setRegionState && selected.title !== null}
        <form class="de-form" onsubmit={changeState} data-region-state>
          <label class="de-field" for={`${id}-state`}>{tr.t('permissions.state.label')}</label>
          <select
            id={`${id}-state`}
            class="de-input"
            value={chosenState}
            disabled={stateBusy}
            onchange={(e) =>
              (stateChoice = {
                region: selected.id,
                state: e.currentTarget.value as RegionSummary['state'],
              })}
          >
            {#each STATES as state (state)}
              <option value={state}>{tr.t(`permissions.state.${state}`)}</option>
            {/each}
          </select>
          <button
            type="submit"
            class="de-button"
            disabled={stateBusy || chosenState === selected.state}
            >{tr.t('permissions.state.save')}</button
          >
        </form>
      {/if}
      {#if !manage}
        <p class="de-hint" id={`${id}-readonly`}>{tr.t('permissions.readOnly')}</p>
      {/if}

      {#if checkOut && checkOut.kind !== 'none'}
        <section class="de-lease" aria-labelledby={`${id}-lease`} data-lease={checkOut.kind}>
          <h4 class="de-subhead" id={`${id}-lease`}>{tr.t('lease.heading')}</h4>
          {#if checkOut.kind === 'offer'}
            <p class="de-hint" id={`${id}-lease-help`}>{tr.t('lease.help')}</p>
            <button
              type="button"
              class="de-button"
              disabled={leaseBusy}
              aria-describedby={`${id}-lease-help`}
              onclick={() => void toggleLease()}>{tr.t('lease.checkOut')}</button
            >
          {:else if checkOut.kind === 'mine'}
            <p class="de-hint" id={`${id}-lease-help`}>{tr.t('lease.mine')}</p>
            <button
              type="button"
              class="de-button"
              disabled={leaseBusy}
              aria-describedby={`${id}-lease-help`}
              onclick={() => void toggleLease()}>{tr.t('lease.release')}</button
            >
          {:else if checkOut.kind === 'other'}
            <p class="de-hint">{tr.t('lease.other', { name: nameOf(`user:${checkOut.holder}`) })}</p>
          {:else}
            <p class="de-hint">{tr.t(checkOut.reason)}</p>
          {/if}
          {#if leaseMessage}
            <p
              class={leaseMessage === 'lease.taken' || leaseMessage === 'lease.released'
                ? 'de-hint'
                : 'de-error'}
              data-status="lease">{tr.t(leaseMessage)}</p
            >
          {/if}
        </section>
      {/if}

      {#if core.grants}
        <h4 class="de-subhead" id={`${id}-grants`}>{tr.t('permissions.grants')}</h4>
        {#if regionGrants.length === 0}
          <p>{tr.t('permissions.grants.none')}</p>
        {:else}
          <ul class="de-list" aria-labelledby={`${id}-grants`}>
            {#each regionGrants as grant (grant.principal)}
              {@const name = nameOf(grant.principal)}
              <li class="de-grant" data-principal={grant.principal}>
                <span data-content>{name}</span>
                <span class="de-role" data-role={grant.role}>
                  <span class="de-role-mark" data-role={grant.role} aria-hidden="true"></span>
                  <span>{tr.t(`role.${grant.role}`)}</span>
                </span>
                {#if grant.expiresAt}
                  <span class="de-hint">{expiryText(grant.expiresAt)}</span>
                {/if}
                {#if manage}
                  <button
                    type="button"
                    class="de-button"
                    disabled={saving}
                    onclick={() => remove(grant)}>{tr.t('permissions.remove', { name })}</button
                  >
                {/if}
              </li>
            {/each}
          </ul>
        {/if}

        {#if manage}
          <form class="de-form" onsubmit={add} aria-labelledby={`${id}-add`}>
            <h4 class="de-subhead" id={`${id}-add`}>{tr.t('permissions.add')}</h4>
            {#if shell.searchPrincipals || roleList.length > 0}
              <label class="de-field" for={`${id}-search`}>{tr.t('permissions.search')}</label>
              <input
                id={`${id}-search`}
                class="de-input"
                type="text"
                role="combobox"
                autocomplete="off"
                aria-autocomplete="list"
                aria-expanded={candidates.length > 0}
                aria-controls={`${id}-candidates`}
                aria-activedescendant={active >= 0 && candidates[active]
                  ? `${id}-candidate-${active}`
                  : undefined}
                bind:value={query}
                oninput={onInput}
                onkeydown={onSearchKeydown}
              />
              <ul
                id={`${id}-candidates`}
                class="de-listbox"
                role="listbox"
                aria-label={tr.t('permissions.candidates')}
                hidden={candidates.length === 0}
              >
                {#each candidates as p, i (p.principal)}
                  <!-- The combobox pattern: the keys are handled by the field, which owns the list. -->
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <li
                    id={`${id}-candidate-${i}`}
                    role="option"
                    class="de-option"
                    aria-selected={i === active}
                    data-principal={p.principal}
                    onmousedown={(e) => e.preventDefault()}
                    onclick={() => pick(p)}
                  >
                    <span data-content>{p.name}</span>
                    <span class="de-hint"
                      >{p.principal.startsWith('group:')
                        ? tr.t('principal.group')
                        : p.principal.startsWith('role:')
                          ? tr.t('principal.role')
                          : tr.t('principal.user')}</span
                    >
                  </li>
                {/each}
              </ul>
              {#if searched && candidates.length === 0}
                <p class="de-hint" role="status">{tr.t('permissions.search.none')}</p>
              {/if}
            {:else}
              <p class="de-hint">{tr.t('permissions.search.unavailable')}</p>
            {/if}
            <label class="de-field" for={`${id}-role`}>{tr.t('permissions.role')}</label>
            <select id={`${id}-role`} class="de-input" bind:value={role}>
              {#each ROLES as r (r)}
                <option value={r}>{tr.t(`role.${r}`)}</option>
              {/each}
            </select>
            <label class="de-field" for={`${id}-until`}>{tr.t('permissions.expiry')}</label>
            <input id={`${id}-until`} class="de-input" type="date" bind:value={until} />
            <div class="de-dialog-actions">
              <button
                type="submit"
                class="de-button de-button-primary"
                disabled={!chosen || saving}>{tr.t('permissions.save')}</button
              >
            </div>
          </form>
        {/if}
      {/if}
      {#if message}
        <p
          class={message === 'permissions.saved' ? 'de-hint' : 'de-error'}
          data-status="permissions">{tr.t(message)}</p
        >
      {/if}
    </section>
  {/if}
</section>
