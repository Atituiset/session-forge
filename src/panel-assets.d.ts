// Panel JS assets are imported `with { type: "text" }` and embedded into the
// compiled binary as plain strings; declare them so tsc accepts the imports.
// (index.html keeps bun-types' HTMLBundle typing and is cast at the use site —
// the `with { type: "text" }` attribute is what Bun actually honors.)
declare module "*.js" {
  const content: string;
  export default content;
}
declare module "*.css" {
  const content: string;
  export default content;
}
