import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { LibraryTree, readLibrary } from "./library";
test("10k library browses siblings independently, handles orphans and rebuilds moved rows", () => {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,title TEXT,parent_id TEXT,order_key TEXT,__deleted INTEGER); CREATE INDEX sib ON documents(parent_id,order_key,id); CREATE TABLE databases(id TEXT,name TEXT,created_hlc TEXT,__deleted INTEGER)",
  );
  const insert = db.query("INSERT INTO documents VALUES(?,?,?,?,0)");
  db.transaction(() => {
    for (let i = 0; i < 10000; i++)
      insert.run(
        "d" + String(i).padStart(5, "0"),
        "Title" + i,
        i >= 100 && i < 500
          ? "d00000"
          : i === 500
            ? "d00100"
            : i === 501
              ? "missing"
              : null,
        i % 4 === 0 ? null : "a",
      );
  })();
  let queries = 0;
  const tree = new LibraryTree(
    {
      query: (sql) => {
        queries++;
        return db.query(sql);
      },
      exec: (sql) => db.exec(sql),
      transaction: (fn) => db.transaction(fn),
    },
    "documents",
    "",
  );
  expect(queries).toBe(1);
  expect(tree.rows().filter((r) => !r.more)).toHaveLength(60);
  let cursor = readLibrary(db, "documents", "", null);
  let ids = cursor.rows.map((r) => r.id);
  while (cursor.more) {
    cursor = readLibrary(db, "documents", "", null, cursor.rows.at(-1));
    ids.push(...cursor.rows.map((r) => r.id));
  }
  expect(ids.length).toBe(9599);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toContain("d00501");
  while (tree.rows().some((r) => r.more && r.branch === null)) tree.load(null);
  tree.toggle("d00000");
  while (tree.rows().some((r) => r.more && r.branch === "d00000"))
    tree.load("d00000");
  tree.toggle("d00100");
  expect(tree.rows().find((r) => r.key === "d00500")?.depth).toBe(2);
  expect(
    readLibrary(db, "documents", "Title500", null).rows.find(
      (r) => r.id === "d00500",
    )?.path,
  ).toBe("Title0 › Title100");
  db.query("UPDATE documents SET parent_id=NULL WHERE id='d00500'").run();
  tree.refresh();
  expect(
    tree
      .rows()
      .filter((r) => r.key === "d00500")
      .map((r) => r.depth),
  ).toEqual([0]);
  tree.toggle("d00000");
  expect(tree.rows().some((r) => r.branch === "d00000")).toBe(false);
  db.close();
});

test("a removed anchor uses the nearest surviving document in visual order", async () => {
  const { replacementAnchor } = await import("./library");
  const rows = ["a", "b", "c"].map((key) => ({
    key,
    title: key,
    depth: 0,
    branch: null,
  }));
  expect(replacementAnchor("b", rows, [rows[0]!, rows[2]!])).toBe("c");
  expect(replacementAnchor("c", rows, [rows[0]!])).toBe("a");
  expect(replacementAnchor("a", rows, rows)).toBeNull();
});

test("database continuation uses stable IDs, queries only the chosen segment and handles literal search", () => {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE databases(id TEXT PRIMARY KEY,name TEXT,created_hlc TEXT,__deleted INTEGER); WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<84) INSERT INTO databases SELECT printf('db_%03d',i),'100%'||i,NULL,0 FROM n",
  );
  const first = readLibrary(db, "databases", "%", null);
  expect(first.rows.length).toBe(60);
  const next = readLibrary(db, "databases", "%", null, first.rows.at(-1));
  expect(next.rows.length).toBe(25);
  expect(next.more).toBe(false);
  expect(new Set([...first.rows, ...next.rows].map((r) => r.id)).size).toBe(85);
  db.close();
});

test("failed refresh preserves readable rows and promotes children of a deleted parent", () => {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,title TEXT,parent_id TEXT,order_key TEXT,__deleted INTEGER); INSERT INTO documents VALUES ('a','parent',NULL,NULL,0),('b','child','a',NULL,0)",
  );
  const tree = new LibraryTree(db, "documents", "");
  tree.toggle("a");
  db.exec("ALTER TABLE documents RENAME TO unavailable");
  tree.refresh();
  expect(
    tree
      .rows()
      .filter((r) => !r.more)
      .map((r) => r.key),
  ).toEqual(["a", "b"]);
  expect(tree.rows().some((r) => r.error)).toBe(true);
  db.exec(
    "ALTER TABLE unavailable RENAME TO documents;UPDATE documents SET __deleted=1 WHERE id='a'",
  );
  tree.refresh();
  expect(tree.rows().map((r) => [r.key, r.depth])).toEqual([["b", 0]]);
  db.close();
});
