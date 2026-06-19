import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `mh blob add/get` is the CLI agent's media in/out: ingest a local file → embed
// its /blob/<hash> URL in a doc; pull bytes back by hash. Round-trip must be
// byte-exact and emit an embeddable Markdown line.

const CLI = new URL("./index.ts", import.meta.url).pathname;
let home: string;

function mh(...args: string[]) {
  const r = Bun.spawnSync(["bun", CLI, ...args, "--json"], { env: { ...process.env, METAHUB_HOME: home } });
  const line = r.stdout.toString().trim();
  return { exit: r.exitCode, out: line ? JSON.parse(line) : null, err: r.stderr.toString() };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "mh-blob-"));
  expect(mh("init").exit).toBe(0);
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("blob add prints hash/url/kind + embeddable markdown", () => {
  const png = join(home, "pic.png");
  writeFileSync(png, Buffer.from("\x89PNG\r\n\x1a\nfake-image-bytes"));
  const r = mh("blob", "add", png);
  expect(r.exit).toBe(0);
  expect(r.out.hash).toMatch(/^[0-9a-f]{32}$/);
  expect(r.out.kind).toBe("image");
  expect(r.out.content_type).toContain("image/png");
  expect(r.out.url).toBe(`/blob/${r.out.hash}.png`);
  expect(r.out.markdown).toBe(`![pic.png](${r.out.url})`);
});

test("a generic file embeds as a /blob link with its byte size", () => {
  const zip = join(home, "bundle.zip");
  writeFileSync(zip, Buffer.from("PK\x03\x04zip-bytes-here"));
  const r = mh("blob", "add", zip);
  expect(r.out.kind).toBe("file");
  expect(r.out.markdown).toBe(`[bundle.zip](${r.out.url} "${r.out.size}")`);
});

test("blob get round-trips the exact bytes", () => {
  const src = join(home, "data.bin");
  const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 0, 9]);
  writeFileSync(src, bytes);
  const added = mh("blob", "add", src);
  expect(added.exit).toBe(0);
  const out = join(home, "out.bin");
  const got = mh("blob", "get", added.out.hash, "--out", out);
  expect(got.exit).toBe(0);
  expect(readFileSync(out).equals(bytes)).toBe(true);
});

test("blob get on an unknown hash → not_found (exit 3)", () => {
  const r = mh("blob", "get", "0".repeat(32));
  expect(r.exit).toBe(3);
  expect(r.out.code).toBe("not_found");
});
