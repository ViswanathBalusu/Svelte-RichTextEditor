/**
 * A stylesheet imported as text (`?inline`), which the build (Vite) turns into a string: no request,
 * so no `style-src` entry (ADR 0039).
 */
declare module '*.css?inline' {
  const css: string;
  export default css;
}
