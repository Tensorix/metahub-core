import { expect, test } from "bun:test";
import { DatabaseQueryWindow, type DatabaseDataSource } from "../shared/views/database-source";
import { api, type Prop, type Rec } from "./api";
import { databaseTableImage } from "./database-image";

const title: Prop = { id: "name", name: "Name", type: "text", database_id: "db", position: 0, config: { width: 195 } };
const state: Prop = { ...title, id: "done", name: "Done", type: "checkbox" };
const rows: Rec[] = Array.from({ length: 112 }, (_, i) => ({
  id: String(i), database_id: "db", cells: { name: `Item ${i}`, done: i % 2 === 0, refs: ["doc_1"], hidden: "Private" }, values: {},
}));

async function fixture() {
  const source: DatabaseDataSource = {
    openRecordQuery: async () => ({ id: "q", total: rows.length, revision: 1, calc: {}, partitions: {}, range: { min: null, max: null } }),
    readRecordQuery: async (_id, offset = 0, limit = 100) => ({
      records: rows.slice(offset, offset + limit), offset, limit, total: rows.length, hasMore: offset + limit < rows.length, calc: {},
    }),
    closeRecordQuery: async () => {},
    locateRecordQuery: async (_queryId, id) => rows.findIndex(row => row.id === id),
  };
  const query = new DatabaseQueryWindow(source, () => {}, e => { throw e; });
  await query.open("db", {});
  return { query, source };
}

test("a whole view includes headers and unmounted pages in the active query's order", async () => {
  const { query } = await fixture();
  const snapshot = await databaseTableImage(query, "q", [state, title], {});
  expect(snapshot.widths).toEqual([195, 195]);
  expect(snapshot.headerRow).toBe(true);
  expect(snapshot.rows).toHaveLength(113);
  expect(snapshot.rows[0]).toEqual(["Done", "Name"]);
  expect(snapshot.rows.at(-1)).toEqual([{ checked: false }, "Item 111"]);
});

test("copying a range uses its exact cells across page boundaries and resolves included reference titles", async () => {
  const { query } = await fixture();
  const ref: Prop = { ...title, id: "refs", type: "doc" };
  const original = api.referenceSummaries;
  api.referenceSummaries = async ({ ids, kind }) => {
    expect(kind).toBe("document");
    expect(ids).toEqual(["doc_1"]);
    return [{ id: "doc_1", title: "项目简介", missing: false }];
  };
  try {
    const snapshot = await databaseTableImage(query, "q", [title, ref, state], {}, { rect: { r0: 99, r1: 100, c0: 1, c1: 2 } });
    expect(snapshot.headerRow).toBe(false);
    expect(snapshot.rows).toEqual([
      [{ chips: ["项目简介"] }, { checked: false }],
      [{ chips: ["项目简介"] }, { checked: true }],
    ]);
  } finally { api.referenceSummaries = original; }
});

test("checked rows keep view order and skip checked records outside the current filter", async () => {
  const { query, source } = await fixture();
  await query.ensure(0, 1);
  const { readRecordQuery, locateRecordQuery } = api;
  api.readRecordQuery = source.readRecordQuery;
  api.locateRecordQuery = source.locateRecordQuery;
  try {
    const snapshot = await databaseTableImage(query, "q", [title], {}, { checked: new Set(["111", "absent", "0"]) });
    expect(snapshot.rows).toEqual([["Name"], ["Item 0"], ["Item 111"]]);
    await expect(databaseTableImage(query, "previous-query", [title], {})).rejects.toThrow();
  } finally { Object.assign(api, { readRecordQuery, locateRecordQuery }); }
});

test("a provisional index settles before a large export reads any record bodies", async () => {
  const { source } = await fixture();
  const index = await source.openRecordQuery("db", {});
  source.openRecordQuery = async () => ({ ...index, total: 1, totalExact: false, statistics: "loading" });
  source.recordQueryStatus = async () => ({ ...index, total: 50_000, totalExact: true, statistics: "complete" });
  let reads = 0;
  source.readRecordQuery = async () => { reads++; throw new Error("unexpected page read"); };
  const query = new DatabaseQueryWindow(source, () => {}, e => { throw e; });
  try {
    await query.open("db", {});
    await expect(databaseTableImage(query, "q", [title], {})).rejects.toThrow();
    expect(reads).toBe(0);
  } finally { await query.dispose(); }
});
