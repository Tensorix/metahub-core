import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createRecentStore } from "./recent";
test("recent navigation is persistent, workspace isolated, deduplicated and bounded", () => {
  const db = new Database(":memory:");
  try {
    const a = createRecentStore(db, "a"),
      b = createRecentStore(db, "b");
    b.remember({ id: "private", kind: "document", title: "Other workspace" });
    for (let i = 0; i < 60; i++)
      a.remember({ id: String(i), kind: "document", title: "Title " + i });
    expect(a.read()).toHaveLength(50);
    expect(a.read()[0]?.id).toBe("59");
    expect(a.read().some((r) => r.id === "private")).toBe(false);
    a.remember({ id: "30", kind: "document", title: "New title" });
    expect(createRecentStore(db, "a").read()[0]?.title).toBe("New title");
    a.forget("document", "30");
    expect(a.read().some((r) => r.id === "30")).toBe(false);
    expect(b.read()).toHaveLength(1);
  } finally {
    db.close();
  }
});
test("recent subscriptions stay scoped and observer errors do not break saves", () => {
  const db = new Database(":memory:");
  try {
    const a = createRecentStore(db, "a"),
      b = createRecentStore(db, "b");
    let changes = 0;
    const off = a.subscribe(() => changes++);
    const fail = a.subscribe(() => {
      throw Error("observer");
    });
    b.remember({ id: "b", kind: "record", title: "B" });
    expect(changes).toBe(0);
    a.remember({ id: "a", kind: "record", title: "A" });
    expect(changes).toBe(1);
    off();
    fail();
    a.forget("record", "a");
    expect(changes).toBe(1);
  } finally {
    db.close();
  }
});
