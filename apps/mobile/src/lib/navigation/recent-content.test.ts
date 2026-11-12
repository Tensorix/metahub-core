import { expect, test } from "bun:test";
import { recentContent } from "./recent-content";
import type { RecentItem } from "./recent";

test("mixed recents retain visit order and resolve equal IDs by kind", () => {
  const items: RecentItem[] = [
    { id: "same", kind: "database", title: "Old table", openedAt: 3 },
    { id: "same", kind: "document", title: "Old doc", openedAt: 2 },
    { id: "site", kind: "site", title: "Site", openedAt: 1 },
  ];
  expect(
    recentContent(
      items,
      [{ id: "same", title: "Renamed doc" }],
      [{ id: "same", name: "Renamed table" }],
    ),
  ).toEqual([
    { id: "same", kind: "database", title: "Renamed table" },
    { id: "same", kind: "document", title: "Renamed doc" },
  ]);
});

test("deleted content is omitted before applying the shared twelve-item limit", () => {
  const items: RecentItem[] = Array.from({ length: 16 }, (_, n) => ({
    id: String(n),
    kind: n % 2 ? "document" : "database",
    title: "Old",
    openedAt: 16 - n,
  }));
  const documents = items
    .filter((i) => i.kind === "document")
    .map((i) => ({ id: i.id, title: i.id, missing: i.id === "1" }));
  const databases = items
    .filter((i) => i.kind === "database" && i.id !== "0")
    .map((i) => ({ id: i.id, name: i.id }));
  const result = recentContent(items, documents, databases);
  expect(result).toHaveLength(12);
  expect(result.map((i) => i.id)).toEqual(
    Array.from({ length: 12 }, (_, n) => String(n + 2)),
  );
  expect(recentContent(items, [], [])).toEqual([]);
});
