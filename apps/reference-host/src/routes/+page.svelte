<!--
  Start page: choose a seeded person to act as (UX-092 criterion 1). Demo only: no password.
-->
<script lang="ts">
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
</script>

<svelte:head>
  <title>Choose a person · Reference host</title>
</svelte:head>

<h1>Choose a person to act as</h1>
<p class="notice" data-testid="demo-only">
  <strong>Demo only.</strong> No password is asked for. Choosing a person signs you in as them for
  this demonstration, which is not a production sign-in.
</p>
<p>
  This demonstration has four seeded people. Pick one; the pages then act as that person. To edit
  as two people at once, choose one here, then open this page in a second tab and choose the other.
</p>
<p class="muted">Tokens for the editor are {data.tokenMode === 'host-signed' ? 'signed by this host' : 'minted by the document service'} (05 §3.1).</p>
{#if form?.problem}
  <p class="notice problem" role="alert">{form.problem}</p>
{/if}
<ul class="people" aria-label="Seeded people">
  {#each data.people as person, i (person.sub)}
    <li>
      <div class="person-head">
        <span class="avatar" data-tone={i % 4} aria-hidden="true"
          >{person.name
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((word) => word[0]!.toUpperCase())
            .join('')}</span
        >
        <strong>{person.name}</strong>
      </div>
      <div class="muted">{person.about}</div>
      <form method="POST" action="?/signin">
        <input type="hidden" name="sub" value={person.sub} />
        <button class="primary" type="submit">Continue as {person.name}</button>
      </form>
    </li>
  {/each}
</ul>
