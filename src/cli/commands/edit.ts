import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import { runEdit } from "../editor.ts";
import { print, guard } from "../output.ts";

export default defineCommand({
  meta: { name: "edit", description: "Edit a document or record in your editor" },
  args: {
    id: { type: "positional", required: true, description: "Document or record id" },
    vscode: { type: "boolean", description: "Open in VS Code (code --wait)" },
    editor: {
      type: "string",
      description:
        "Editor: known name (vscode, cursor, zed, sublime, vim, nvim, nano, emacs) or a raw command",
    },
  },
  run: guard(async (args) => {
    const r = await runEdit(openMetahub(), args.id, {
      editor: args.editor,
      vscode: args.vscode,
    });
    print(r, () => `${r.changed ? "edited" : "unchanged"} ${r.type} ${r.id}`);
  }),
});
