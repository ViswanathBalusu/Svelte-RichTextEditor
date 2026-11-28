<!--
  The frame of every page of the reference host: a skip link, the app bar with the product's working
  name, the demo-only notice (UX-091 criterion 4, UX-092 criterion 1) and the main landmark. The look
  is a familiar office word processor's, to match the editor's ribbon layout; the app bar's mark is a
  plain page drawn in strokes, this product's own.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import '../app.css';

  let { children }: { children: Snippet } = $props();
</script>

<a class="skip" href="#main">Skip to the content</a>
<header>
  <div class="appbar">
    <a class="brand" href="/">
      <span class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M6 3h8l4 4v14H6z" />
          <path d="M14 3v4h4" />
          <path d="M9 12h6" />
          <path d="M9 16h6" />
        </svg>
      </span>
      <span>DocEdit <small>reference host</small></span>
    </a>
  </div>
  <div class="banner">
    <p class="product">Reference host</p>
    <p class="demo-only" role="note">
      Demo only. You choose who to act as and no password is asked. This is not a production
      deployment.
    </p>
  </div>
</header>
<main id="main" tabindex="-1">
  {@render children()}
</main>
