import { test, expect } from "bun:test";
import { doclinkFromUrl, parseHash, viewToHash } from "./view.ts";

test("doclinkFromUrl converts copied doc/db URLs from ANY origin", () => {
  expect(doclinkFromUrl("http://127.0.0.1:7777/#/doc/doc_notes-abc123")).toBe("[[doc_notes-abc123]]");
  expect(doclinkFromUrl("https://box.example.com/app#/db/db_tasks-7q1zzb")).toBe("[[db_tasks-7q1zzb]]");
  expect(doclinkFromUrl("  #/doc/doc_a1  ")).toBe("[[doc_a1]]"); // bare hash, padded
});

test("doclinkFromUrl rejects non-doclink text", () => {
  expect(doclinkFromUrl("https://example.com/")).toBeNull();
  expect(doclinkFromUrl("#/settings")).toBeNull();
  expect(doclinkFromUrl("#/doc/")).toBeNull();
  expect(doclinkFromUrl("#/doc/DOC_upper")).toBeNull(); // wrong alphabet
  expect(doclinkFromUrl("#/doc/db_tasks-7q1zzb")).toBeNull(); // segment/prefix mismatch
  expect(doclinkFromUrl("see http://x/#/doc/doc_a1 here")).toBeNull(); // not a lone URL
  expect(doclinkFromUrl("plain prose")).toBeNull();
});

test("doclinkFromUrl accepts what viewToHash emits", () => {
  for (const id of ["doc_meeting-notes-k3f9a2", "db_tasks-7q1zzb"]) {
    const kind = id.startsWith("db_") ? ("db" as const) : ("doc" as const);
    const url = "http://localhost:7777/" + viewToHash({ kind, id });
    expect(doclinkFromUrl(url)).toBe(`[[${id}]]`);
    expect(parseHash(viewToHash({ kind, id }))).toEqual({ kind, id });
  }
});
