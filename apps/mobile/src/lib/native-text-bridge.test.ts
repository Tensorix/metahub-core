import { expect, test } from "bun:test";
import { createNativeTextBridge } from "./native-text-bridge";
import { createTextDraft } from "./browse/text-draft";

function nativeFixture(initial = "") {
  let value = initial;
  const scheduledWrites: string[] = [];
  const bridge = createNativeTextBridge(initial);
  return {
    bridge,
    nativeInput(text: string, deliverEvent = true) {
      value = text;
      if (deliverEvent) bridge.nativeChanged(text);
    },
    parentEffect(text: string, resetKey?: string | number) {
      if (bridge.reconcile(text, resetKey) && value !== text)
        scheduledWrites.push(text);
    },
    applyScheduledWrites() {
      for (const text of scheduledWrites.splice(0)) value = text;
    },
    value: () => value,
    writes: () => [...scheduledWrites],
  };
}

test("a delayed v1 parent echo never queues a write over v2 already typed natively", () => {
  const field = nativeFixture();
  field.nativeInput("Android");
  // Native is already ahead, even before the next change event reaches JS.
  field.nativeInput("AndroidBucket", false);
  field.parentEffect("Android");
  expect(field.writes()).toEqual([]);
  field.applyScheduledWrites();
  expect(field.value()).toBe("AndroidBucket");
  field.bridge.nativeChanged("AndroidBucket");
  field.parentEffect("AndroidBucket");
  expect(field.writes()).toEqual([]);
});

test("fast insertion and deletion echoes preserve the exact native string across batched renders", () => {
  const field = nativeFixture();
  const expected = "AndroidBucketOffline20261026";
  const events = Array.from({ length: expected.length }, (_, i) =>
    expected.slice(0, i + 1),
  );
  for (const text of events) field.nativeInput(text);
  // Effects for older commits run after all those native edits.
  for (const text of events) field.parentEffect(text);
  field.applyScheduledWrites();
  expect(field.value()).toBe(expected);
  expect(field.writes()).toEqual([]);
  for (const text of [
    expected.slice(0, -1),
    expected.slice(0, -2),
    expected.slice(0, -1),
    expected,
  ])
    field.nativeInput(text);
  field.parentEffect(expected.slice(0, -1));
  field.parentEffect(expected);
  field.applyScheduledWrites();
  expect(field.value()).toBe(expected);
});

test("initial data load, untouched remote updates, trim and programmatic clear still replace native text", () => {
  const field = nativeFixture();
  field.nativeInput("fast native input", false);
  field.parentEffect(""); // delayed mount effect must not write the initial value
  expect(field.writes()).toEqual([]);
  field.parentEffect("Loaded title");
  field.applyScheduledWrites();
  expect(field.value()).toBe("Loaded title");
  field.parentEffect("Remote title");
  field.applyScheduledWrites();
  expect(field.value()).toBe("Remote title");
  field.nativeInput("  local title  ");
  field.parentEffect("  local title  ");
  field.parentEffect("local title");
  field.applyScheduledWrites();
  expect(field.value()).toBe("local title");
  field.parentEffect("");
  field.applyScheduledWrites();
  expect(field.value()).toBe("");
});

test("a batched latest echo retires older edits so clearAfterSave works through the real text draft", async () => {
  const field = nativeFixture();
  const draft = createTextDraft("");
  for (const text of ["N", "Ne", "New property"]) {
    field.nativeInput(text);
    draft.edit(text);
  }
  field.parentEffect(draft.snapshot().text);
  expect(field.writes()).toEqual([]);
  const saved: string[] = [];
  await draft.save(async (text) => {
    saved.push(text);
  }, true);
  field.parentEffect(draft.snapshot().text);
  field.applyScheduledWrites();
  expect(saved).toEqual(["New property"]);
  expect(field.value()).toBe("");
});

test("explicit reset revisions disambiguate a value equal to an old pending echo", () => {
  const field = nativeFixture("initial");
  field.nativeInput("");
  field.nativeInput("New unsaved value");
  field.parentEffect("", 1);
  field.applyScheduledWrites();
  expect(field.value()).toBe("");
  field.nativeInput("next");
  field.parentEffect("next", 1);
  expect(field.writes()).toEqual([]);
  field.nativeInput("native is ahead", false);
  field.parentEffect("next", 2); // force reset to the same last parent text
  field.applyScheduledWrites();
  expect(field.value()).toBe("next");
});

test("duplicate text echoes retire the earliest matching edit and never overwrite native a", () => {
  const field = nativeFixture();
  for (const text of ["a", "ab", "a"]) field.nativeInput(text);
  for (const text of ["a", "ab", "a"]) {
    field.parentEffect(text);
    expect(field.writes()).toEqual([]);
    field.applyScheduledWrites();
    expect(field.value()).toBe("a");
  }
});

test("a batched a-ab-a commit retains later echoes until a known new value retires the queue", () => {
  const field = nativeFixture();
  for (const text of ["a", "ab", "a"]) field.nativeInput(text);
  field.parentEffect("a");
  field.nativeInput("ac");
  field.parentEffect("ac");
  expect(field.writes()).toEqual([]);
  field.applyScheduledWrites();
  expect(field.value()).toBe("ac");
  // The known ac acknowledgment retired earlier, skipped values. A later
  // intentional replacement to ab is no longer mistaken for an old echo.
  field.parentEffect("ab");
  expect(field.writes()).toEqual(["ab"]);
});

test("a same-parent-value acknowledgment consumes known pending echoes before the no-change shortcut", () => {
  const field = nativeFixture("a");
  for (const text of ["ab", "a"]) field.nativeInput(text);
  field.parentEffect("a");
  field.parentEffect("ab"); // external replacement after the settled a echo
  expect(field.writes()).toEqual(["ab"]);
});

test("a later known echo retires long skipped duplicate history without dropping pending edits by a cap", () => {
  const field = nativeFixture("a");
  // React need not commit any text change for these batches ending at the
  // existing parent value. Retain their history until a known echo retires it.
  for (let i = 0; i < 1000; i++) {
    field.nativeInput("ab");
    field.nativeInput("a");
  }
  field.nativeInput("ac");
  field.parentEffect("ac");
  expect(field.writes()).toEqual([]);
  field.parentEffect("ab");
  expect(field.writes()).toEqual(["ab"]);
});
