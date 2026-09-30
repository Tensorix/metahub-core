import { test, expect } from "bun:test";
import { listRecents, recordRecent } from "./recents.ts";

function mem() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

test("recordRecent: newest first, deduped, capped at 8, docs and dbs only", () => {
  const s = mem();
  recordRecent({ kind: "doc", id: "doc_a" }, s);
  recordRecent({ kind: "db", id: "db_b" }, s);
  recordRecent({ kind: "db", id: "db_b", rec: "rec_x" }, s);
  recordRecent({ kind: "settings" }, s);
  recordRecent({ kind: "doc", id: "doc_a" }, s);
  expect(listRecents(s)).toEqual([
    { kind: "doc", id: "doc_a" },
    { kind: "db", id: "db_b" },
  ]);
  for (let i = 0; i < 10; i++) recordRecent({ kind: "doc", id: `doc_${i}` }, s);
  const got = listRecents(s);
  expect(got.length).toBe(8);
  expect(got[0]).toEqual({ kind: "doc", id: "doc_9" });
});

test("listRecents tolerates bad or missing storage", () => {
  const s = mem();
  s.setItem("mh.recent", "{not json");
  expect(listRecents(s)).toEqual([]);
  s.setItem("mh.recent", JSON.stringify([{ kind: "nope", id: 1 }, { kind: "doc", id: "doc_ok" }]));
  expect(listRecents(s)).toEqual([{ kind: "doc", id: "doc_ok" }]);
  expect(listRecents(null)).toEqual([]);
});
