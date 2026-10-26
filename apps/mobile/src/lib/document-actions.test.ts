import { expect, test } from "bun:test";
import {
  deleteFlushedDocument,
  saveDocumentForm,
  withFlushedDocument,
} from "./document-actions";
import { EditorHost } from "./editor/host";
import type { EditorDraft } from "./editor/protocol";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test("frozen delete keeps bridge saves and late acknowledgements alive until flush completes", async () => {
  const log: string[] = [];
  const save = deferred<{ version: string }>();
  let active = true;
  let draft: EditorDraft | null = null;
  const host = new EditorHost("doc-session", {
    isCurrent: () => active,
    load: async () => ({ title: "T", body: "old", version: "v1" }),
    readDraft: async () => draft,
    checkpoint: async (d) => {
      draft = d;
      log.push("checkpoint");
    },
    save: async () => {
      log.push("saving");
      return save.promise;
    },
    acknowledge: async () => {
      log.push("ack");
      draft = null;
    },
  });
  const request = host.request({
    v: 1,
    session: "doc-session",
    type: "request",
    id: 1,
    method: "save",
    params: {
      title: "T",
      body: "latest unblurred body",
      version: "v1",
      revision: 1,
      force: false,
    },
  });
  const deleting = withFlushedDocument(
    {
      setFrozen: (f) => log.push(f ? "freeze" : "thaw"),
      flush: async () => {
        const response = await request;
        return { ok: response?.ok ?? false };
      },
    },
    () => true,
    () =>
      deleteFlushedDocument({
        pause: () => {
          active = false;
          log.push("pause");
        },
        commit: async () => {
          log.push("delete");
          return { ok: true };
        },
        discardDraft: () => log.push("discard"),
        resume: () => {
          active = true;
          log.push("resume");
        },
        deleted: () => log.push("deleted"),
      }),
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(log).not.toContain("delete");
  expect(log).not.toContain("pause");
  save.resolve({ version: "v2" });
  await deleting;
  expect(log.indexOf("ack")).toBeLessThan(log.indexOf("pause"));
  expect(log.indexOf("pause")).toBeLessThan(log.indexOf("delete"));
  expect(log.indexOf("delete")).toBeLessThan(log.indexOf("discard"));
  expect(log.at(-1)).toBe("thaw");
  expect(draft).toBeNull();
});
test("failed flush retains recovery and prevents copy move or delete", async () => {
  const log: string[] = [];
  await expect(
    withFlushedDocument(
      {
        setFrozen: (f) => log.push(f ? "freeze" : "thaw"),
        flush: async () => ({ ok: false, error: "disk full" }),
      },
      () => true,
      () => {
        log.push("commit");
      },
    ),
  ).rejects.toThrow("disk full");
  expect(log).toEqual(["freeze", "thaw"]);
});
test("failed delete restores callbacks and never discards draft", async () => {
  const log: string[] = [];
  await expect(
    deleteFlushedDocument({
      pause: () => log.push("pause"),
      commit: async () => {
        throw new Error("disk full");
      },
      discardDraft: () => log.push("discard"),
      resume: () => log.push("resume"),
      deleted: () => log.push("deleted"),
    }),
  ).rejects.toThrow("disk full");
  expect(log).toEqual(["pause", "resume"]);
});
test("an expired workspace cannot enter the document action", async () => {
  const log: string[] = [];
  await expect(
    withFlushedDocument(
      {
        setFrozen: (f) => log.push(String(f)),
        flush: async () => ({ ok: true }),
      },
      () => false,
      () => {
        log.push("commit");
      },
    ),
  ).rejects.toThrow("工作区会话已结束");
  expect(log).toEqual(["true"]);
});

test("late native form input keeps the form open and retries against the created document receipt", async () => {
  const pending = deferred<{ id: string; version: string }>();
  let revision = 1;
  let title = "first title";
  let receipt: { id: string; version: string } | null = null;
  const writes: string[] = [];
  const save = () =>
    saveDocumentForm({
      revision: () => revision,
      isCurrent: () => true,
      write: async () => {
        const previous = receipt;
        writes.push(
          previous
            ? "update:" + previous.id + ":" + previous.version + ":" + title
            : "create:" + title,
        );
        return previous ? { id: previous.id, version: "v2" } : pending.promise;
      },
      remember: (value) => {
        receipt = value;
      },
    });
  const oldSave = save();
  title = "new native input";
  revision++;
  pending.resolve({ id: "new-document", version: "v1" });
  await expect(oldSave).rejects.toThrow("新的修改仍待保存");
  expect(title).toBe("new native input");
  expect(receipt as { id: string; version: string } | null).toEqual({
    id: "new-document",
    version: "v1",
  });
  await expect(save()).resolves.toEqual({ id: "new-document", version: "v2" });
  expect(writes).toEqual([
    "create:first title",
    "update:new-document:v1:new native input",
  ]);
});
test("failed form writes retain the previous receipt and never acknowledge the form", async () => {
  const receipt = { id: "document", version: "v1" };
  let remembered = false;
  await expect(
    saveDocumentForm({
      revision: () => 0,
      isCurrent: () => true,
      write: async () => {
        throw new Error("disk full");
      },
      remember: () => {
        remembered = true;
      },
    }),
  ).rejects.toThrow("disk full");
  expect(remembered).toBe(false);
  expect(receipt).toEqual({ id: "document", version: "v1" });
});
test("expired form sessions cannot start writes or consume a late receipt", async () => {
  let current = false;
  let writes = 0;
  const pending = deferred<string>();
  const remembered: string[] = [];
  const save = () =>
    saveDocumentForm({
      revision: () => 0,
      isCurrent: () => current,
      write: () => {
        writes++;
        return pending.promise;
      },
      remember: (value) => remembered.push(value),
    });
  await expect(save()).rejects.toThrow("工作区会话已结束");
  expect(writes).toBe(0);
  current = true;
  const oldSave = save();
  current = false;
  pending.resolve("old receipt");
  await expect(oldSave).rejects.toThrow("工作区会话已结束");
  expect(remembered).toEqual([]);
});
test("a queued checkpoint cannot re-create a draft while deletion is paused", async () => {
  let active = true;
  let checkpoints = 0;
  const deletion = deferred<{ ok: boolean }>();
  const host = new EditorHost("renderer", {
    isCurrent: () => active,
    load: async () => ({ title: "T", body: "B", version: "v1" }),
    readDraft: async () => null,
    checkpoint: async () => {
      checkpoints++;
    },
    save: async () => ({ version: "v2" }),
    acknowledge: async () => {},
  });
  const commit = deleteFlushedDocument({
    pause: () => {
      active = false;
    },
    commit: () => deletion.promise,
    discardDraft: () => {},
    resume: () => {
      active = true;
    },
    deleted: () => {},
  });
  expect(
    await host.request({
      v: 1,
      session: "renderer",
      type: "request",
      id: 1,
      method: "checkpoint",
      params: { title: "T", body: "late", revision: 1, version: "v1" },
    }),
  ).toBeNull();
  deletion.resolve({ ok: false });
  await expect(commit).rejects.toThrow("文档未能删除");
  expect(active).toBe(true);
  expect(checkpoints).toBe(0);
});
test("native navigation may flush bridge writes without waiting on its own request", async () => {
  const events: string[] = [];
  const host: EditorHost = new EditorHost("renderer", {
    isCurrent: () => true,
    load: async () => ({ title: "T", body: "B", version: "v1" }),
    readDraft: async () => null,
    checkpoint: async () => {
      events.push("checkpoint");
    },
    save: async () => {
      events.push("save");
      return { version: "v2" };
    },
    acknowledge: async () => {
      events.push("acknowledge");
    },
    navigate: async () =>
      withFlushedDocument(
        {
          setFrozen: (value) => {
            events.push(value ? "freeze" : "thaw");
          },
          flush: async () => {
            const saved = await host.request({
              v: 1,
              session: "renderer",
              type: "request",
              id: 2,
              method: "save",
              params: {
                title: "T",
                body: "newest",
                revision: 2,
                version: "v1",
                force: false,
              },
            });
            return { ok: saved?.ok ?? false };
          },
        },
        () => true,
        () => {
          events.push("navigate");
        },
      ),
  });
  const response = await host.request({
    v: 1,
    session: "renderer",
    type: "request",
    id: 1,
    method: "navigate",
    params: "/doc/next",
  });
  expect(response?.ok).toBe(true);
  expect(events).toEqual([
    "freeze",
    "checkpoint",
    "save",
    "acknowledge",
    "navigate",
    "thaw",
  ]);
});
