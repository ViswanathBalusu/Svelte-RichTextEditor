// Types of the reference host's SvelteKit application.
declare global {
  namespace App {
    interface Locals {
      /** The person of the demo session, set by the routes under `/as/[user]`. */
      sub?: string;
    }
  }
}

export {};
