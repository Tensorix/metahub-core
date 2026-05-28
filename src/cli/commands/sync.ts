import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import { syncWithPeer } from "../../core/sync/client.ts";
import { print, guard } from "../output.ts";

export default defineCommand({
  meta: { name: "sync", description: "Push/pull a round against a sync server" },
  args: {
    url: { type: "positional", required: true, description: "Server URL, e.g. http://host:7777" },
  },
  run: guard(async (args) => {
    const result = await syncWithPeer(openMetahub(), args.url);
    print(result, () => `pushed ${result.pushed}, pulled ${result.pulled}`);
  }),
});
