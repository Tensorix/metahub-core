import { EDITOR_PROTOCOL, type EditorCommand, type EditorResponse } from "../../../apps/mobile/src/lib/editor/protocol";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(value: string): void };
    __METAHUB_EDITOR__: { session: string; documentId: string; dark: boolean };
    __metahubEditorReceive?: (value: unknown) => void;
  }
}
let sequence = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
export const session = window.__METAHUB_EDITOR__.session;
export function post(value: Record<string, unknown>) {
  window.ReactNativeWebView?.postMessage(JSON.stringify({ ...value, v: EDITOR_PROTOCOL, session }));
}
export function rpc<T>(method: string, params: unknown = null): Promise<T> {
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
export function onCommand(handler: (command: EditorCommand) => void) { commandHandler = handler; }
window.__metahubEditorReceive = (value: unknown) => {
  if (!value || typeof value !== "object") return;
  const msg = value as EditorResponse | EditorCommand;
  if (msg.v !== EDITOR_PROTOCOL || msg.session !== session || !Number.isSafeInteger(msg.id)) return;
  if (msg.type === "command") {
    if (msg.method === "flush" || msg.method === "refresh" || (msg.method === "mode" && (msg.mode === "blocks" || msg.mode === "source"))) commandHandler?.(msg);
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
