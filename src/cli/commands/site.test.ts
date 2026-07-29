import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import STARTER_HTML from "../site-starter.html.txt" with { type: "text" };
import { scaffoldSiteDir } from "./site.ts";
import { createClient } from "../../sdk/client.ts";
import { errorCode } from "../../core/errors.ts";

const CLI = new URL("../index.ts", import.meta.url).pathname;

// ---- template ↔ SDK drift guard ----------------------------------------------

test("starter template only calls methods the SDK actually exports", () => {
  // Every `api.<name>(` in the template (live code AND commented examples) must
  // be a real createClient() method — the template is embedded at build time,
  // so an SDK rename without a template update would ship a broken example.
  const used = [...STARTER_HTML.matchAll(/\bapi\.([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]!);
  expect(used.length).toBeGreaterThan(0); // the example must exercise the SDK at all
  const real = new Set(Object.keys(createClient()));
  for (const name of used) expect(real).toContain(name);
});

test("starter template imports the SDK and points at the docs", () => {
  expect(STARTER_HTML).toContain('import { api, MetahubError } from "/metahub-sdk.js"');
  expect(STARTER_HTML).toContain("/docs.json");
  // error handling dispatches on the machine-readable code, not message text
  expect(STARTER_HTML).toContain("e.code");
});

// ---- scaffold three states ----------------------------------------------------

test("scaffold: creates dir + index.html and reports the publish next-step", async () => {
  const base = mkdtempSync(join(tmpdir(), "mh-scaffold-"));
  try {
    const dir = join(base, "app"); // does not exist yet — mkdir -p behavior
    const res = await scaffoldSiteDir(dir);
    expect(res).toEqual({
      dir,
      created: ["index.html"],
      next: `mh site upload <name> ${dir} --create`,
    });
    expect(await Bun.file(join(dir, "index.html")).text()).toBe(STARTER_HTML);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("scaffold: existing index.html without --force is a conflict", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mh-scaffold-"));
  try {
    await Bun.write(join(dir, "index.html"), "<h1>mine</h1>");
    let err: unknown;
    await scaffoldSiteDir(dir).catch((e) => (err = e));
    expect(errorCode(err)).toBe("conflict");
    // the existing page is untouched
    expect(await Bun.file(join(dir, "index.html")).text()).toBe("<h1>mine</h1>");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scaffold: --force overwrites an existing index.html", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mh-scaffold-"));
  try {
    await Bun.write(join(dir, "index.html"), "<h1>old</h1>");
    const res = await scaffoldSiteDir(dir, { force: true });
    expect(res.created).toEqual(["index.html"]);
    expect(await Bun.file(join(dir, "index.html")).text()).toBe(STARTER_HTML);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy site publish remains a warned alias for upload", () => {
  const home = mkdtempSync(join(tmpdir(), "mh-site-alias-"));
  try {
    const result = Bun.spawnSync(
      ["bun", CLI, "site", "publish", "--help"],
      { env: { ...process.env, METAHUB_HOME: home } },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toContain(
      "`mh site publish` is deprecated",
    );
    expect(result.stdout.toString()).toContain("Upload every file");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
