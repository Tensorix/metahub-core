import { Database } from "bun:sqlite";
import { createShareLinksHandler } from "../../src/workers/share-links.ts";

export async function shareLinkApi(now = Date.now) {
  const db = new Database(":memory:");
  db.exec(
    await Bun.file(
      new URL(
        "../../deploy/share-viewer/migrations/0001_share_links.sql",
        import.meta.url,
      ),
    ).text(),
  );
  const handle = createShareLinksHandler(
    {
      first: async <T>(sql: string, ...args: unknown[]) =>
        db.query(sql).get(...(args as never[])) as T | null,
      run: async (sql: string, ...args: unknown[]) => {
        db.query(sql).run(...(args as never[]));
      },
    },
    now,
  );
  return { db, handle };
}

export function descriptor(now = Date.now()) {
  const date = new Date(Math.floor(now / 1000) * 1000)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return {
    v: 1 as const,
    manifestUrl: `https://bucket.example/shares/test/manifest.bin?X-Amz-Date=${date}&X-Amz-Expires=3600&X-Amz-Signature=${"a".repeat(64)}`,
    expiresAt: Math.floor(now / 1000) * 1000 + 3600_000,
  };
}
