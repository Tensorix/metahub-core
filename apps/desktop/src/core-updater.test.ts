import { test, expect } from "bun:test";
import { compareSemver, sidecarAssetName, parseSha256Sums } from "./version-util";

test("compareSemver orders major.minor.patch", () => {
  expect(compareSemver("0.1.4", "0.1.3")).toBe(1);
  expect(compareSemver("0.1.3", "0.1.4")).toBe(-1);
  expect(compareSemver("0.1.3", "0.1.3")).toBe(0);
  expect(compareSemver("1.0.0", "0.9.9")).toBe(1);
  expect(compareSemver("0.2.0", "0.1.9")).toBe(1);
});

test("compareSemver tolerates v prefix, prerelease suffix, short versions", () => {
  expect(compareSemver("v0.1.4", "0.1.3")).toBe(1);
  expect(compareSemver("0.1.4-rc1", "0.1.4")).toBe(0); // suffix ignored
  expect(compareSemver("0.2", "0.1.9")).toBe(1);
  expect(compareSemver("1", "1.0.0")).toBe(0);
});

test("sidecarAssetName matches the build-sidecars.ts output for this platform", () => {
  // The test host is the dev machine; just assert it maps to a known name.
  const name = sidecarAssetName();
  expect([
    "metahub-sidecar-mac-arm64",
    "metahub-sidecar-mac-x64",
    "metahub-sidecar-win-x64.exe",
    "metahub-sidecar-win-arm64.exe",
    "metahub-sidecar-linux-x64",
    "metahub-sidecar-linux-arm64",
  ]).toContain(name);
});

test("parseSha256Sums parses sha256sum output (incl. binary '*' marker)", () => {
  const txt =
    "aa".repeat(32) + "  metahub-sidecar-mac-arm64\n" +
    "bb".repeat(32) + " *metahub-sidecar-linux-x64\n" +
    "garbage line\n";
  const map = parseSha256Sums(txt);
  expect(map.get("metahub-sidecar-mac-arm64")).toBe("aa".repeat(32));
  expect(map.get("metahub-sidecar-linux-x64")).toBe("bb".repeat(32));
  expect(map.size).toBe(2);
});
