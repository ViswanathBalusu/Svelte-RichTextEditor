/**
 * Vite's `?raw` import of a style sheet: the module's default export is the file's text. The tests
 * read the shipped stylesheets this way (the rules are the real ones, not a copy).
 */
declare module '*.css?raw' {
  const text: string;
  export default text;
}
