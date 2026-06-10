import { test, expect } from "bun:test";
import { databaseToCsv, safeFilename } from "./export.ts";

test("safeFilename normalizes unsafe names and appends extension", () => {
  expect(safeFilename('  ../bad:name* "doc"  ', ".md")).toBe("..-bad-name- -doc-.md");
  expect(safeFilename("Report.CSV", ".csv")).toBe("Report.CSV");
  expect(safeFilename("   ", ".md")).toBe("untitled.md");
});

test("databaseToCsv exports id plus property columns with CLI-compatible cell strings", () => {
  const props = [
    { id: "p1", name: "标题" },
    { id: "p2", name: "标签" },
    { id: "p3", name: "完成" },
    { id: "p4", name: "备注" },
    { id: "p5", name: "空值" },
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
