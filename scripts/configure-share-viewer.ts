// The D1 ID is environment-specific, never a hardcoded production binding.
// Run after build:share-viewer, before migrations / pages deploy.
import { resolve } from "node:path";

const databaseId = process.env.SHARE_LINKS_DATABASE_ID;
if (
  !databaseId ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    databaseId,
  )
) {
  throw new Error(
    "Set SHARE_LINKS_DATABASE_ID to the D1 database UUID (wrangler d1 create metahub-share-links).",
  );
}
await Bun.write(
  "dist/wrangler.json",
  JSON.stringify(
    {
      name: "metahub-share",
      compatibility_date: "2026-10-01",
      pages_build_output_dir: resolve("dist/share-viewer"),
      d1_databases: [
        {
          binding: "SHARE_LINKS",
          database_name: "metahub-share-links",
          database_id: databaseId,
          preview_database_id: "SHARE_LINKS",
          migrations_dir: resolve("deploy/share-viewer/migrations"),
        },
      ],
    },
    null,
    2,
  ),
);
