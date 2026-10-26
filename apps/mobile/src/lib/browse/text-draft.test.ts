import { describe, expect, test } from "bun:test";
import { createTextDraft } from "./text-draft";
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
describe("management text draft receipts", () => {
  test("remote refresh updates a pristine field", () => {
    const draft = createTextDraft("before");
    draft.reconcile("remote");
    expect(draft.snapshot()).toMatchObject({
      text: "remote",
      source: "remote",
      dirty: false,
    });
  });
  test("remote refresh retains dirty native input", () => {
    const draft = createTextDraft("before");
    draft.edit("unsaved");
    draft.reconcile("remote");
    expect(draft.snapshot()).toMatchObject({
      text: "unsaved",
      source: "remote",
      dirty: true,
    });
  });
  test("save captures synchronous latest input before a React render", async () => {
    const draft = createTextDraft("before"),
      writes: string[] = [];
    draft.edit("first");
    draft.edit("latest unblurred text");
    await draft.save(async (value) => {
      writes.push(value);
    });
    expect(writes).toEqual(["latest unblurred text"]);
    expect(draft.snapshot()).toMatchObject({
      text: "latest unblurred text",
      dirty: false,
      busy: false,
    });
  });
  test("an older receipt cannot acknowledge input entered during its write", async () => {
    const draft = createTextDraft("before"),
      gate = deferred();
    draft.edit("first");
    const saving = draft.save(() => gate.promise);
    draft.edit("newer native input");
    draft.reconcile("first");
    gate.resolve();
    await saving;
    expect(draft.snapshot()).toMatchObject({
      text: "newer native input",
      source: "first",
      dirty: true,
      busy: false,
    });
  });
  test("failed save retains its draft through remote refresh and retries current text", async () => {
    const draft = createTextDraft("before"),
      gate = deferred();
    draft.edit("offline edit");
    const saving = draft.save(() => gate.promise);
    gate.reject(new Error("offline"));
    expect(await saving).toBe(false);
    draft.reconcile("remote change");
    expect(draft.snapshot()).toMatchObject({
      text: "offline edit",
      dirty: true,
      error: "Error: offline",
    });
    const writes: string[] = [];
    draft.edit("retry edit");
    expect(
      await draft.save(async (text) => {
        writes.push(text);
      }),
    ).toBe(true);
    expect(writes).toEqual(["retry edit"]);
    expect(draft.snapshot().error).toBe("");
  });
  test("a newer remote value is not erased by an old local acknowledgment", async () => {
    const draft = createTextDraft("before"),
      gate = deferred();
    draft.edit("local");
    const saving = draft.save(() => gate.promise);
    draft.reconcile("remote after local write");
    gate.resolve();
    await saving;
    expect(draft.snapshot()).toMatchObject({
      text: "local",
      source: "remote after local write",
      dirty: true,
    });
  });
  test("rapid Save presses cannot overlap per-item writes", async () => {
    const draft = createTextDraft("before"),
      gate = deferred();
    let writes = 0;
    draft.edit("local");
    const write = () => {
      writes++;
      return gate.promise;
    };
    const first = draft.save(write);
    expect(draft.snapshot().busy).toBe(true);
    expect(await draft.save(write)).toBe(false);
    expect(writes).toBe(1);
    gate.resolve();
    await first;
    expect(draft.snapshot().busy).toBe(false);
  });
});
