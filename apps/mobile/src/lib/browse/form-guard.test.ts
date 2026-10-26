import { expect, test } from "bun:test";
import {
  createFormExitGuard,
  createMutationGate,
  type FormExitState,
} from "./form-guard";
import { createTextDraft } from "./text-draft";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test("rapid database Create presses issue exactly one write before any render", async () => {
  const gate = createMutationGate(),
    response = deferred();
  let writes = 0;
  const create = async () => {
    const release = gate.begin();
    if (!release) return;
    try {
      writes++;
      await response.promise;
    } finally {
      release();
    }
  };
  const first = create(),
    second = create();
  expect(writes).toBe(1);
  expect(gate.isPending()).toBe(true);
  response.resolve();
  await Promise.all([first, second]);
  expect(gate.isPending()).toBe(false);
});

test("toolbar exit and system back both block a mutation started before busy state renders", () => {
  const gate = createMutationGate();
  let navigations = 0;
  const guard = createFormExitGuard(() => ({
    pending: gate.isPending(),
    dirty: true,
    revision: 1,
  }));
  const release = gate.begin()!;
  expect(guard.request(() => navigations++).kind).toBe("blocked");
  expect(guard.request(() => navigations++).kind).toBe("blocked");
  expect(guard.commit().kind).toBe("idle");
  expect(navigations).toBe(0);
  release();
});

test("closing prepared before a write is rechecked immediately before navigation", () => {
  const gate = createMutationGate();
  let navigations = 0;
  const guard = createFormExitGuard(() => ({
    pending: gate.isPending(),
    dirty: false,
    revision: 0,
  }));
  expect(guard.request(() => navigations++).kind).toBe("ready");
  const release = gate.begin()!;
  expect(guard.commit().kind).toBe("blocked");
  expect(navigations).toBe(0);
  release();
});

test("a failed rename keeps its editable draft until explicit discard confirmation commits", async () => {
  const draft = createTextDraft("Saved");
  draft.edit("Failed edit");
  await draft.save(async () => {
    throw new Error("offline");
  });
  let navigations = 0;
  const guard = createFormExitGuard(() => ({
    pending: draft.snapshot().busy,
    dirty: draft.snapshot().dirty || !!draft.snapshot().error,
    revision: draft.snapshot().revision,
  }));
  const close = guard.request(() => navigations++);
  expect(close.kind).toBe("confirm");
  expect(draft.snapshot().text).toBe("Failed edit");
  expect(navigations).toBe(0);
  if (close.kind !== "confirm")
    throw new Error("discard confirmation expected");
  expect(close.confirm().kind).toBe("ready");
  expect(guard.commit().kind).toBe("ready");
  expect(navigations).toBe(1);
});

test("an older discard confirmation cannot discard newer native input", () => {
  const draft = createTextDraft("Saved");
  draft.edit("First edit");
  let navigations = 0;
  const guard = createFormExitGuard(() => ({
    pending: false,
    dirty: draft.snapshot().dirty,
    revision: draft.snapshot().revision,
  }));
  const first = guard.request(() => navigations++);
  if (first.kind !== "confirm") throw new Error("confirmation expected");
  draft.edit("Newer edit");
  expect(first.confirm().kind).toBe("confirm");
  expect(guard.commit().kind).toBe("idle");
  expect(navigations).toBe(0);
  expect(draft.snapshot().text).toBe("Newer edit");
});

test("discard confirmation also rechecks newly pending saves", () => {
  let state: FormExitState = { pending: false, dirty: true, revision: 1 };
  let navigations = 0;
  const guard = createFormExitGuard(() => state);
  const close = guard.request(() => navigations++);
  if (close.kind !== "confirm") throw new Error("confirmation expected");
  state = { ...state, pending: true };
  expect(close.confirm().kind).toBe("blocked");
  expect(navigations).toBe(0);
});

test("new input arriving after confirmation but before navigation requires fresh confirmation", () => {
  let state: FormExitState = { pending: false, dirty: true, revision: 1 };
  let navigations = 0;
  const guard = createFormExitGuard(() => state);
  const close = guard.request(() => navigations++);
  if (close.kind !== "confirm") throw new Error("confirmation expected");
  close.confirm();
  state = { ...state, revision: 2 };
  expect(guard.commit().kind).toBe("confirm");
  expect(navigations).toBe(0);
});

test("an old mutation receipt cannot unlock a newer save", () => {
  const gate = createMutationGate(),
    first = gate.begin()!;
  first();
  const second = gate.begin()!;
  first();
  expect(gate.isPending()).toBe(true);
  second();
  expect(gate.isPending()).toBe(false);
});

test("successful add-option receipt clears only its captured draft and retains newer text", async () => {
  const draft = createTextDraft("");
  draft.edit("Created option");
  const gate = deferred();
  const saving = draft.save(() => gate.promise, true);
  draft.edit("Next unsaved option");
  gate.resolve();
  await saving;
  expect(draft.snapshot()).toMatchObject({
    source: "",
    text: "Next unsaved option",
    dirty: true,
  });
  let navigations = 0;
  const guard = createFormExitGuard(() => ({
    pending: draft.snapshot().busy,
    dirty: draft.snapshot().dirty,
    revision: draft.snapshot().revision,
  }));
  expect(guard.request(() => navigations++).kind).toBe("confirm");
  expect(navigations).toBe(0);
});
