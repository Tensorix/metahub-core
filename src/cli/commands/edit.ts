import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import { resolveRef } from "../../core/resolve.ts";
import { runEdit } from "../editor.ts";
import { print, guard } from "../output.ts";

export default defineCommand({
  meta: { name: "edit", description: "Edit a document or record in your editor" },
  args: {
    id: { type: "positional", required: true, description: "Document or record ref (id/prefix/name)" },
    vscode: { type: "boolean", description: "Open in VS Code (code --wait)" },
    editor: {
      type: "string",
      description:
        "Editor: known name (vscode, cursor, zed, sublime, vim, nvim, nano, emacs) or a raw command",
    },
  },
  run: guard(async (args) => {
    const db = openMetahub();
    const r = await runEdit(db, resolveRef(db, args.id), {
      editor: args.editor,
      vscode: args.vscode,
    });
    print(r, () => `${r.changed ? "edited" : "unchanged"} ${r.type} ${r.id}`);
  }),
});
