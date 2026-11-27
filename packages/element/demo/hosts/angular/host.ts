/**
 * The Angular host (FE-124 criterion 1): a standalone component compiled in the browser (the JIT
 * compiler), with the custom elements schema. The component is declared by calling `Component`
 * instead of using the decorator syntax, so the bundler needs no decorator transform. `doc-id` is an
 * attribute binding and `backend` a property binding.
 */
import '@angular/compiler';
import { Component, CUSTOM_ELEMENTS_SCHEMA, VERSION, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { startHost, type HostFixtures } from '../fixtures.ts';

const host: HostFixtures = await startHost('angular', VERSION.full);

class HostApp {
  readonly clicks = signal(0);
  readonly docId = host.docId;
  readonly backend = host.backend;
  constructor() {
    host.status.rendered = true;
  }
}

Component({
  selector: 'host-app',
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <main>
      <button id="host-button" type="button" (click)="clicks.set(clicks() + 1)">
        Host clicks: {{ clicks() }}
      </button>
      @if (clicks() > 0) {
        <p id="host-clicked">Clicked {{ clicks() }} times</p>
      }
      <doc-editor data-test="host" [attr.doc-id]="docId" [backend]="backend"></doc-editor>
    </main>
  `,
})(HostApp);

await bootstrapApplication(HostApp);
