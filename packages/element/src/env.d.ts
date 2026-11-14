/// <reference types="vite/client" />

/** PDF.js's worker module, loaded into an opaque viewer frame's own thread (src/pdf/viewer/main.ts). */
declare module 'pdfjs-dist/build/pdf.worker.min.mjs' {
  export const WorkerMessageHandler: unknown;
}
