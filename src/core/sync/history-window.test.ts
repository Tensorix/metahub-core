import { test, expect } from "bun:test";
import { retainHistoryWindow } from "./retention-executor.ts";
import type { DocumentArchive } from "../history-archive.ts";
function archive(observedAt?: (number | null)[]): DocumentArchive {
  return { format: "metahub-document-history", version: 1, workspaceId: "w", documentId: "d",
    coveredFrom: null, coveredThrough: null, observedAt,
    changes: [1,2,3,4].map(n => ({ dataset: "documents", row_id: "d", col: "title", value: JSON.stringify(String(n)),
      hlc: `${n}`, node_id: "n", txn: null })) };
}
test("unknown bucket observations never authorize history expiration", () => {
  expect(retainHistoryWindow(archive(), 100).changes).toHaveLength(4);
  expect(retainHistoryWindow(archive([null,null,null,null]), 100).changes).toHaveLength(4);
});
test("old device clocks cannot expire recently observed history", () => {
  expect(retainHistoryWindow(archive([100,101,102,103]), 100).changes).toHaveLength(4);
});
test("history retains window-start register baseline and later transitions", () => {
  const kept = retainHistoryWindow(archive([1,2,100,101]), 100);
  expect(kept.changes.map(c => c.hlc)).toEqual(["2","3","4"]);
  expect(kept.observedAt).toEqual([2,100,101]);
});
