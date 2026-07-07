// `mh init --claude` / `mh init --codex` embed the repo-root SKILL.md as text
// (Bun's `with { type: "text" }` loader) and write it back out as the installed
// agent skill. tsc doesn't model that import attribute, so declare the module's
// shape here — the same trick src/types/dist-assets.d.ts uses for the embedded
// dist/ bundles.
declare module "*/SKILL.md" {
  const text: string;
  export default text;
}
