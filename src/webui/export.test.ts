import { test, expect } from "bun:test";
import { databaseToCsv, safeFilename } from "./export.ts";
import type { Prop } from "./api.ts";

const prop = (id: string, name: string, type: Prop["type"], config: Prop["config"] = null): Prop =>
  ({ id, database_id: "db_1", name, type, config, position: 1 }) as Prop;

test("safeFilename normalizes unsafe names and appends extension", () => {
  expect(safeFilename('  ../bad:name* "doc"  ', ".md")).toBe("..-bad-name- -doc-.md");
  expect(safeFilename("Report.CSV", ".csv")).toBe("Report.CSV");
  expect(safeFilename("   ", ".md")).toBe("untitled.md");
});

test("databaseToCsv exports id plus property columns with CLI-compatible cell strings", () => {
  const props = [
    prop("p1", "标题", "text"),
    prop("p2", "标签", "multi_select", { options: ["x", "y"] }),
    prop("p3", "完成", "checkbox"),
    prop("p4", "备注", "text"),
    prop("p5", "空值", "text"),
  ];
  const cells = {
    p1: "A,B",
    p2: ["x", "y"],
    p3: true,
    p4: 'He said "hi"\nNext',
    p5: null,
  };
  const records = [
    {
      id: "rec_1",
      database_id: "db_1",
      values: {},
      cells,
    },
  ];

  expect(databaseToCsv(props, records)).toBe(
    'id,标题,标签,完成,备注,空值\nrec_1,"A,B","[""x"",""y""]",true,"He said ""hi""\nNext",',
  );
});

test("databaseToCsv renders relation cells as titles with id fallback", () => {
  const props = [
    prop("p1", "任务", "text"),
    prop("p2", "所属项目", "relation", { database: "db_target" }),
  ];
  const records = [
    { id: "rec_1", database_id: "db_1", values: {}, cells: { p1: "a", p2: ["rec_x", "rec_ghost"] } },
    { id: "rec_2", database_id: "db_1", values: {}, cells: { p1: "b", p2: [] } },
  ];
  const relTitles = new Map([["p2", new Map([["rec_x", "网站改版"]])]]);
  expect(databaseToCsv(props, records, relTitles)).toBe(
    'id,任务,所属项目\nrec_1,a,"网站改版, rec_ghost"\nrec_2,b,',
  );
});

test("databaseToCsv renders doc cells as titles with id fallback", () => {
  const props = [
    prop("p1", "任务", "text"),
    prop("p2", "参考文档", "doc"),
  ];
  const records = [
    { id: "rec_1", database_id: "db_1", values: {}, cells: { p1: "a", p2: ["doc_x", "doc_ghost"] } },
    { id: "rec_2", database_id: "db_1", values: {}, cells: { p1: "b", p2: [] } },
  ];
  const relTitles = new Map([["p2", new Map([["doc_x", "设计说明"]])]]);
  expect(databaseToCsv(props, records, relTitles)).toBe(
    'id,任务,参考文档\nrec_1,a,"设计说明, doc_ghost"\nrec_2,b,',
  );
});
