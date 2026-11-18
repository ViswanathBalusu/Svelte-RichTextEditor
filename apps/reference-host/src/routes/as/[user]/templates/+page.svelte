<!--
  The template gallery (UX-100): the host's templates, each a form with a title and the fields
  that may be filled in at the start. Plain forms, so the page works with the keyboard and
  without script; each control has a visible label, and each template is a labelled group.
-->
<script lang="ts">
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  const inputTypes: Record<string, string> = { text: 'text', number: 'text', date: 'date', choice: 'text' };
</script>

<svelte:head>
  <title>Templates · Reference host</title>
</svelte:head>

<h1>Templates</h1>
<p><a href="{data.base}/">Back to the documents</a></p>
{#if form?.problem}
  <p class="notice problem" role="alert">{form.problem}</p>
{/if}

{#if data.templates.length === 0}
  <p>The host has no templates yet.</p>
{:else}
  <ul class="templates" aria-label="Templates">
    {#each data.templates as t (t.id)}
      <li data-template={t.key}>
        <form method="POST" action="?/use" aria-labelledby="name-{t.key}">
          <h2 id="name-{t.key}">{t.name}</h2>
          <p>{t.description}</p>
          <input type="hidden" name="template" value={t.id} />
          <div class="field">
            <label for="title-{t.key}">Title of the new document</label>
            <input id="title-{t.key}" name="title" required maxlength="1000" />
          </div>
          {#if t.unavailable}
            <p class="muted">The fields of this template cannot be read now. Try again later.</p>
          {:else if t.fields.length > 0}
            <fieldset>
              <legend>Fill in at the start (optional)</legend>
              {#each t.fields as f (f.key)}
                <div class="field">
                  {#if f.kind === 'checkbox'}
                    <input id="v-{t.key}-{f.key}" type="checkbox" name="value:{f.key}" />
                    <label for="v-{t.key}-{f.key}">{f.label}</label>
                  {:else}
                    <label for="v-{t.key}-{f.key}">{f.label}</label>
                    <input
                      id="v-{t.key}-{f.key}"
                      type={inputTypes[f.kind] ?? 'text'}
                      name="value:{f.key}"
                      inputmode={f.kind === 'number' ? 'decimal' : undefined}
                    />
                  {/if}
                </div>
              {/each}
            </fieldset>
            <p class="muted">
              Signatures, initials, dates signed and calculated fields are set when the document is
              signed, so they are not offered here.
            </p>
          {/if}
          <button class="primary" type="submit">Create from {t.name}</button>
        </form>
      </li>
    {/each}
  </ul>
{/if}
