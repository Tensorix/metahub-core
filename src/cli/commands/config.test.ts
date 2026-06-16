import { test, expect } from "bun:test";
import { peerChoices, grantChoices, validatePort, validateInterval } from "./config.ts";
import type { PeerRow } from "../../core/sync/peers.ts";
import type { GrantRow } from "../../core/sync/pairing.ts";

const peer = (over: Partial<PeerRow> = {}): PeerRow =>
  ({
    url: "http://host:7777",
    label: null,
    node_id: null,
    enabled: 1,
    last_sync_at: null,
    last_success_at: null,
    last_status: null,
    ...over,
  }) as PeerRow;

test("peerChoices maps url to value and shows enabled state in hint", () => {
  const opts = peerChoices([peer({ enabled: 1 }), peer({ url: "http://b:1", enabled: 0 })]);
  expect(opts).toEqual([
    { value: "http://host:7777", label: "http://host:7777", hint: "enabled" },
    { value: "http://b:1", label: "http://b:1", hint: "disabled" },
  ]);
});

test("peerChoices prefixes the label when a peer has one", () => {
  const [opt] = peerChoices([peer({ label: "laptop" })]);
  expect(opt).toEqual({ value: "http://host:7777", label: "laptop (http://host:7777)", hint: "enabled" });
});

test("grantChoices keeps the full token as value but masks the label", () => {
  const g: GrantRow = { token: "abcdefghijklmnop", peer_url: "http://peer:1", node_id: "n1", created_at: 1 };
  const [opt] = grantChoices([g]);
  expect(opt!.value).toBe("abcdefghijklmnop"); // full token revokes
  expect(opt!.label).toBe("abcdefgh…"); // masked for display
  expect(opt!.hint).toBe("http://peer:1");
});

test("grantChoices falls back to (unknown) when peer_url is null", () => {
  const g: GrantRow = { token: "tok", peer_url: null, node_id: null, created_at: null };
  expect(grantChoices([g])[0]!.hint).toBe("(unknown)");
});

test("validatePort accepts 1–65535 integers and rejects the rest", () => {
  expect(validatePort("7777")).toBeUndefined();
  expect(validatePort("1")).toBeUndefined();
  expect(validatePort("65535")).toBeUndefined();
  expect(validatePort("0")).toBeTruthy();
  expect(validatePort("70000")).toBeTruthy();
  expect(validatePort("abc")).toBeTruthy();
  expect(validatePort("80.5")).toBeTruthy();
});

test("validateInterval accepts parseable durations and rejects junk", () => {
  expect(validateInterval("30s")).toBeUndefined();
  expect(validateInterval("5m")).toBeUndefined();
  expect(validateInterval("")).toBeTruthy();
  expect(validateInterval("nonsense")).toBeTruthy();
});
