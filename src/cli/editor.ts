import type { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomSuffix } from "../core/ids.ts";
import { getDocument, updateDocument } from "../core/documents.ts";
import { getRecord, updateRecord } from "../core/records.ts";

/** Known editors mapped to their invocation, including the wait flag GUI
 * editors need so spawn blocks until the file is closed. */
const KNOWN_EDITORS: Record<string, string> = {
  vscode: "code --wait",
  code: "code --wait",
  cursor: "cursor --wait",
  windsurf: "windsurf --wait",
  zed: "zed --wait",
  sublime: "subl --wait",
  subl: "subl --wait",
  atom: "atom --wait",
  idea: "idea --wait",
  webstorm: "webstorm --wait",
  vim: "vim",
  nvim: "nvim",
  neovim: "nvim",
  vi: "vi",
  nano: "nano",
  emacs: "emacs",
  emacsclient: "emacsclient",
};

export interface EditOptions {
  /** --editor: a known editor name or a raw command. */
  editor?: string;
  /** --vscode convenience flag. */
  vscode?: boolean;
}

/** Resolve the editor command from flags, then env, falling back to vi. */
export function resolveEditorCommand(
  opts: EditOptions = {},
  env: Record<string, string | undefined> = process.env,
): string {
  if (opts.vscode) return KNOWN_EDITORS.vscode!;
  if (opts.editor) {
    const key = opts.editor.trim().toLowerCase();
    return KNOWN_EDITORS[key] ?? opts.editor;
  }
  return env.EDITOR || env.VISUAL || "vi";
}

/** Open `initial` in `editorCmd`, return the saved contents. */
async function editInEditor(
  initial: string,
  ext: string,
  editorCmd: string,
): Promise<string> {
  const file = join(tmpdir(), `metahub-${randomSuffix(8)}.${ext}`);
  await Bun.write(file, initial);
  try {
    const proc = Bun.spawn([...editorCmd.split(" "), file], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
    return await Bun.file(file).text();
  } finally {
    await rm(file, { force: true });
  }
}

/** Parse a `Name: <json>` form back into a data object. */
function parseForm(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const raw = line.slice(i + 1).trim();
    if (!key) continue;
    if (raw === "") {
      out[key] = null;
      continue;
    }
    try {
      out[key] = JSON.parse(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

export interface EditResult {
  type: "document" | "record";
  id: string;
  changed: boolean;
}

/** Edit a document (markdown body) or record (field form) in the chosen editor. */
export async function runEdit(
  db: Database,
  id: string,
  opts: EditOptions = {},
): Promise<EditResult> {
  const editorCmd = resolveEditorCommand(opts);
  const doc = getDocument(db, id);
  if (doc) {
    const before = doc.body ?? "";
    const after = await editInEditor(before, "md", editorCmd);
    const changed = after !== before;
    if (changed) updateDocument(db, id, { body: after });
    return { type: "document", id, changed };
  }

  const rec = getRecord(db, id);
  if (rec) {
    const before = Object.entries(rec.values)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n");
    const after = await editInEditor(`${before}\n`, "txt", editorCmd);
    const changed = after.trim() !== before.trim();
    if (changed) updateRecord(db, id, parseForm(after));
    return { type: "record", id, changed };
  }

  throw new Error(`no such document or record: ${id}`);
}
