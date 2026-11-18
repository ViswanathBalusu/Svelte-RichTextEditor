# Integration guide

This guide says what your application must build to embed `<doc-editor>` (13 section 11.1; UX-090). The reference host in `apps/reference-host` does each part, and every example below is taken from its code. The code is the working version; this guide explains it.

The guide is for an integrating developer. It is not a production deployment guide. The reference host is a demo (see its README).

## Who owns what

The host owns identity, the document catalogue, sharing and notifications. The editor owns editing, the rights on parts, fields and history, and the output.

| Concern | Owner | Where the reference host does it |
|---|---|---|
| Who the user is, and their session | Host | `src/lib/server/host.ts`, `src/lib/server/request.ts` |
| Which document a user may open, and in what role | Host (decides), document service (enforces) | `src/lib/server/tokens.ts` |
| The list of documents, titles, folders, sharing | Host | `src/lib/server/catalogue.ts` |
| Notifications for mentions and tasks | Host | `src/lib/server/webhook-notifications.ts` |
| Editing, rights on parts and fields, history, output restrictions | Editor and document service | Not written by the host |

The editor never lists documents. It opens one document, given its identifier and a token for it.

## 1. The token endpoint

Your server authenticates the user with your own session. It decides the user's role on one document from your own records. It then returns a short-lived token for that document, in a response body only.

Requirements:

- The token is for one document. Never put it in a URL, a log line or browser storage.
- Answer `401` when there is no session, and `403` when the user has no role on the document.
- Register your public keys and allowed origins with the document service before the first token is issued.

The reference host's endpoint is `src/routes/as/[user]/api/token/+server.ts`. It returns `NO_STORE` headers so that the browser does not keep the response. A request looks like this:

```http
POST /as/u-ada/api/token
Content-Type: application/json

{"docId": "doc-supply-agreement"}
```

```json
{"token": "eyJhbGciOi...", "expiresAt": "2026-11-13T10:15:00Z"}
```

The token's role comes from the catalogue as it is now. The token issuer is in `src/lib/server/tokens.ts`. A service-minted token uses the document service's `POST /tokens` with your service credential. A host-signed token is signed with your registered private key. The private key and the service credential stay on the server.

Registration of keys and origins is seeded from configuration in the reference host (`scripts/lib/stack.ts`, `tenantRegistration`).

### The user identifier: `sub`

The `sub` claim of the token names the user (protocol, 05 section 3.1). Choose it with care:

- **Opaque.** The document service gives `sub` no meaning. It only compares it for equality. Do not put a name, a role or anything else a person could read into it.
- **Stable.** Send the same `sub` for the same person in every token, for as long as the person exists in your directory. Grants, comments and history are attributed through it. If it changes, the service sees a different user.
- **Not an e-mail address.** Do not use e-mail addresses as `sub`. An address is personal data, and it changes when a person changes name or employer. Use the key of the user's record in your own directory. The reference host uses identifiers such as `u-ada`.

The document service does not write `sub` into the commit log. It stores a per-tenant surrogate identifier for each `sub`, in one row per user, and the log holds the surrogate (history, 08 section 13). Erasing a person deletes that row. Their contributions remain, attributed to an identifier that no longer leads anywhere.

The display name is the optional `name` claim. It is separate from `sub` and can be purged.

## 2. The page glue

The page glue connects the element to your host. It uses only the element's attributes, properties, methods and events (05 section 8.1). The glue is framework-free: copy `src/lib/glue/page-glue.ts` into your page. Your page calls `attachEditor` once and keeps the function it returns to detach.

```ts
import { attachEditor, flushBeforeNavigation } from './page-glue.ts';

const el = document.querySelector('doc-editor');
const detach = attachEditor(el, {
  api: '/as/u-ada/api',          // your host's API for the signed-in person
  docId: 'doc-supply-agreement', // the document; your host chose the role when it signed the token
  onSignInNeeded: () => showSignIn(),
  onAccessLost: () => showNoAccess(),
  onError: ({ message, fatal }) => showError(message, fatal),
  onStatus: ({ connection, sync }) => updateIndicator(connection, sync),
  onShareRequest: () => openShareDialog(),
});

// Later, before the page navigates away:
await flushBeforeNavigation(el, 3000);
detach();
```

The reference host's page is `src/routes/as/[user]/docs/[id]/+page.svelte`. It loads the element module and sets `endpoint` and `toolbar="compact"` on the element.

