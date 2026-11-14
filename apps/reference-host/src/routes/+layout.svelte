<!--
  The frame of every page of the reference host: a skip link, the demo-only notice (UX-091
  criterion 4, UX-092 criterion 1) and the main landmark.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import '../app.css';

  let { children }: { children: Snippet } = $props();
</script>

<a class="skip" href="#main">Skip to the content</a>
<header class="banner">
  <p class="product">Reference host</p>
  <p class="demo-only" role="note">
    Demo only. You choose who to act as and no password is asked. This is not a production
    deployment.
  </p>
</header>
<main id="main" tabindex="-1">
  {@render children()}
</main>
