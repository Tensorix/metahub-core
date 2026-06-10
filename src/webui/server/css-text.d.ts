// Bun text-loader import (`with { type: "text" }`) for the stylesheet.
declare module "*.css" {
  const text: string;
  export default text;
}
