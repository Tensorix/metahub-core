import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import { getNodeId } from "../../core/node.ts";
import { metahubHome, cacheDir } from "../../core/paths.ts";
import { print } from "../output.ts";

export default defineCommand({
  meta: {
    name: "init",
    description: "Create ~/.metahub (SQLite database + cache directory)",
  },
  run() {
    const db = openMetahub();
    const nodeId = getNodeId(db);
    const home = metahubHome();
    print({ ok: true, home, cache: cacheDir(), nodeId }, () =>
      `Initialized ${home} (node ${nodeId})`,
    );
  },
});
