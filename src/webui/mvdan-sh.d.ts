// Minimal typings for mvdan-sh (shfmt's GopherJS build) — just the surface
// fmt/fmt-sh.ts touches. The package ships no types.
declare module "mvdan-sh" {
  interface ShFile {
    [key: string]: unknown;
  }
  interface Parser {
    Parse(src: string, name: string): ShFile;
  }
  interface Printer {
    Print(file: ShFile): string;
  }
  interface Syntax {
    NewParser(...opts: unknown[]): Parser;
    NewPrinter(...opts: unknown[]): Printer;
    KeepComments(enabled: boolean): unknown;
    Indent(spaces: number): unknown;
  }
  const sh: { syntax: Syntax };
  export default sh;
}
