import { describe, expect, test } from "bun:test";
import type { Prop, Rec } from "./api.ts";
import { applyFilter, applySort, computeCalc, defaultViews, matchRule, normalizeViews, searchRecords, withinRange } from "./view-model.ts";

const prop = (id: string, type: Prop["type"], options?: string[]): Prop =>
  ({ id, database_id: "db", name: id, type, config: options ? { options } : null, position: 1 }) as unknown as Prop;
const rec = (id: string, cells: Record<string, unknown>): Rec => ({ id, database_id: "db", created_hlc: "", order_key: id, data: cells, cells, values: cells }) as unknown as Rec;

const P = { title: prop("title", "text"), n: prop("n", "number"), s: prop("s", "select", ["A", "B"]), m: prop("m", "multi_select", ["x", "y", "z"]), d: prop("d", "date"), c: prop("c", "checkbox"), r: prop("r", "relation") };
const props = Object.values(P);
const rows = [
  rec("1", { title: "Alpha one", n: 3, s: "A", m: ["x"], d: "2026-09-30", c: true, r: ["rec_a"] }),
  rec("2", { title: "beta", n: 10, s: "B", m: ["x", "y"], d: "2026-10-05", c: false, r: [] }),
  rec("3", { title: "", n: null, s: null, m: [], d: null, c: false, r: ["rec_b"] }),
];
const now = new Date(2026, 9, 1);

describe("normalizeViews", () => {
  test("defaults when missing or malformed", () => {
    expect(normalizeViews(undefined).map((v) => v.id)).toEqual(["v_table", "v_board", "v_calendar", "v_timeline"]);
    expect(normalizeViews([{ nope: 1 }, { id: "x", layout: "bogus" }]).length).toBe(4);
  });
  test("keeps valid views and repairs partial ones", () => {
    const out = normalizeViews([{ id: "v1", layout: "table", name: "", sort: [{ prop: "n", desc: "yes" }], filter: { op: "or", rules: [{ prop: "s", cond: "is", value: "A" }] }, hidden: ["n", 3] }]);
    expect(out).toEqual([{ id: "v1", name: "表格", layout: "table", sort: [{ prop: "n", desc: true }], filter: { op: "or", rules: [{ id: "f0", prop: "s", cond: "is", value: "A" }] }, hidden: ["n"] }]);
  });
  test("defaultViews are stable", () => {
    expect(defaultViews()[1]!.layout).toBe("board");
  });
});

describe("matchRule / applyFilter", () => {
  const f = (prop: string, cond: string, value?: unknown) => applyFilter(rows, props, { op: "and", rules: [{ id: "f", prop, cond, value }] }, now).map((r) => r.id);
  test("text", () => {
    expect(f("title", "contains", "ALPHA")).toEqual(["1"]);
    expect(f("title", "not_contains", "a")).toEqual(["3"]);
    expect(f("title", "is", "beta")).toEqual(["2"]);
    expect(f("title", "empty")).toEqual(["3"]);
    expect(f("title", "contains", "")).toEqual(["1", "2", "3"]);
  });
  test("number", () => {
    expect(f("n", "gt", 5)).toEqual(["2"]);
    expect(f("n", "le", "3")).toEqual(["1"]);
    expect(f("n", "ne", 3)).toEqual(["2", "3"]);
    expect(f("n", "not_empty")).toEqual(["1", "2"]);
  });
  test("select / multi_select / relation", () => {
    expect(f("s", "is", "A")).toEqual(["1"]);
    expect(f("s", "is_not", "A")).toEqual(["2", "3"]);
    expect(f("m", "has_any", ["y", "z"])).toEqual(["2"]);
    expect(f("m", "has_all", ["x", "y"])).toEqual(["2"]);
    expect(f("m", "has_none", ["x"])).toEqual(["3"]);
    expect(f("r", "has_any", ["rec_b"])).toEqual(["3"]);
    expect(f("r", "empty")).toEqual(["2"]);
  });
  test("date", () => {
    expect(f("d", "before", "2026-10-01")).toEqual(["1"]);
    expect(f("d", "on_or_after", "2026-10-05")).toEqual(["2"]);
    expect(f("d", "within", "next7")).toEqual(["2"]);
    expect(f("d", "within", "this_month")).toEqual(["2"]);
    expect(f("d", "is", "2026-09-30")).toEqual(["1"]);
  });
  test("checkbox", () => {
    expect(f("c", "is", true)).toEqual(["1"]);
    expect(f("c", "is", false)).toEqual(["2", "3"]);
  });
  test("or combines", () => {
    const ids = applyFilter(rows, props, { op: "or", rules: [{ id: "a", prop: "s", cond: "is", value: "A" }, { id: "b", prop: "n", cond: "gt", value: 5 }] }, now).map((r) => r.id);
    expect(ids).toEqual(["1", "2"]);
  });
  test("rule on a deleted property is ignored", () => {
    expect(f("gone", "is", "x")).toEqual(["1", "2", "3"]);
    expect(matchRule({ id: "x", prop: "n", cond: "gt" }, P.n, 1, now)).toBe(true);
  });
});

