import type { DocumentSaveResult } from "./document-save.ts";
import { toast } from "./ui.tsx";
import { t } from "./i18n/t.ts";

// One registry per renderer, including embedded/quick-note editors. Dirty
// editors stay registered after unmount until their final save is durable.
export const DOCUMENT_RECOVER = "mh-document-recover";
export interface DocumentDraft { title: string; body: string; version: string | null; error: string }
interface Editor {
  id: string;
  dirty: () => boolean;
  flush: () => Promise<DocumentSaveResult>;
  snapshot: () => DocumentDraft;
}
const editors = new Set<Editor>();
const detached = new Set<Editor>();
let installed = false;
let warned = false;
let closing = false;
let recoveryId: string | null = null;
function recover(id: string) { window.dispatchEvent(new CustomEvent(DOCUMENT_RECOVER, { detail: { id } })); }
export function documentCloseInProgress() { return closing; }
export async function claimDocumentDraft(id: string): Promise<(DocumentDraft & { accept: () => void }) | null> {
  for (const entry of detached) {
    if (entry.id !== id) continue;
    const result = await entry.flush();
    const accept = () => {
      detached.delete(entry);
      editors.delete(entry);
      reportDocumentDirty();
    };
    // Ownership only moves when the still-mounted consumer accepts. It may
    // have navigated away while this retry was waiting on the network.
    if (!result.ok) return { ...entry.snapshot(), accept };
    accept();
  }
  return null;
}
export async function flushDocument(id: string): Promise<DocumentSaveResult> {
  for (const editor of editors) {
    if (editor.id !== id) continue;
    const result = await editor.flush();
    if (!result.ok) return result;
  }
  return { ok: true };
}
export function reportDocumentDirty() {
  for (const entry of detached) {
    if (!entry.dirty()) { detached.delete(entry); editors.delete(entry); }
  }
  window.metahubDesktop?.documents?.setDirty([...editors].some((editor) => editor.dirty()));
}
export function registerDocumentEditor(editor: Editor) {
  editors.add(editor);
  if (!warned) {
    warned = true;
    window.addEventListener("beforeunload", (event) => {
      if (!closing && [...editors].some((entry) => entry.dirty())) { event.preventDefault(); event.returnValue = ""; }
    });
  }
  const bridge = window.metahubDesktop?.documents;
  if (bridge && !installed) {
    installed = true;
    bridge.onRequestSave(async (requestId) => {
      closing = true;
      document.getElementById("app")?.setAttribute("inert", "");
      try {
        for (const entry of editors) {
          const result = await entry.flush();
          if (!result.ok) {
            if (detached.has(entry)) recoveryId = entry.id;
            bridge.saveDone(requestId, result); return;
          }
        }
        reportDocumentDirty();
        bridge.saveDone(requestId, { ok: ![...editors].some((entry) => entry.dirty()) });
      } catch (error) {
        bridge.saveDone(requestId, { ok: false, error: String(error) });
      }
    });
    bridge.onResume(() => {
      closing = false;
      document.getElementById("app")?.removeAttribute("inert");
      if (recoveryId) { const id = recoveryId; recoveryId = null; recover(id); }
    });
  }
  reportDocumentDirty();
  return () => {
    if (!editor.dirty()) { editors.delete(editor); reportDocumentDirty(); return; }
    detached.add(editor);
    void editor.flush().then((result) => {
      if (result.ok && !editor.dirty()) { editors.delete(editor); detached.delete(editor); }
      else if (detached.has(editor)) toast(t("文档尚未保存，草稿已保留。"), {
        tone: "error", ms: 15000,
        action: { label: t("查看草稿"), run: () => recover(editor.id) },
      });
      reportDocumentDirty();
    });
  };
}
