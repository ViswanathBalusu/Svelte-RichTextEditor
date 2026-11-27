<!--
  The editor page (UX-093): `<doc-editor>` embedded through its attributes, properties, methods and
  events only (05 §8.1), with the page glue of lib/glue. The title is the host's and goes into the
  element's title slot (UX-014). The element's module is the published bundle, served by the host
  (routes/element). For the owner, the host's panels change region grants and roles; they submit
  without reloading the page, so the editor stays connected and the change arrives live.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { enhance } from '$app/forms';
  import { beforeNavigate, goto } from '$app/navigation';
  import { attachHostToolbar } from '../../../../../lib/glue/host-toolbar.ts';
  import {
    attachEditor,
    flushBeforeNavigation,
    type EditorLike,
    type FlushOutcome,
  } from '../../../../../lib/glue/page-glue.ts';
  import { SAMPLE_STRINGS, sampleExtension } from '../../../../../lib/sample-extension.ts';
  import ShareDialog from '../../../../../lib/share/ShareDialog.svelte';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  let editor: HTMLElement | undefined = $state();
  let shareDialog: HTMLDialogElement | undefined = $state();
  let toolbarHost: HTMLElement | undefined = $state();
  let status = $state('Loading the editor');
  let problem: string | null = $state(null);
  let fatal = $state(false);
  let toolbarNote = $state('');
  let lastFlush: FlushOutcome | null = $state(null);
  let leaving = false;

  const ELEMENT_MODULE = '/element/doc-editor.js';

  const roleNames: Record<string, string> = {
    none: 'No access',
    viewer: 'Viewer',
    commenter: 'Commenter',
    suggester: 'Suggester',
    editor: 'Editor',
    owner: 'Owner',
  };

  const restrictionNames: Record<string, string> = {
    'no-export': 'No export',
    'no-copy': 'No copy',
    'no-print': 'No print',
  };

  onMount(() => {
    let detach = () => {};
    let detachToolbar: (() => void) | null = null;
    let stopped = false;
    void (async () => {
      // The published element, as an adopting host loads it (FE-001, FE-002).
      await import(/* @vite-ignore */ ELEMENT_MODULE);
      await customElements.whenDefined('doc-editor');
      if (stopped || !editor) return;
      const el = editor as unknown as EditorLike & {
        config: Record<string, unknown>;
        extensions: unknown;
        strings: Record<string, string> | null;
      };
      if (data.viewerUrl) el.config = { pdfViewerUrl: data.viewerUrl };
      // The sample extension (UX-050 criterion 6): off unless the page is opened with ?sample-extension.
      if (new URLSearchParams(location.search).has('sample-extension')) {
        el.strings = { ...SAMPLE_STRINGS };
        el.extensions = [sampleExtension];
      }
      detach = attachEditor(el, {
        api: `${data.base}/api`,
        docId: data.doc.id,
        onSignInNeeded: () => {
          problem = 'Your session with this host ended. Choose a person again on the start page.';
          fatal = true;
        },
        onAccessLost: () => {
          problem = 'You no longer have access to this document.';
          fatal = true;
        },
        onError: (d) => {
          problem = d.message;
          fatal = d.fatal;
        },
        onStatus: (d) => {
          status = `${d.connection}, ${d.sync}`;
        },
        // The element's share command asks the host; the host's dialog opens (UX-093 criterion 6).
        onShareRequest: openShare,
      });
      // The element is an HTMLElement: its queryCommand and exec are optional (PRO-085), so it is a CommandHost.
      detachToolbar = toolbarHost ? attachHostToolbar(editor, toolbarHost) : null;
      if (!detachToolbar)
        toolbarNote = 'This version of the element offers no queryCommand and exec yet (PRO-085).';
    })();
    return () => {
      stopped = true;
      detach();
      detachToolbar?.();
    };
  });

  // Before the host navigates, unconfirmed work is flushed (05 §8.1; UX-093 criterion 3).
  beforeNavigate((nav) => {
    if (leaving || nav.willUnload || !editor || !nav.to) return;
    nav.cancel();
    const to = nav.to.url;
    void flushBeforeNavigation(editor as unknown as EditorLike, 3000).then((outcome) => {
      lastFlush = outcome;
      leaving = true;
      void goto(to);
    });
  });

  function reload() {
    problem = null;
    fatal = false;
    (editor as EditorLike | undefined)?.load();
  }

  /** Opens the host's share dialog for the owner; anyone else is told it is the owner's (UX-095). */
  function openShare() {
    if (!shareDialog) {
      problem = 'Only the owner can share this document.';
      return;
    }
    if (!shareDialog.open) shareDialog.showModal();
  }

  const nameOf = (principal: string) =>
    principal.startsWith('user:') ? (data.names[principal.slice(5)] ?? principal) : principal;
</script>

<svelte:head>
  <title>{data.doc.title} · Reference host</title>
</svelte:head>

<div class="editor-bar">
  <h1>{data.doc.title}</h1>
  <span class="muted" data-testid="host-status" aria-live="polite">Editor: {status}</span>
  <span class="muted">Your role: {roleNames[data.doc.role] ?? data.doc.role}</span>
  <button type="button" onclick={openShare}>Share</button>