The glue sets the element's `doc-id` attribute. The element starts loading once both `doc-id` and the glue's properties are present, so the order of setting them does not matter.

### Tokens: getToken and renewal

The element calls `getToken({ docId })` when it starts, and again when the service says the token is expiring. `tokenSource` calls your token endpoint with `POST` and a JSON body, and hands the `token` field back to the element. Nothing else keeps it.

### The host's directory

The element asks for names and people through `resolveUsers` and `searchPrincipals`. The glue supplies them as `directoryResolver` and `principalSearch`. Both call one host route, `api/directory`:

- `resolveUsers` sends `{"resolve": ["u-ada", "u-bob"]}` and reads `{"users": [...]}`. Identifiers go to the host, never document content.
- `searchPrincipals` sends `{"search": {"text": "ad", "kinds": ["user", "group"], "limit": 10}}` and reads `{"principals": [...]}`. It is used for the grants dialog and mentions.

The reference host's route is `src/routes/as/[user]/api/directory/+server.ts`.

### When the token is refused

The element sends `de-auth-required` when the service refuses the token. The glue decides what to do:

- If your session ended (the token endpoint answered `401`), the glue calls `onSignInNeeded`.
- If your host no longer gives the person a role (`403` or `404`), the glue calls `onAccessLost`.
- Otherwise the service refused a token that was valid when issued (it expired or was revoked). The glue loads the document again, which asks for a new token. A second refusal within 30 seconds (`AUTH_RETRY_WINDOW_MS`) is treated as access lost.

### Errors

`de-error` carries `{ code, message, fatal }`. Show `message` to the person. When `fatal` is true the editor waits for the host, so offer to load the document again.

### Sharing

`de-share-request` means the person asked to share. Sharing belongs to the host, so the host opens its own share dialog. The editor never changes grants on its own.

### Leaving the page

Call `flushBeforeNavigation(el, timeoutMs)` before the host navigates away. It waits until nothing the person typed is unconfirmed. If the wait times out, the unconfirmed work stays in the editor's journal and returns when the document is opened again. Older element versions do not offer `flush`; the call then answers `unsupported`.

## 3. The webhook receiver

The document service sends webhooks (05 section 7) to your server. Your receiver must:

- check the signature of each delivery, with the Standard Webhooks scheme (headers `webhook-id`, `webhook-timestamp` and `webhook-signature`; HMAC-SHA256 over `id.timestamp.body`);
- refuse a timestamp more than five minutes from its own clock;
- accept two secrets during a rotation;
- drop a delivery whose `webhook-id` it has already handled, because retries repeat deliveries;
- answer before doing any slow work, and not assume the order of events.

The reference host's receiver is `src/lib/server/webhook-receiver.ts`, and its route is `src/routes/webhooks/dep/+server.ts`. The core check is `verifyWebhook`:

```ts
import { verifyWebhook } from './webhook-receiver.ts';

const result = verifyWebhook({
  headers: request.headers,
  body: rawBody,                    // the body as received, before any parsing
  secrets: [process.env.WEBHOOK_SECRET!],
  nowSeconds: Math.floor(Date.now() / 1000),
});
if (!result.ok) return new Response(result.reason, { status: 401 });
if (seen.has(result.id)) return new Response(null, { status: 202 }); // a duplicate
seen.add(result.id, result.timestamp);
queue.push(JSON.parse(rawBody));
return new Response(null, { status: 202 });
```

The secrets are read from `DOCEDIT_HOST_WEBHOOK_SECRETS` in the reference host (one secret, or two separated by a space or a comma during a rotation). A real host keeps its secrets in its own secret store and keeps the identifiers it has seen in durable storage. The reference host keeps them in memory, which is a demo limit.

Use `verifyWebhook` on the raw body. A body that has been parsed and written again may not match the signature.

## 4. The host's own catalogue

Your application keeps its own list of documents: titles, folders, who has which role and the sharing decisions. Key each record by the document service's identifier, and store the `externalId` you set when you created the document. The editor never lists documents.

The reference host's catalogue is `src/lib/server/catalogue.ts`. Each entry holds:

- `id`, the document service's identifier;
- `externalId`, the host's own identifier, set at creation;
- `title`, `template` and `createdBy`;
- `roles`, the role of each user on the document, which goes into the token;
- `accessSince` and `restrict`, which go into the token's claims (05 section 3.1);
- `deletedAt`, so that a delete keeps the row, as the service keeps the document.

An entry in the reference host's catalogue file looks like this (the values are the demo's):

