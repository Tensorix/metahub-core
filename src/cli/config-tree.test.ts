import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The tools-vs-configuration namespace contract: daily tools stay top-level,
// everything long-lived lives under `mh config <server|device|backup|edge>`,
// and the pre-namespace spellings (`config peer/grant/set`) keep working as
// hidden aliases so agent scripts never break.

const CLI = new URL("./index.ts", import.meta.url).pathname;
let home: string;

function mh(...args: string[]) {
  const r = Bun.spawnSync(["bun", CLI, ...args, "--json"], {
    env: { ...process.env, METAHUB_HOME: home },
  });
  const line = r.stdout.toString().trim();
  return { exit: r.exitCode, out: line ? JSON.parse(line) : null };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "mh-tree-"));
  expect(mh("init").exit).toBe(0);
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

test("config device list shows self; backup list empty; anchors defaults to list", () => {
  const dev = mh("config", "device", "list");
  expect(dev.exit).toBe(0);
  expect(dev.out.devices).toHaveLength(1);
  expect(dev.out.devices[0].self).toBe(true);

  const bak = mh("config", "backup", "list");
  expect(bak.exit).toBe(0);
  expect(bak.out).toEqual([]);

  const anchors = mh("config", "backup", "anchors");
  expect(anchors.exit).toBe(0);
  expect(anchors.out.devices).toHaveLength(1);
});

test("config server without flags shows config; with a flag applies it", () => {
  const show = mh("config", "server");
  expect(show.exit).toBe(0);
  expect(show.out.config.port).toBeDefined();

  const set = mh("config", "server", "--port", "7878");
  expect(set.exit).toBe(0);
  expect(set.out.port).toBe(7878);
});

test("hidden aliases keep working: peer list / set / grant list", () => {
  expect(mh("config", "peer", "list").exit).toBe(0);
  expect(mh("config", "set", "--port", "7879").out.port).toBe(7879);
  expect(mh("config", "grant", "list").exit).toBe(0);
});

test("unknown actions name the documented tree", () => {
  const edge = mh("config", "edge", "foo");
  expect(edge.exit).toBe(2);
  expect(edge.out.code).toBe("invalid_input");
  expect(edge.out.error).toContain("deploy|connect|rotate-keys");

  const section = mh("config", "nope");
  expect(section.exit).toBe(2);
  expect(section.out.error).toContain("server | device | backup | edge");
});

test("sync with no args and no peers fails loudly with the new guidance", () => {
  const r = mh("sync");
  expect(r.exit).toBe(2);
  expect(r.out.code).toBe("invalid_input");
  expect(r.out.error).toContain("mh config backup connect");
});

test("backup anchors redundancy validates its value", () => {
  const bad = mh("config", "backup", "anchors", "redundancy", "sometimes");
  expect(bad.exit).toBe(2);
  const ok = mh("config", "backup", "anchors", "redundancy", "any");
  expect(ok.exit).toBe(0);
  expect(ok.out.redundancy).toBe("any");
});