</div>

{#if problem}
  <div class="notice problem" role="alert" data-testid="host-problem">
    <p>{problem}</p>
    {#if fatal}
      <p class="row-actions">
        <button type="button" onclick={reload}>Load the document again</button>
        <a href="/">Back to the start page</a>
      </p>
    {/if}
  </div>
{/if}
{#if form?.problem}
  <p class="notice problem" role="alert">{form.problem}</p>
{:else if form?.done}
  <p class="notice" role="status" data-testid="host-done">{form.done}</p>
{/if}

<div class="row-actions">
  <span class="muted">Example host toolbar (UX-005):</span>
  <div class="host-toolbar" role="toolbar" aria-label="Host toolbar" bind:this={toolbarHost}></div>
  {#if toolbarNote}<span class="muted" data-testid="host-toolbar-note">{toolbarNote}</span>{/if}
  {#if lastFlush}<span class="muted">Last flush: {lastFlush}</span>{/if}
</div>

<!-- The ribbon layout (ADR 0490): tabs of labelled groups, the page on a grey canvas. -->
<doc-editor bind:this={editor} endpoint={data.endpoint} toolbar="ribbon" locale="en-GB">
  <span slot="title" data-testid="title-slot">{data.doc.title}</span>
</doc-editor>

{#if data.owner}
  <ShareDialog
    people={data.owner.people}
    groups={data.owner.groups}
    me={data.person.sub}
    {form}
    bind:dialog={shareDialog}
  />

  <p><a href="{data.base}/docs/{data.doc.id}/send">Send for completion</a></p>

  <section class="panel" aria-labelledby="regions-heading">
    <h2 id="regions-heading">Who can edit each region</h2>
    <p class="muted">
      Grants are stored by the document service and take effect at once for everyone who has the
      document open (07 §9).
    </p>
    <table>
      <thead>
        <tr>
          <th scope="col">Region</th>
          <th scope="col">Editors by grant</th>
          <th scope="col">Change</th>
        </tr>
      </thead>
      <tbody>
        {#each data.owner.regions as region (region.id)}
          <tr data-region={region.id}>
            <td>{region.title}</td>
            <td data-testid="editors-{region.id}">
              {region.editors.map(nameOf).join(', ') || 'None'}
            </td>
            <td>
              <form class="inline-form" method="POST" action="?/grant" use:enhance>
                <input type="hidden" name="region" value={region.id} />
                <label class="visually-hidden" for="grant-{region.id}">Person for {region.title}</label>
                <select id="grant-{region.id}" name="sub">
                  {#each data.owner.people as person (person.sub)}
                    <option value={person.sub}>{person.name}</option>
                  {/each}
                </select>
                <button type="submit" name="change" value="give">Give edit rights</button>
                <button type="submit" name="change" value="take">Take edit rights</button>
              </form>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </section>

  <section class="panel" aria-labelledby="people-heading">
    <h2 id="people-heading">People and roles</h2>
    <p class="muted">
      Roles are the host's sharing decisions. Taking a role away ends that person's sessions on
      this document at once (05 §3.3). Output restrictions apply from the person's next token.
    </p>
    <table>
      <thead>
        <tr>
          <th scope="col">Person</th>
          <th scope="col">Role</th>
          <th scope="col">Output restrictions</th>
        </tr>
      </thead>
      <tbody>
        {#each data.owner.people as person (person.sub)}
          <tr data-person={person.sub}>
            <td>{person.name}</td>
            <td>
              {#if person.sub === data.person.sub}
                {roleNames[person.role ?? 'none']}
              {:else}
                <form class="inline-form" method="POST" action="?/role" use:enhance>
                  <input type="hidden" name="sub" value={person.sub} />
                  <label class="visually-hidden" for="role-{person.sub}">Role of {person.name}</label>
                  <select id="role-{person.sub}" name="role" value={person.role ?? 'none'}>
                    {#each ['none', 'viewer', 'commenter', 'suggester', 'editor', 'owner'] as r (r)}
                      <option value={r}>{roleNames[r]}</option>
                    {/each}
                  </select>
                  <button type="submit">Save</button>
                </form>
              {/if}
            </td>
            <td>
              {#if person.role !== null}
                <form class="inline-form" method="POST" action="?/restrict" use:enhance>
                  <input type="hidden" name="sub" value={person.sub} />
                  <fieldset>
                    <legend class="visually-hidden">Output restrictions of {person.name}</legend>
                    {#each data.owner.restrictions as r (r)}
                      <label>
                        <input
                          type="checkbox"
                          name="restrict"
                          value={r}
                          checked={person.restrict.includes(r)}
                        />
                        {restrictionNames[r] ?? r}
                      </label>
                    {/each}
                  </fieldset>
                  <button type="submit">Save</button>
                </form>
              {:else}
                <span class="muted">No access</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    <form class="inline-form" method="POST" action="?/rename" use:enhance>
      <label for="rename-title">Title</label>
      <input id="rename-title" name="title" value={data.doc.title} maxlength="1000" required />
      <button type="submit">Rename</button>
    </form>
  </section>
{/if}
