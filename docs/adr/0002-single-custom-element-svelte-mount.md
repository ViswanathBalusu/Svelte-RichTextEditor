# ADR 0002: One hand-written custom element with Svelte mounted inside

**Status:** proposed, 2026-09-18.

## Context

The editor must be one web component with its own Shadow DOM, built with Svelte (R2). Svelte 5 can compile a component into a custom element through `<svelte:options customElement>`. Reading its wrapper showed that the inner component is created a microtask after the element connects and destroyed a microtask after it disconnects, that context does not cross custom-element boundaries, that slotted content renders eagerly, and that the element class cannot be hot-swapped in development.

Host frameworks routinely move elements in the DOM. An editor that loses its state when that happens is not acceptable.

## Decision

Write the custom element class by hand. It attaches an open shadow root and mounts an ordinary Svelte 5 application into it with `mount()`. There are no nested custom elements; everything inside is a normal Svelte component. Component CSS is delivered through constructable stylesheets on `adoptedStyleSheets`. The build is one ECMAScript module from Vite library mode.

## Consequences

Good:
- The element controls its own lifecycle: a move in the DOM suspends and resumes instead of destroying.
- Svelte context, stores and ordinary component composition work inside the editor.
- One shared stylesheet object for all instances, and no injected `<style>` elements for strict content security policies to block.

Bad:
- Attribute reflection, property setters and event dispatch are written by hand.
- The constructable-stylesheet approach needs the build to emit CSS separately and must be verified under a strict policy (spike S2). The fallback is injected CSS with a nonce.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Svelte's `customElement` option for the root | Lifecycle destroys state on disconnect; weaker control over styles and registration |
| Many small custom elements | Loses context, multiplies asynchronous lifecycles, nests selection roots |
| Lit for the shell with Svelte inside | A second framework for no gain |
| A closed shadow root | ProseMirror's focus handling and testing tools need an open root; a closed root is not a security boundary anyway |
| No Shadow DOM, scoped class names only | Fails the isolation requirement |

## After the first review (2026-09-18)

- Svelte 5 normally builds templates through `innerHTML` and creates its own Trusted Types policy when its module loads, which throws if a host that also uses Svelte 5 restricts policy names. The component is compiled with `fragments: "tree"`. Svelte's injected-style mode sets no nonce, so the style fallback is a `<style>` element the component creates itself.
- ProseMirror's paste parser, the math editor and the PDF viewer have their own policy needs. The project publishes what a host must allow, per feature, and spike S2 covers every dependency.
- "Suspend on disconnect, destroy on garbage collection" leaks in single-page applications. The element destroys itself after a grace period unless `keep-alive` is set.
- Loading starts only when both a document identifier and a token source are present, and properties set before the element is upgraded are captured, because frameworks differ in when they set properties.
- Fonts registered on the document are global to the host page, so they are registered under hash-derived aliases.
- A name collision with a different version of the element is reported, not ignored.

## Revisit when

Svelte's custom-element wrapper gains lifecycle control, or a supported browser blocks constructable stylesheets under common policies.
