<!--
  The host's share dialog (UX-095; 13 section 5, 11.2). A native modal `<dialog>`: the browser keeps
  focus inside it while it is open and returns focus to the element that opened it (the share
  button, or the element's share command through de-share-request, UX-093 criterion 6). It lists
  the seeded people with their document-level role and saves each one through the page's `role`
  action, which stores the change in the host and says when it takes effect (share-model.ts).
  Region grants and workflow participants are not managed here: they belong to the editor's
  permissions pane.
-->
<script lang="ts">
  import { enhance } from '$app/forms';
  import type { DocRole } from '@docedit/protocol';
  import { SHARE_ROLES, roleLabel, type GroupRow } from './share-model.ts';

  interface SharePerson {
    sub: string;
    name: string;
    role: DocRole | null;
  }

  let {
    people,
    groups,
    me,
    form,
    dialog = $bindable(),
  }: {
    people: SharePerson[];
    groups: GroupRow[];
    /** The signed-in owner's identifier: the owner's own role is not changed here (the action refuses). */
    me: string;
    form: { done?: string; problem?: string } | null | undefined;
    dialog?: HTMLDialogElement | undefined;
  } = $props();

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /**
   * Keeps Tab and Shift+Tab inside the open dialog (UX-095 criterion 6). A modal `<dialog>` makes the
   * rest of the page inert, but the browser still moves focus out of the dialog past its last
   * control, so the dialog wraps focus itself.
   */
  function trapFocus(event: KeyboardEvent) {
    if (event.key !== 'Tab' || !dialog) return;
    const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

<dialog bind:this={dialog} class="share-dialog" aria-labelledby="share-heading" onkeydown={trapFocus}>
  <div class="share-head">
    <h2 id="share-heading">Share this document</h2>
    <form method="dialog">
      <button type="submit">Close</button>
    </form>
  </div>
  <p class="muted">
    Region grants and workflow participants are not managed here. Use the editor's permissions pane
    for them.
  </p>

  {#if form?.problem}
    <p class="notice problem" role="alert">{form.problem}</p>
  {:else if form?.done}
    <p class="notice" role="status" data-testid="share-done">{form.done}</p>
  {/if}

  <h3>People</h3>
  <table>
    <thead>
      <tr>
        <th scope="col">Person</th>
        <th scope="col">Role</th>
      </tr>
    </thead>
    <tbody>
      {#each people as person (person.sub)}
        <tr data-share-person={person.sub}>
          <td>{person.name}</td>
          <td>
            {#if person.sub === me}
              <span class="muted">{roleLabel(person.role)} (you)</span>
            {:else}
              <form class="inline-form" method="POST" action="?/role" use:enhance>
                <input type="hidden" name="sub" value={person.sub} />
                <label class="visually-hidden" for="share-role-{person.sub}">Role of {person.name}</label>
                <select id="share-role-{person.sub}" name="role" value={person.role ?? 'none'}>
                  <option value="none">{roleLabel(null)}</option>
                  {#each SHARE_ROLES as r (r)}
                    <option value={r}>{roleLabel(r)}</option>
                  {/each}
                </select>
                <button type="submit">Save role</button>
              </form>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>

  <h3>Groups</h3>
  <p class="muted">Groups hold no document role in this demo. Each member keeps their own role.</p>
  {#if groups.length === 0}
    <p class="muted">No groups in the directory.</p>
  {:else}
    <ul class="share-groups">
      {#each groups as group (group.id)}
        <li data-share-group={group.id}>
          <strong>{group.name}</strong>
          <span class="muted">
            {group.members.map((m) => `${m.name} (${roleLabel(m.role)})`).join(', ') || 'No members'}
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</dialog>
