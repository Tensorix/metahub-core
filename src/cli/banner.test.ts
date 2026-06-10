import { test, expect } from "bun:test";
import {
  renderStartupBanner,
  humanizeExpiry,
  formatSync,
  visibleWidth,
  type BannerInfo,
} from "./banner.ts";

const base: BannerInfo = {
  version: "0.1.3",
  host: "127.0.0.1",
  port: 7777,
  endpoints: [{ scope: "loopback", url: "http://localhost:7777" }],
  docsUrl: "http://localhost:7777/docs",
  authMode: "managed",
  token: "z89tth0oflam5qip7izuvs4u",
  exp: Date.parse("2026-06-30T11:10:14.377Z"),
  node: "jqgouo11",
  autoSync: true,
  syncIntervalMs: 30_000,
  color: false,
};

test("renders the key fields", () => {
  const out = renderStartupBanner(base);
  expect(out).toContain("metahub");
  expect(out).toContain("v0.1.3");
  expect(out).toContain("listening");
  expect(out).toContain("127.0.0.1:7777");
  expect(out).toContain("WebUI");
  expect(out).toContain("http://localhost:7777");
  expect(out).toContain("Docs");
  expect(out).toContain("Token");
  expect(out).toContain("z89tth0oflam5qip7izuvs4u");
  expect(out).toContain("Ctrl-C to stop");
});

test("every line has identical visible width (box stays aligned)", () => {
  const out = renderStartupBanner(base);
  const widths = out.split("\n").map(visibleWidth);
  expect(new Set(widths).size).toBe(1);
});

test("alignment holds with colour codes embedded", () => {
  const out = renderStartupBanner({ ...base, color: true });
  // colour codes present...
  expect(out).toContain("\x1b[");
  // ...but visible widths still equal once ANSI is stripped
  const widths = out.split("\n").map(visibleWidth);
  expect(new Set(widths).size).toBe(1);
});

test("debug mode hides the token and shows disabled auth", () => {
  const out = renderStartupBanner({ ...base, authMode: "disabled", token: null, exp: null });
  expect(out).toContain("disabled");
  expect(out).toContain("--debug");
  expect(out).not.toContain("z89tth0oflam5qip7izuvs4u");
  const widths = out.split("\n").map(visibleWidth);
  expect(new Set(widths).size).toBe(1);
});

test("non-loopback host warns about network exposure", () => {
  const out = renderStartupBanner({ ...base, host: "0.0.0.0" });
  expect(out).toContain("reachable on your network");
  const widths = out.split("\n").map(visibleWidth);
  expect(new Set(widths).size).toBe(1);
});

test("multiple endpoints render scope labels; alignment holds", () => {
  const out = renderStartupBanner({
    ...base,
    host: "0.0.0.0",
    endpoints: [
      { scope: "loopback", url: "http://localhost:7777" },
      { scope: "lan", url: "http://192.168.1.42:7777" },
      { scope: "public", url: "http://203.0.113.5:7777" },
    ],
  });
  expect(out).toContain("Local");
  expect(out).toContain("LAN");
  expect(out).toContain("Public");
  expect(out).toContain("http://192.168.1.42:7777");
  expect(out).toContain("http://203.0.113.5:7777");
  expect(out).not.toContain("WebUI"); // multi-endpoint uses scope labels instead
  const widths = out.split("\n").map(visibleWidth);
  expect(new Set(widths).size).toBe(1);
});

test("static token never expires; alignment still holds", () => {
  const out = renderStartupBanner({ ...base, authMode: "static", exp: Infinity });
  expect(out).toContain("never expires");
  const widths = out.split("\n").map(visibleWidth);
  expect(new Set(widths).size).toBe(1);
});

test("humanizeExpiry formats relative + absolute", () => {
  const now = Date.parse("2026-06-04T00:00:00.000Z");
  expect(humanizeExpiry(Date.parse("2026-06-30T00:00:00.000Z"), now)).toBe(
    "expires in 26 days · Jun 30",
  );
  expect(humanizeExpiry(Infinity)).toBe("never expires");
  expect(humanizeExpiry(now - 1000, now)).toBe("expired");
  expect(humanizeExpiry(null)).toBe("");
});

test("formatSync humanizes intervals", () => {
  expect(formatSync(true, 30_000)).toBe("every 30s");
  expect(formatSync(true, 300_000)).toBe("every 5m");
  expect(formatSync(true, 3_600_000)).toBe("every 1h");
  expect(formatSync(false, 30_000)).toBe("auto-sync off");
});
