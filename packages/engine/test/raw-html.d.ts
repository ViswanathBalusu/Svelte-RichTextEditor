/** Samples stored as HTML files and read as text (`?raw`), for tests run through Vite. */
declare module '*.html?raw' {
  const text: string;
  export default text;
}
