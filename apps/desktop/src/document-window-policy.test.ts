import { expect, test } from "bun:test";
import { validDocumentId, visibleDocumentBounds } from "./document-window-policy";

test("window requests accept document IDs, never routes, URLs or file paths", () => {
  expect(validDocumentId("doc_window-a1b2")).toBe(true);
  for (const value of [null, {}, "", "db_test", "doc_../secret", "doc_x?url=evil", "https://evil", "doc_x\n"]) expect(validDocumentId(value)).toBe(false);
});

test("offscreen and corrupt window positions fit the current monitor", () => {
  const area = { x: 0, y: 25, width: 1280, height: 775 };
  const bounds = visibleDocumentBounds({ x: 2200, y: -100, width: 3000, height: 2000 }, [area]);
  expect(bounds).toEqual(area);
  const fallback = visibleDocumentBounds({ x: NaN }, [area]);
  expect(fallback.width).toBe(960);
  expect(fallback.y).toBeGreaterThanOrEqual(25);
});

test("a document keeps a position on a connected secondary monitor", () => {
  const saved = { x: -1200, y: 40, width: 800, height: 600 };
  expect(visibleDocumentBounds(saved, [
    { x: 0, y: 25, width: 1440, height: 875 },
    { x: -1440, y: 0, width: 1440, height: 900 },
  ])).toEqual(saved);
});