```json
{
  "id": "doc-supply-agreement",
  "externalId": "contracts-2026-0042",
  "title": "Supply agreement",
  "template": null,
  "createdBy": "u-olivia",
  "createdAt": "2026-11-01T09:00:00Z",
  "roles": { "u-ada": "editor", "u-bob": "editor", "u-olivia": "owner" },
  "accessSince": { "u-ada": "2026-11-01T09:00:00Z" },
  "deletedAt": null
}
```

The catalogue is one JSON file in the reference host, written whole and atomically. A real host uses its own database.

## 5. Notifications

Your host sends the messages people need: e-mail or chat for mentions, task assignments, workflow invitations and reminders. The document service sends the events, and your webhook receiver turns them into messages.

The reference host's notifier is `src/lib/server/webhook-notifications.ts`. It notifies on two events:

- `dep.comment.mentioned.v1`, for a mention;
- `dep.task.assigned.v1`, for a task.

The notifier is a handler for the work queue. Your application supplies the sink that sends the message:

```ts
import { notifier, type NotificationSink } from './webhook-notifications.ts';

const sink: NotificationSink = {
  async send(n) {
    // n carries the document, the event type and the delivery identifier, and nothing else.
    // Your own directory decides who receives the message.
    const people = await recipientsOf(n.document); // your code
    await mailer.send({ to: people, subject: `Activity on document ${n.document}` }); // your code
  },
};

const handle = notifier(sink); // the queue calls handle(event) for each verified event
```

Each notification names the document, the event type and the delivery identifier. It does not name the mentioned person or the comment, because the event does not carry them (gap G83). The reference host does not send e-mail yet: its sink writes one log line with identifiers only. Your application decides who receives the message, from your own directory.

## Strict content security policy

Hosts that serve a strict policy must allow what the component needs, feature by feature. The list below is measured, not guessed: spike S2 (`docs/spikes/2026-11-06-s2-csp-trusted-types.md`, section 8) ran each feature under a strict baseline (`default-src 'none'`, no `unsafe-inline`, no `unsafe-eval`, `require-trusted-types-for 'script'`, `trusted-types 'none'`) in Chromium, Edge, Firefox and WebKit. Names are the project's working names, as the spike uses them.

### Every host (the editor itself)

- `script-src`: the origin that serves the component's module and its lazy chunks. Neither `'unsafe-inline'` nor `'unsafe-eval'`.
- `style-src`: nothing inline. The component's CSS is one constructable stylesheet, shared by every instance. If your policy or browser refuses constructable sheets, pass a nonce in `config.styleNonce` and allow it in `style-src`; the component then writes its own `<style nonce>` element.
- `require-trusted-types-for 'script'` is supported. The editor creates no policy of its own for its core.
- Global side effects: the `doc-editor` element name. Nothing else is added to the page by default.

### Paste

- `trusted-types docedit-paste`: the element reads pasted HTML through this policy, created on the first paste of HTML. Or a `default` policy, which the element tries first.
- `trusted-types ProseMirrorClipboard` is ProseMirror's own policy. A host that allows only this name gets one violation on the first HTML paste, and the plain text is then pasted. Allow `docedit-paste` as well.
- With neither name nor a `default` policy allowed, the HTML is not read and the plain text is pasted; the paste never throws.

### Math display (KaTeX)

- `font-src`: the origin of the KaTeX font files.
- No inline style is needed for ordinary formulae. `\fcolorbox` writes style attributes and needs `style-src-attr 'unsafe-inline'`; the component does not use KaTeX's error rendering.
- Side effect: twelve `KaTeX_*` font families are added to `document.fonts`.

### Math editor (MathLive)

- `trusted-types docedit-math`.
- `style-src-attr 'unsafe-inline'`: MathLive writes inline styles in its markup. This does not allow `<style>` elements.
- `font-src`: the origin of MathLive's fonts.
- Side effects: the custom element names `math-field`, `math-span` and `math-div`, and the twelve `KaTeX_*` font families.
- A host that cannot allow inline style attributes cannot use the math editor.

### PDF panel (PDF.js)

