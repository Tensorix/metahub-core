import { expect, test } from "bun:test";
import { scheduleSearch } from "./request-state";

test("rapid query changes commit only the latest search", async () => {
  const requests: string[] = [];
  const cancel = scheduleSearch(() => requests.push("old query"), 5);
  cancel();
  scheduleSearch(() => requests.push("new query"), 5);
  await Bun.sleep(20);
  expect(requests).toEqual(["new query"]);
});
