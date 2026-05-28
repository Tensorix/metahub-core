import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import { search } from "../../core/search.ts";
import { print, table, guard } from "../output.ts";

export default defineCommand({
  meta: { name: "search", description: "Full-text search across documents and records" },
  args: {
    query: { type: "positional", required: true, description: "Search query" },
    limit: { type: "string", description: "Max hits" },
  },
  run: guard((args) => {
    const hits = search(openMetahub(), args.query, {
      limit: args.limit != null ? Number(args.limit) : undefined,
    });
    print({ query: args.query, hits }, () =>
      table(hits.map((h) => ({ type: h.type, id: h.id, snippet: h.snippet }))),
    );
  }),
});