- On the page: `trusted-types docedit-worker`; `worker-src` and `script-src` for the origin of `pdf.worker.mjs`; `connect-src` for the place the PDF is fetched from, if it is fetched by URL.
- In the worker script's own response policy, if you serve one: `script-src` for the PDF.js origin, plus `'wasm-unsafe-eval'` for PDF.js's WebAssembly decoders; `connect-src` for the PDF.js origin, because the worker fetches its decoders, CMaps and standard fonts.
- Without `'wasm-unsafe-eval'` the panel still renders, with JavaScript decoders and an approximation of ICC colours, and Chromium, Edge and Firefox report each refused module. Setting `useWasm: false` avoids both.
- A worker script served without a policy is not restricted at all.
- Production puts the viewer in a sandboxed cross-origin frame (09 section 9.3, rule 7; FE-071). Then the host needs `frame-src` for the viewer's origin, and the lines above apply to the frame's own policy. That frame is not built yet.

### WebAssembly kernels (ADR 0016, later)

- In a same-origin worker, the worker script's response policy needs `'wasm-unsafe-eval'`, and the page needs nothing. In a `blob:` worker, the page's `script-src` needs `'wasm-unsafe-eval'` and `worker-src` needs `blob:`.
- WebKit does not report a refused compilation, so the kernel detects the failure itself and uses its fallback.

### Your own Svelte or framework

- If your page runs Svelte 5 through its HTML-string template path, your Svelte needs its `svelte-trusted-html` policy allowed. The component adds no Svelte policy, so it needs no `'allow-duplicates'`.

### Framework notes

These notes say where each framework sets the things above. They were not run in a framework project in this lane; the browser measurements above cover the component, not the framework wiring.

- **Plain HTML.** Send the policy as a response header. A `<meta http-equiv="Content-Security-Policy">` element works for the directives above, but not for `frame-ancestors` or `report-uri`. Set `config` on the element as a property, not an attribute, because the configuration is an object.
- **React.** Set `config` on the element through a ref (`ref.current.config = …` in an effect), because React passes unknown props on custom elements as attributes. Generate the nonce per response on the server and pass the same value into `config.styleNonce` and the policy header.
- **Angular.** Add `CUSTOM_ELEMENTS_SCHEMA` to the component that hosts the element, and bind the configuration with a property binding (`[config]`). Check your production build for inline scripts before you add a hash or a nonce to `script-src`.
- **Vue.** Tell the compiler that `doc-editor` is a custom element (`compilerOptions.isCustomElement`), and set `config` with the `.prop` modifier or through a ref.
- **SvelteKit.** The `kit.csp` option in `svelte.config.js` can generate a nonce per request. Read it from the page data and pass it into `config.styleNonce`. Check the generated policy against the list above.

## Extensions (UX-050, UX-052; 13 section 7)

You register an extension through the element's `extensions` property: an array of entries, each with a manifest and its code. The editor checks each manifest on its own. An invalid entry, an unsupported API version and an activation that throws are each reported as a `de-error` that names the entry, with `fatal` false, and the other entries still load.

**Tier 1 extensions run in the page, with the host's trust.** This is the only tier built. An extension you register runs in your page, in the same JavaScript realm as your own code. It can do what your page can do: read the editor's shadow root, call its methods and read everything your page holds, including the user's token. The editor does not sandbox it. Register only code you would put in your page yourself. A sandboxed tier for third-party add-ins is planned for later and is not built.

An extension's hooks must not sit on the typing path: the editor calls them after the change and a hook that throws or never answers does not stop editing.

### What a panel is held to

A panel an extension contributes is held to the same accessibility bar as a built-in panel (13 section 7.2). The editor supplies the pane host; you supply the content. Your panel must:

1. **Name itself.** Give the panel a title, which the pane host shows as its heading. Give every control and region inside it an accessible name.
2. **Work from the keyboard.** Every control is reachable with Tab and has a visible focus. Nothing traps focus. The panel is reachable with Ctrl+F6, as every pane is, and Escape closes it and returns focus to the text.
3. **Take focus when opened.** The pane host moves focus into the panel's content when it opens; the content must have somewhere to take it.
4. **Give a text alternative for a status-bar item.** The visible text is hidden from assistive technology, and a label that says what it means is read in its place.
5. **Not rely on colour alone.** Use the `--de-` properties for text, surface and border colours, so that your panel follows the host's theme, dark mode and forced colours.
6. **Pass axe with no violations.** The editor's own panels are checked with axe. Run axe and a keyboard pass on your panel before you ship, in light and dark mode.
7. **Obey the strict content security policy.** Under the policy in the section above, a `style` attribute and a `style` element are refused. Set styles through the CSS object model or an adopted style sheet.

The editor's tests check items 1 to 3, 4, 5 and 6 on a panel that a test harness contributes, in Chromium, Firefox and WebKit. This reference host does not ship a sample extension yet (UX-050), so the guide has no sample to point to.

