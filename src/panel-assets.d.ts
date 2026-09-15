// src-web/app.js is imported `with { type: "text" }` and embedded into the
// compiled binary as a plain string; declare it so tsc accepts the import.
// (index.html keeps bun-types' HTMLBundle typing and is cast at the use site —
// the `with { type: "text" }` attribute is what Bun actually honors.)
declare module "*.js" {
  const content: string;
  export default content;
}
