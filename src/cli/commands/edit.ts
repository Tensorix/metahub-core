import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import { runEdit } from "../editor.ts";
import { print, guard } from "../output.ts";

export default defineCommand({
  meta: { name: "edit", description: "Edit a document or record in $EDITOR" },
  args: { id: { type: "positional", required: true, description: "Document or record id" } },
  run: guard(async (args) => {
    const r = await runEdit(openMetahub(), args.id);
    print(r, () => `${r.changed ? "edited" : "unchanged"} ${r.type} ${r.id}`);
  }),
});