## Backend tiers (05 section 9; PRO-101)

A backend announces its features in `welcome`, and the client shows only the controls those features allow. Choose the tier by how much document semantics you run yourself.

| Tier | What it runs | What it may announce |
|---|---|---|
| Native | An authority of its own that passes the step-semantics and rules fixtures | Everything |
| Sidecar-backed | Its own gateway, storage and control plane, with document semantics delegated to the authority service | Only what the authority service supports |
| Relay | Ordering and storage only | `mode: "relay"`; none of `regions`, `suggest-enforced` or `fields`. Content reads, restore, comparison and export still need the authority service |

A relay is for trusted clients only. It cannot enforce region permissions, suggestion-only or fill-only roles, or invariants, and it cannot test the steps it stores (SYN-044). Use a relay only where every client that connects is trusted. The client refuses a relay that announces `regions`, `suggest-enforced` or `fields`. The conformance kit runs `core-relay` for a relay; that profile is not yet built (PRO-124), so the kit does not yet check a relay's announcements end to end.

The authority service interface is in 05 section 10. A sidecar-backed or native backend is not built yet, so no tier is shipped as a finished backend.

## Limits of the embedding

Each limit below comes from the story that sets it. The state given is as it stood on 2026-11-13, and the stories name what is still open.

- **Output restrictions (UX-040).** The restrictions `no-export`, `no-copy` and `no-print` deter casual copying. They are not a security boundary: a person who can open a document can still read it. Who may open a document is decided by your token endpoint and enforced by the document service, not by these restrictions. The editor's rule for each restriction is built, but the copy, cut and drag guards, the `print()` and export call sites and the update of commands on `perm.changed` are not wired yet. Do not promise your users that the editor enforces them. The service's refusal of a direct export request under `no-export` is not yet tested.
- **The shadow root (SEC-009).** The editor attaches an open shadow root. An open shadow root is not a security boundary: your page can read it, and so can any script you load into your page. That is acceptable, because your page already holds the user's token and could ask the service for the same content. It does mean that a script you do not trust must not run in the page that embeds the editor. Content leaves the editor towards your code only through its methods, such as `getContent`; its `de-*` events carry no document text.
- **Extension panels (UX-052).** A panel must meet the same accessibility bar as a built-in panel (13 section 7.2); the requirements are listed in the section "Extensions". The editor is responsible for the pane host and the status bar. The reference host ships no sample extension yet, so no axe check of a sample panel runs in CI; the editor's own tests run axe on a panel that a test harness contributes. Content that a panel loads is the host's own code: run axe and a keyboard pass on it before you ship.
- **Parity (UX-001).** The parity profile (`spec/parity/parity-profile.md`, built from `packages/ui/src/parity/profile.ts`) puts every capability in one tier: built in, through ports and extensions, or non-goal. The non-goals are SmartArt, charts, shapes, text boxes and ink, mail merge, macros, table formulas, researcher-style lookup, transcription and offline-first editing. Read the profile before you promise a feature to your users. Its Gaps section lists what has no story yet, and it changes with each release. This guide matches [parity profile version 2 (2026-11-06)](../../../spec/parity/parity-profile.md). The link is relative, so in the checkout of a release it opens the profile of that release, and a test fails if the version stated here is not the version of that file.

## Signing and identity (FRW-058; 12 section 8.3)

The platform provides a simple electronic signature with an audit trail and a tamper-evident seal applied by the operator or by the tenant's own key. It does not provide signature levels above that on its own.

Signature levels above a simple electronic signature, including the advanced and the qualified levels, are reached through a `SignatureProvider` adapter. At finalisation the adapter sends only the document hash to the provider, and the signature the provider returns is embedded in the PDF. The signature level and the signer identification that the provider reports are recorded in the evidence as asserted by the provider. Whether a use is valid in a jurisdiction is a legal question for the operator and its customers, not a property of the platform.

The ceremony and the evidence record are designed to address intent, consent and retention under ESIGN and UETA: the ceremony asks the signer to act on the document, and the evidence record keeps what the ceremony recorded and how long the operator retains it. This guide does not claim that any signature is valid under either act.

Every participant's authentication is as asserted by the host. The platform does not check who a participant is; the token your host signs names the participant, and the evidence records that assertion.

## Keeping this guide current

A change to the embedding contract, the document service's protocol or the administration API must update this guide in the same change.
