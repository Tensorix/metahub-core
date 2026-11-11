import { createDatabaseTrace } from "../../shared/views/database-performance";
export interface DatabaseBoot {
  session: string;
  workspace: string;
  instance?: string;
  databaseId: string;
  view?: string;
  dark: boolean;
  fontScale?: number;
  preferences?: Record<string, string>;
  metadata?: { db: any; props: any[] };
}
export let boot: DatabaseBoot;
let active = false;
export let openingTrace: ReturnType<typeof createDatabaseTrace>;
export function beginSession(config: DatabaseBoot) {
  if (active) throw new Error("上一数据表尚未关闭");
  failedWrites.clear();
  boot = config;
  active = true;
  draftRevision = 0;
  checkpoint = Promise.resolve();
  checkpointError = null;
  lastPayload = null;
  openingTrace = createDatabaseTrace(boot.session, "web", (sample) => {
    void rpc("performance", sample).catch(() => {});
  });
}
export function endSession() {
  active = false;
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error("数据表会话已关闭"));
  }
  pending.clear();
}
export const sessionActive = () => active;
let sequence = 0;
const failedWrites = new Map<string, { method: string; error: Error }>();
const pending = new Map<
  number,
  {
    resolve(value: any): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
    method: string;
    key: string;
    completion: Promise<unknown>;
  }
>();
export function rpc<T = any>(method: string, ...args: unknown[]): Promise<T> {
  if (!active) return Promise.reject(new Error("数据表会话已关闭"));
  const id = ++sequence;
  const key =
    method +
    ":" +
    JSON.stringify(method === "checkpoint" ? args.slice(0, 2) : args[0]);
  const promise = new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      const error = new Error("操作超时，请重试");
      if (writeMethods.has(method)) failedWrites.set(key, { method, error });
      reject(error);
    }, 30000);
    pending.set(id, {
      resolve,
      reject,
      timer,
      method,
      key,
      completion: Promise.resolve(),
    });
    const transport = (window as any).ReactNativeWebView;
    const payload = JSON.stringify({
      v: 1,
      session: boot.session,
      workspace: boot.workspace,
      id,
      method,
      args,
    });
    if (transport.sessionProtocol === 2)
      transport.postMessage(payload, boot.session);
    else transport.postMessage(payload);
  });
  const waiter = pending.get(id);
  if (waiter) waiter.completion = promise;
  return promise;
}
(window as any).__metahubDatabaseReceive = (message: any) => {
  if (!active || message.session !== boot.session) return;
  if (message.type === "flush") {
    if (message.navigation) {
      const dialog = document.querySelector<HTMLDialogElement>("dialog[open]");
      if (dialog) {
        dialog.dispatchEvent(new Event("cancel"));
        void rpc("flushed", message.token, null, true);
        return;
      }
      if (document.querySelector(".menu-layer,.modal-scrim.open")) {
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
        void rpc("flushed", message.token, null, true);
        return;
      }
    }
    void flush().then(
      () => rpc("flushed", message.token, null),
      (e) => rpc("flushed", message.token, e.message),
    );
    return;
  }
  if (message.type === "view") {
    document.dispatchEvent(
      new CustomEvent("database-view-request", { detail: message.view }),
    );
    return;
  }
  if (message.type === "freeze") {
    document.body.inert = message.value;
    return;
  }
  if (message.type === "changed") {
    document.dispatchEvent(
      new CustomEvent("mh-synced", { detail: message.change }),
    );
    return;
  }
  const waiter = pending.get(message.id);
  if (!waiter) return;
  clearTimeout(waiter.timer);
  pending.delete(message.id);
  if (message.ok) {
    failedWrites.delete(waiter.key);
    waiter.resolve(message.value);
  } else {
    const error = new Error(message.error);
    if (writeMethods.has(waiter.method))
      failedWrites.set(waiter.key, { method: waiter.method, error });
    waiter.reject(error);
  }
};

let draftRevision = 0;
let checkpoint: Promise<unknown> = Promise.resolve();
let checkpointError: Error | null = null;
let lastPayload: unknown[] | null = null;
document.addEventListener(
  "input",
  (event) => {
    if (!active) return;
    const input = event.target as HTMLInputElement;
    const cell = input.closest<HTMLElement>("[data-prop-id]"),
      row = input.closest<HTMLElement>("[data-record-id],tr[data-row-id]");
    if (!cell || !row || input.type === "checkbox") return;
    const value = input.isContentEditable ? input.textContent : input.value;
    const revision = ++draftRevision;
    document.dispatchEvent(
      new CustomEvent("database-draft-status", { detail: "正在保留草稿…" }),
    );
    const payload = (lastPayload = [
      row.dataset.recordId ?? row.dataset.rowId,
      cell.dataset.propId,
      value,
      revision,
    ]);
    checkpoint = checkpoint
      .catch(() => {})
      .then(() => rpc("checkpoint", ...payload))
      .then(
        () => {
          checkpointError = null;
          if (revision === draftRevision)
            document.dispatchEvent(
              new CustomEvent("database-draft-status", {
                detail: "草稿已保留",
              }),
            );
        },
        (e) => {
          checkpointError = e;
          document.dispatchEvent(
            new CustomEvent("database-draft-status", {
              detail: "草稿未确认保留，请重试",
            }),
          );
        },
      );
  },
  true,
);
export async function checkpointReady() {
  await checkpoint;
  if (checkpointError && lastPayload) {
    await rpc("checkpoint", ...lastPayload);
    checkpointError = null;
    document.dispatchEvent(
      new CustomEvent("database-draft-status", { detail: "草稿已保留" }),
    );
  }
  if (checkpointError) throw checkpointError;
}
window.addEventListener("mh-preference", ((e: CustomEvent) => {
  if (active)
    void rpc("preference", e.detail.key, e.detail.value).catch((error) =>
      document.dispatchEvent(
        new CustomEvent("mh-database-error", { detail: error.message }),
      ),
    );
}) as EventListener);
let flushing: Promise<void> | null = null;
export function flush(): Promise<void> {
  return (flushing ??= flushWrites().finally(() => {
    flushing = null;
  }));
}
async function flushWrites() {
  if (document.activeElement instanceof HTMLElement)
    document.activeElement.blur();
  document.dispatchEvent(new Event("database-before-flush"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await checkpointReady();
  const deadline = Date.now() + 10000;
  while (true) {
    const writes = [...pending.values()].filter((p) =>
      writeMethods.has(p.method),
    );
    if (!writes.length) break;
    if (Date.now() > deadline) throw new Error("保存仍在进行，请重试");
    await Promise.all(writes.map((p) => p.completion));
  }
  await rpc("flush");
  // Native flush retries record drafts. Configuration and structural writes must
  // be explicitly retried; an already rejected promise cannot disappear at blur.
  for (const [key, failure] of failedWrites)
    if (failure.method === "checkpoint" || failure.method === "updateRecord")
      failedWrites.delete(key);
  if (failedWrites.size) throw failedWrites.values().next().value!.error;
}

const writeMethods = new Set([
  "checkpoint",
  "createDocument",
  "updateRecord",
  "createRecord",
  "deleteRecord",
  "moveRecord",
  "createProperty",
  "updateProperty",
  "deleteProperty",
  "moveProperty",
  "updateDatabase",
  "preference",
  "discardCheckpoint",
  "renameSelectOption",
  "removeSelectOption",
  "moveSelectOption",
  "setColumnWidth",
  "revertRecord",
  "auditRevert",
]);
