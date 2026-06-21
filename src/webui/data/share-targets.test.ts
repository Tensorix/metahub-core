import { test, expect } from "bun:test";
import { buildShareTargets, shareTargetUrl } from "./share-targets.ts";

const ORIGIN = "https://hub.example";

test("seeds the current server as the default (index 0)", () => {
  const t = buildShareTargets([], [], ORIGIN);
  expect(t).toHaveLength(1);
  expect(t[0]!.id).toBe("server");
  expect(t[0]!.isDefault).toBe(true);
  expect(t[0]!.label).toBe("当前服务器");
  expect(shareTargetUrl(t[0]!, ORIGIN)).toBe(ORIGIN);
});

test("peer-server url survives the round-trip (the bug the verifier caught)", () => {
  const t = buildShareTargets([{ url: "https://peer.example", label: "家里的服务器" }], [], ORIGIN);
  const peer = t.find((s) => s.id === "server:https://peer.example")!;
  expect(peer.kind).toBe("server");
  // must NOT collapse to the origin — that was the broken behavior
  expect(shareTargetUrl(peer, ORIGIN)).toBe("https://peer.example");
});

test("bucket url comes from routeOp; name in subtitle, generic label", () => {
  const t = buildShareTargets([], [{ url: "https://s3.example/bkt", label: "我的桶" }], ORIGIN);
  const b = t.find((s) => s.kind === "bucket")!;
  expect(b.id).toBe("bucket:https://s3.example/bkt");
  expect(shareTargetUrl(b, ORIGIN)).toBe("https://s3.example/bkt");
  expect(b.label).toBe("对象存储");
  expect(b.subtitle).toBe("我的桶");
});

test("order is current server, then peers, then buckets", () => {
  const t = buildShareTargets(
    [{ url: "https://p1", label: "P1" }],
    [{ url: "https://b1", label: "B1" }],
    ORIGIN,
  );
  expect(t.map((s) => s.kind)).toEqual(["server", "server", "bucket"]);
  expect(t[0]!.id).toBe("server");
});

test("option display text reproduces the legacy strings", () => {
  const t = buildShareTargets(
    [{ url: "https://peer.example", label: "Peer" }],
    [{ url: "https://b", label: "Bkt" }],
    ORIGIN,
  );
  // <option> renders `${label} — ${subtitle}` (+ optional site note)
  expect(`${t[0]!.label} — ${t[0]!.subtitle}`).toBe(`当前服务器 — ${ORIGIN}`);
  expect(`${t[1]!.label} — ${t[1]!.subtitle}`).toBe("Peer — https://peer.example");
  expect(`${t[2]!.label} — ${t[2]!.subtitle}`).toBe("对象存储 — Bkt");
});
