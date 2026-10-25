/** Credentials and arbitrary network requests are intentionally absent. */
export const EDITOR_PROTOCOL = 1;
export type EditorDraft = { revision: number; title: string; body: string; version: string | null };
export type EditorMediaRequest = { action: "pick" | "resolve" | "preview"; src?: string; kind?: "image" | "video" | "audio" | "file" };
export type EditorRequest = {
  v: 1; session: string; id: number; type: "request";
  method: "load" | "refresh" | "checkpoint" | "save" | "targets" | "media" | "navigate";
  params: unknown;
};
export type EditorState = "saved" | "dirty" | "saving" | "conflict" | "error";
export type EditorEvent = { v: 1; session: string; type: "state"; state: EditorState; error: string };
export type EditorResponse = { v: 1; session: string; type: "response"; id: number; ok: boolean; value?: unknown; error?: string; code?: string };
export type EditorCommand = { v: 1; session: string; type: "command"; id: number; method: "flush" | "mode" | "refresh"; mode?: "blocks" | "source" };
export type EditorCommandResult = { v: 1; session: string; type: "result"; id: number; ok: boolean; error?: string };
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const revision = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
export function isDraft(x: unknown): x is EditorDraft {
  return object(x) && revision(x.revision) && typeof x.title === "string" && typeof x.body === "string" && (x.version === null || typeof x.version === "string");
}
export function parseEditorMessage(raw: string, session: string): EditorRequest | EditorEvent | EditorCommandResult | null {
  if (raw.length > 24 * 1024 * 1024) return null;
  let x: unknown;
  try { x = JSON.parse(raw); } catch { return null; }
  if (!object(x) || x.v !== EDITOR_PROTOCOL || x.session !== session) return null;
  if (x.type === "state" && ["saved", "dirty", "saving", "conflict", "error"].includes(String(x.state)) && typeof x.error === "string") return x as EditorEvent;
  if (!revision(x.id)) return null;
  if (x.type === "result" && typeof x.ok === "boolean" && (x.error === undefined || typeof x.error === "string")) return x as EditorCommandResult;
  if (x.type !== "request") return null;
  switch (x.method) {
    case "load": case "refresh": case "targets": if (x.params !== null) return null; break;
    case "checkpoint": if (!isDraft(x.params)) return null; break;
    case "save": if (!isDraft(x.params) || !("force" in x.params) || typeof x.params.force !== "boolean") return null; break;
    case "navigate": if (typeof x.params !== "string" || x.params.length > 4096) return null; break;
    case "media": {
      if (!object(x.params) || !["pick", "resolve", "preview"].includes(String(x.params.action))) return null;
      if (x.params.src !== undefined && (typeof x.params.src !== "string" || x.params.src.length > 8192)) return null;
      if (x.params.kind !== undefined && !["image", "video", "audio", "file"].includes(String(x.params.kind))) return null;
      if (x.params.action !== "pick" && typeof x.params.src !== "string") return null;
      break;
    }
    default: return null;
  }
  return x as EditorRequest;
}
/** Safe to interpolate into a script element or injectJavaScript. */
export function scriptJSON(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