describe("applySort", () => {
  test("number asc puts empties first, desc last", () => {
    expect(applySort(rows, props, [{ prop: "n", desc: false }]).map((r) => r.id)).toEqual(["3", "1", "2"]);
    expect(applySort(rows, props, [{ prop: "n", desc: true }]).map((r) => r.id)).toEqual(["2", "1", "3"]);
  });
  test("multi-key sort", () => {
    const more = [...rows, rec("4", { title: "aaa", n: 3 })];
    expect(applySort(more, props, [{ prop: "n", desc: true }, { prop: "title", desc: false }]).map((r) => r.id)).toEqual(["2", "4", "1", "3"]);
  });
  test("checkbox and date", () => {
    expect(applySort(rows, props, [{ prop: "c", desc: true }]).map((r) => r.id)[0]).toBe("1");
    expect(applySort(rows, props, [{ prop: "d", desc: true }]).map((r) => r.id)).toEqual(["2", "1", "3"]);
  });
});

describe("searchRecords", () => {
  test("matches any visible column text, case-insensitive", () => {
    expect(searchRecords(rows, props, "BETA").map((r) => r.id)).toEqual(["2"]);
    expect(searchRecords(rows, props, "y").map((r) => r.id)).toEqual(["2"]);
    expect(searchRecords(rows, props, "  ").length).toBe(3);
  });
});

describe("withinRange", () => {
  test("week starts Monday", () => {
    const [s, e] = withinRange("this_week", new Date(2026, 9, 1));
    expect(s.getDate()).toBe(28);
    expect(e.getDate()).toBe(4);
  });
});

describe("computeCalc", () => {
  const ns = [3, 10, null, 7];
  test("numbers", () => {
    expect(computeCalc("count", P.n, ns)).toBe("4");
    expect(computeCalc("filled", P.n, ns)).toBe("3");
    expect(computeCalc("empty", P.n, ns)).toBe("1");
    expect(computeCalc("sum", P.n, ns)).toBe("20");
    expect(computeCalc("avg", P.n, ns)).toBe("6.67");
    expect(computeCalc("median", P.n, ns)).toBe("7");
    expect(computeCalc("min", P.n, ns)).toBe("3");
    expect(computeCalc("max", P.n, ns)).toBe("10");
    expect(computeCalc("unique", P.n, [1, 1, 2, null])).toBe("2");
  });
  test("checkbox percentages and date extremes", () => {
    expect(computeCalc("checked", P.c, [true, false, true, false])).toBe("50%");
    expect(computeCalc("max", P.d, ["2026-01-02", "2025-12-31", null])).toBe("2026-01-02");
  });
});
