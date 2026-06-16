// `mh init --claude` embeds the repo-root SKILL.md as text (Bun's
// `with { type: "text" }` loader) and writes it back out as the installed
// Claude Code skill. tsc doesn't model that import attribute, so declare the
// module's shape here — the same trick src/types/dist-assets.d.ts uses for the
// embedded dist/ bundles.
declare module "*/SKILL.md" {
  const text: string;
  export default text;
}
