import { test, expect } from "bun:test";
import { databaseToCsv, safeFilename } from "./export.ts";

test("safeFilename normalizes unsafe names and appends extension", () => {
  expect(safeFilename('  ../bad:name* "doc"  ', ".md")).toBe("..-bad-name- -doc-.md");
  expect(safeFilename("Report.CSV", ".csv")).toBe("Report.CSV");
  expect(safeFilename("   ", ".md")).toBe("untitled.md");
});

test("databaseToCsv exports id plus property columns with CLI-compatible cell strings", () => {
  const props = [
    { name: "标题" },
    { name: "标签" },
    { name: "完成" },
    { name: "备注" },
    { name: "空值" },
  ];
  const records = [
    {
      id: "rec_1",
      database_id: "db_1",
      values: {
        "标题": "A,B",
        "标签": ["x", "y"],
        "完成": true,
        "备注": 'He said "hi"\nNext',
        "空值": null,
      },
    },
  ];

  expect(databaseToCsv(props, records)).toBe(
    'id,标题,标签,完成,备注,空值\nrec_1,"A,B","[""x"",""y""]",true,"He said ""hi""\nNext",',
  );
});
