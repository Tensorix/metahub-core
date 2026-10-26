import { expect, test } from "bun:test";
import { createNativePresentationGuard } from "./native-presentation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test("system UI opens only after save; its background transition does not need a second flush", async () => {
  const save = deferred<{ ok: boolean }>();
  const share = deferred<string>();
  const events: string[] = [];
  const guard = createNativePresentationGuard(
    () => {
      events.push("save");
      return save.promise;
    },
    () => true,
  );
  const pending = guard.run(() => {
    events.push("share");
    return share.promise;
  });
  expect(events).toEqual(["save"]);
  expect(guard.isPresenting()).toBe(false);
  save.resolve({ ok: true });
  await Promise.resolve();
  expect(events).toEqual(["save", "share"]);
  expect(guard.isPresenting()).toBe(true);
  // A background listener ignores the suspended WebView only in this interval.
  if (!guard.isPresenting()) events.push("background-save");
  share.resolve("closed");
  expect(await pending).toBe("closed");
  expect(guard.isPresenting()).toBe(false);
  expect(events).toEqual(["save", "share"]);
});
test("failed save does not open a picker, and later retry is allowed", async () => {
  let succeed = false,
    opened = 0;
  const guard = createNativePresentationGuard(
    async () => ({ ok: succeed, error: "disk full" }),
    () => true,
  );
  await expect(
    guard.run(async () => {
      opened++;
    }),
  ).rejects.toThrow("disk full");
  expect(opened).toBe(0);
  expect(guard.isPresenting()).toBe(false);
  succeed = true;
  await guard.run(async () => {
    opened++;
  });
  expect(opened).toBe(1);
});
test("renderer replacement while saving cannot open a late system sheet", async () => {
  const save = deferred<{ ok: boolean }>();
  let opened = false;
  const guard = createNativePresentationGuard(
    () => save.promise,
    () => true,
  );
  const pending = guard.run(async () => {
    opened = true;
  });
  guard.dispose();
  save.resolve({ ok: true });
  await expect(pending).rejects.toThrow("会话已结束");
  expect(opened).toBe(false);
  expect(guard.isPresenting()).toBe(false);
});
test("workspace switch after preflight and duplicate picker requests are rejected", async () => {
  const save = deferred<{ ok: boolean }>();
  let current = true;
  const guard = createNativePresentationGuard(
    () => save.promise,
    () => current,
  );
  const pending = guard.run(async () => "opened");
  await expect(guard.run(async () => "second")).rejects.toThrow(
    "附件操作正在进行",
  );
  current = false;
  save.resolve({ ok: true });
  await expect(pending).rejects.toThrow("会话已结束");
});
test("native cancellation/failure releases the presentation guard", async () => {
  const guard = createNativePresentationGuard(
    async () => ({ ok: true }),
    () => true,
  );
  await expect(
    guard.run(async () => {
      throw new Error("picker cancelled");
    }),
  ).rejects.toThrow("picker cancelled");
  expect(guard.isPresenting()).toBe(false);
  expect(await guard.run(async () => "retry")).toBe("retry");
});

test("a download that finishes while the app is backgrounded cannot flush a suspended renderer or open UI", async () => {
  let active = false,
    opened = false,
    saves = 0;
  const guard = createNativePresentationGuard(
    async () => {
      saves++;
      return { ok: true };
    },
    () => true,
    () => active,
  );
  await expect(
    guard.run(async () => {
      opened = true;
    }),
  ).rejects.toThrow("请返回文档");
  expect(saves).toBe(0);
  expect(opened).toBe(false);
  expect(guard.isPresenting()).toBe(false);
  active = true;
  await guard.run(async () => {
    opened = true;
  });
  expect(saves).toBe(1);
  expect(opened).toBe(true);
});

test("backgrounding while actual presentation preflight is saving prevents system UI from opening", async () => {
  const save = deferred<{ ok: boolean }>();
  let active = true,
    opened = false;
  const guard = createNativePresentationGuard(
    () => save.promise,
    () => true,
    () => active,
  );
  const pending = guard.run(async () => {
    opened = true;
  });
  active = false;
  save.resolve({ ok: true });
  await expect(pending).rejects.toThrow("请返回文档");
  expect(opened).toBe(false);
  expect(guard.isPresenting()).toBe(false);
});
