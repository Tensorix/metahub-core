import { test, expect } from "bun:test";
import { DAY_MS, initialRetentionState, reduceRetention } from "./retention-state.ts";
const h = "a".repeat(64);
test("members must seal their exact source prefix before collection", () => {
  let s = reduceRetention(initialRetentionState(), { type: "join", epoch: 0, member: "a", checkpoint: null }, 1);
  s = reduceRetention(s, { type: "batch", epoch: 0, member: "a", first: 1, last: 3, objectHash: h }, 2);
  s = reduceRetention(s, { type: "prepare", epoch: 0, id: "gc" }, 3);
  expect(() => reduceRetention(s, { type: "commit", epoch: 0, id: "gc", checkpoint: h }, 4)).toThrow("unsealed");
  expect(() => reduceRetention(s, { type: "seal", epoch: 0, id: "gc", member: "a", sequence: 2 }, 4)).toThrow("prefix");
  s = reduceRetention(s, { type: "seal", epoch: 0, id: "gc", member: "a", sequence: 3 }, 4);
  expect(() => reduceRetention(s, { type: "batch", epoch: 0, member: "a", first: 4, last: 4, objectHash: h }, 5)).toThrow("sealed");
  s = reduceRetention(s, { type: "commit", epoch: 0, id: "gc", checkpoint: h }, 5);
  expect(s.epoch).toBe(1);
  expect(s.protectedUntil).toBe(5 + 7 * DAY_MS);
  expect(() => reduceRetention(s, { type: "batch", epoch: 0, member: "a", first: 4, last: 4, objectHash: h }, 6)).toThrow("epoch");
});
test("expired members cannot renew or upload and do not block prepare", () => {
  let s = reduceRetention(initialRetentionState(), { type: "join", epoch: 0, member: "old", checkpoint: null }, 0);
  const at = 30 * DAY_MS;
  expect(() => reduceRetention(s, { type: "renew", epoch: 0, member: "old", sequence: 0, checkpoint: null }, at)).toThrow("expired");
  expect(() => reduceRetention(s, { type: "batch", epoch: 0, member: "old", first: 1, last: 1, objectHash: h }, at)).toThrow("expired");
  s = reduceRetention(s, { type: "prepare", epoch: 0, id: "gc" }, at);
  expect(s.preparing!.members).toEqual([]);
});
test("timed-out prepare cancels durably without mutating previous state", () => {
  const original = reduceRetention(initialRetentionState(), { type: "prepare", epoch: 0, id: "gc" }, 0);
  expect(() => reduceRetention(original, { type: "commit", epoch: 0, id: "gc", checkpoint: h }, 60_000)).toThrow("timed out");
  const cancelled = reduceRetention(original, { type: "cancel", epoch: 0, id: "gc" }, 60_000);
  expect(cancelled.preparing).toBeNull(); expect(original.preparing).not.toBeNull();
});
test("gaps and prototype member names are rejected", () => {
  expect(() => reduceRetention(initialRetentionState(), { type: "join", epoch: 0, member: "__proto__", checkpoint: null }, 0)).toThrow();
  const s = reduceRetention(initialRetentionState(), { type: "join", epoch: 0, member: "a", checkpoint: null }, 0);
  expect(() => reduceRetention(s, { type: "batch", epoch: 0, member: "a", first: 2, last: 2, objectHash: h }, 1)).toThrow("noncontiguous");
});

test("replacement incarnation retires only the exact proven old prefix", () => {
  let state = reduceRetention(initialRetentionState(), { type: "join", epoch: 0, member: "old", checkpoint: null }, 1);
  state = reduceRetention(state, { type: "batch", epoch: 0, member: "old", first: 1, last: 2, objectHash: h }, 2);
  expect(() => reduceRetention(state, { type: "join", epoch: 0, member: "new", checkpoint: null, replaces: { member: "old", sequence: 1 } }, 3)).toThrow();
  state = reduceRetention(state, { type: "join", epoch: 0, member: "new", checkpoint: null, replaces: { member: "old", sequence: 2 } }, 3);
  expect(state.members.old).toBeUndefined();
  state = reduceRetention(state, { type: "prepare", epoch: 0, id: "gc" }, 4);
  expect(state.preparing!.members).toEqual(["new"]);
  expect(() => reduceRetention(state, { type: "join", epoch: 0, member: "late", checkpoint: null }, 5)).toThrow();
});
