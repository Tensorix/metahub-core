import { EDITOR_PROTOCOL, EDITOR_BLOCK_TYPES, EDITOR_FORMAT_TYPES, type EditorCommand, type EditorResponse, type EditorDraft, type EditorMediaRequest } from "../../../apps/mobile/src/lib/editor/protocol";

declare global {
  interface Window {
    ReactNativeWebView?: { sessionProtocol?: number; postMessage(value: string, session?: string): void };
    __METAHUB_EDITOR__: { session: string; documentId: string; dark: boolean; topInset?: number; position?: { anchor: number; head: number; scroll: number; version: string | null }; initial?: EditorDraft & { recovered: boolean } };
    __metahubEditorReceive?: (value: unknown) => void;
  }
}
export function createBridge(session: string) {
  let closed = false;
  let sequence = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();

  function post(value: Record<string, unknown>) {
    if (closed) return;
    const transport = window.ReactNativeWebView;
    const data = JSON.stringify({ ...value, v: EDITOR_PROTOCOL, session });
    if (transport?.sessionProtocol === 2) transport.postMessage(data, session);
    else transport?.postMessage(data);
  }
  function rpc<T>(method: string, params: unknown = null): Promise<T> {
    if (closed) return Promise.reject(new Error("编辑器会话已结束"));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Native editor request timed out; your draft is retained"));
      }, method === "media" ? 10 * 60_000 : 30_000);
      pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      post({ type: "request", id, method, params });
    });
  }
  let commandHandler: ((command: EditorCommand) => void) | null = null;
  function onCommand(handler: (command: EditorCommand) => void) { commandHandler = handler; }
  const receive = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const msg = value as EditorResponse | EditorCommand;
    if (msg.v !== EDITOR_PROTOCOL || msg.session !== session || !Number.isSafeInteger(msg.id)) return;
    if (msg.type === "command") {
      if ((msg.method === "format" && EDITOR_FORMAT_TYPES.includes(msg.format!)) || (msg.method === "block" && EDITOR_BLOCK_TYPES.includes(msg.block!)) || msg.method === "retry" || msg.method === "flush" || msg.method === "refresh" || (msg.method === "mode" && (msg.mode === "blocks" || msg.mode === "source")) || (msg.method === "attach" && ["library", "image", "video", "audio", "file"].includes(msg.kind ?? ""))) commandHandler?.(msg);
      return;
    }
    if (msg.type !== "response" || typeof msg.ok !== "boolean") return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    clearTimeout(waiter.timer);
    if (msg.ok) waiter.resolve(msg.value);
    else waiter.reject(Object.assign(new Error(msg.error || "Native editor request failed"), { code: msg.code }));
  };

  // The mounted document owns the save guard; cleanup must not clear a newer
  // registration, and an in-flight guard cannot preview after its owner leaves.
  let beforeMediaPreview: (() => Promise<void>) | null = null;
  function onBeforeMediaPreview(guard: () => Promise<void>): () => void {
    beforeMediaPreview = guard;
    return () => { if (beforeMediaPreview === guard) beforeMediaPreview = null; };
  }
  async function previewMedia(src: string | undefined, kind: EditorMediaRequest["kind"]) {
    const guard = beforeMediaPreview;
    if (!guard || !src) throw new Error("编辑器尚未就绪，请稍后重试");
    await guard();
    if (beforeMediaPreview !== guard) throw new Error("文档会话已结束");
    return rpc("media", { action: "preview", src, kind } satisfies EditorMediaRequest);
  }

  function dispose() {
    closed = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("编辑器会话已结束"));
    }
    pending.clear();
    commandHandler = null;
    beforeMediaPreview = null;
  }
  return { post, rpc, onCommand, onBeforeMediaPreview, previewMedia, receive, dispose };
}
export type EditorBridge = ReturnType<typeof createBridge>;
let active: EditorBridge | undefined;
export function bindBridge(session: string) {
  if (active) throw new Error("已有活动编辑会话");
  const bridge = active = createBridge(session);
  window.__metahubEditorReceive = bridge.receive;
  return bridge;
}
export function releaseBridge(bridge: EditorBridge) {
  bridge.dispose();
  if (active === bridge) {
    active = undefined;
    delete window.__metahubEditorReceive;
  }
}
export function currentBridge() {
  if (!active) throw new Error("编辑器尚未就绪");
  return active;
}
export function rpc<T>(method: string, params: unknown = null) { return currentBridge().rpc<T>(method, params); }
