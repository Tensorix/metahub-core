import { defineCommand } from "citty";
import { search } from "../../core/search.ts";
import { print, table, guard } from "../output.ts";
import { FRESH_ARGS, freshDb } from "../fresh.ts";

export default defineCommand({
  meta: { name: "search", description: "Full-text search across documents and records" },
  args: {
    query: { type: "positional", required: true, description: "Search query" },
    limit: { type: "string", description: "Max hits" },
    ...FRESH_ARGS,
  },
  run: guard(async (args) => {
    const hits = search(await freshDb(args), args.query, {
      limit: args.limit != null ? Number(args.limit) : undefined,
    });
    print({ query: args.query, hits }, () =>
      table(hits.map((h) => ({ type: h.type, id: h.id, snippet: h.snippet }))),
    );
  }),
});
