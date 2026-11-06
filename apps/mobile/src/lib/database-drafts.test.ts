import { expect, test } from "bun:test";
import { recordWriter, prepareCell, withRecordDrafts } from "./database-drafts";
import type { ReplicaService } from "../../../../src/core/replica/service";
import type { PropInfo, RecordInfo } from "./api/sdk";
function fixture() {
  const checkpoints: Record<
    string,
    Record<string, { value: unknown; status: string; error?: string }>
  > = {};
  const writes: Record<string, unknown>[] = [];
  const service = {
    client: {
      updateRecord: async (_: string, cells: Record<string, unknown>) => {
        writes.push(cells);
      },
    },
    drafts: {
      readFields: (id: string) => checkpoints[id] ?? {},
      checkpointField: (
        id: string,
        pid: string,
        draft: { value: unknown; status: string; error?: string },
      ) => {
        (checkpoints[id] ??= {})[pid] = draft;
      },
      acknowledgeField: (id: string, pid: string) => {
        delete checkpoints[id]?.[pid];
      },
    },
  } as unknown as ReplicaService;
  return { service, checkpoints, writes };
}
test("grid and detail share a writer; workspace writers stay isolated", async () => {
  const a = fixture(),
    b = fixture();
  expect(recordWriter(a.service, "r")).toBe(recordWriter(a.service, "r"));
  expect(recordWriter(a.service, "r")).not.toBe(recordWriter(b.service, "r"));
  const writer = recordWriter(a.service, "r").drafts;
  writer.stage("p", "offline input");
  expect(a.checkpoints.r?.p?.value).toBe("offline input");
  const record = {
    id: "r",
    database_id: "d",
    cells: { p: "old" },
    values: {},
  } as RecordInfo;
  expect(withRecordDrafts(a.service, record).cells.p).toBe("offline input");
  expect((await writer.flush()).ok).toBe(true);
  expect(a.writes).toEqual([{ p: "offline input" }]);
  expect(a.checkpoints.r?.p).toBeUndefined();
});
test("restores pending drafts and preserves invalid numeric text and deleted fields", async () => {
  const f = fixture();
  f.checkpoints.r = { n: { value: "12oops", status: "pending" } };
  const writer = recordWriter(f.service, "r").drafts;
  expect(writer.fields.get("n")?.status).toBe("draft");
  const prop = {
    id: "n",
    database_id: "d",
    name: "Number",
    type: "number",
    config: null,
    position: 0,
  } as PropInfo;
  expect((await writer.flush((id, v) => prepareCell([prop], id, v))).ok).toBe(
    false,
  );
  expect(f.writes).toEqual([]);
  expect(f.checkpoints.r.n?.value).toBe("12oops");
  writer.stage("n", "12");
  expect((await writer.flush((id, v) => prepareCell([], id, v))).ok).toBe(
    false,
  );
  expect(f.writes).toEqual([]);
});
