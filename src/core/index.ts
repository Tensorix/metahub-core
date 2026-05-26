export interface GreetOptions {
  name?: string;
}

export function greet(opts: GreetOptions = {}): string {
  return `Hello, ${opts.name ?? "world"}!`;
}
