import { createShareLinksHandler } from "./share-links.ts";

interface Statement {
  bind(...args: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}
interface Env {
  SHARE_LINKS?: { prepare(sql: string): Statement };
  ASSETS: { fetch(req: Request): Promise<Response> };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      if (!env.SHARE_LINKS)
        return Response.json(
          { error: "short_links_not_configured" },
          {
            status: 503,
            headers: {
              "cache-control": "no-store",
              "access-control-allow-origin": "*",
            },
          },
        );
      const db = env.SHARE_LINKS;
      return createShareLinksHandler({
        first: <T>(sql: string, ...args: unknown[]) =>
          db
            .prepare(sql)
            .bind(...args)
            .first<T>(),
        run: async (sql: string, ...args: unknown[]) => {
          await db
            .prepare(sql)
            .bind(...args)
            .run();
        },
      })(req);
    }
    return env.ASSETS.fetch(req);
  },
};
