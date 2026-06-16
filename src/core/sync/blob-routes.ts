import { z } from "zod";
import { errorResponse, type Route, type RouteCtx } from "./routes.ts";
import { MhError } from "../errors.ts";
import { putBlob, getBlob } from "../cache.ts";
import { recordBlob, touchBlob, resolveBlob, blobContentType } from "../blobs.ts";
import { inferContentType } from "../sites-core.ts";

// Content-addressed blob byte transport (document images / large files). The
// oplog carries only the hash; bytes move on demand over this endpoint and the
// bucket (see blobs.ts resolveBlob). Reference lives wherever the caller put it
// (doc markdown `/blob/<hash>` or a site_files row) — this layer is hash-only.

function ext(ct: string): string {
  const t = ct.toLowerCase().split(";")[0]!.trim();
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/avif": "avif",
    "image/svg+xml": "svg",
    "application/pdf": "pdf",
  };
  return map[t] ?? "";
}

/**
 * Serve `GET /blob/<hash>[.ext]`. Default: resolve on demand (local cache → peers
 * → bucket) so a browser <img> or a far node gets the bytes even if this node
 * hadn't cached them. `?local=1` (used by peer-to-peer resolution) serves only
 * what we already hold, so cross-node fetches can't loop. Content-addressed →
 * immutable cache. Returns null when the path isn't a blob URL (so the caller
 * falls through to the next matcher).
 */
export async function serveBlob(req: Request, ctx: RouteCtx): Promise<Response | null> {
  const url = new URL(req.url);
  const rest = decodeURIComponent(url.pathname.slice("/blob/".length));
  if (!rest) return null;
  const dot = rest.indexOf(".");
  const hash = (dot >= 0 ? rest.slice(0, dot) : rest).toLowerCase();
  if (!/^[0-9a-f]{16,64}$/.test(hash)) return null;

  const localOnly = url.searchParams.get("local") === "1";
  const bytes = localOnly ? await getBlob(hash) : await resolveBlob(ctx.db, hash);
  if (!bytes) return new Response("not found", { status: 404 });
  if (localOnly) touchBlob(ctx.db, hash);

  const ct = dot >= 0 ? inferContentType(rest) : blobContentType(ctx.db, hash) ?? "application/octet-stream";
  // Copy into a fresh ArrayBuffer-backed view (same shape as sites-serve.ts) so
  // the body type is a plain BodyInit.
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  return new Response(body.buffer, {
    headers: { "content-type": ct, "cache-control": "public, max-age=31536000, immutable" },
  });
}

const BlobUploadSchema = z.object({
  hash: z.string(),
  size: z.number(),
  content_type: z.string(),
  url: z.string().describe("Stable served path, e.g. /blob/<hash>.png"),
});

export const blobRoutes: Route[] = [
  {
    method: "POST",
    path: "/api/blob",
    summary:
      "Upload a content-addressed blob (document image / large file); raw bytes in the body, " +
      "content-type header sets the type. Returns its hash + stable /blob/<hash>.<ext> URL. " +
      "Unlike /api/site/file it creates NO reference row — the caller (e.g. doc markdown) holds the reference.",
    response: BlobUploadSchema,
    handler: async (req, { db }) => {
      try {
        const ct = req.headers.get("content-type") || "application/octet-stream";
        const bytes = new Uint8Array(await req.arrayBuffer());
        if (!bytes.byteLength) throw new MhError("invalid_input", "empty blob body");
        const info = await putBlob(bytes);
        recordBlob(db, info.hash, info.size, ct); // produced here → pending=1
        const e = ext(ct);
        return Response.json({
          hash: info.hash,
          size: info.size,
          content_type: ct,
          url: `/blob/${info.hash}${e ? "." + e : ""}`,
        });
      } catch (err) {
        return errorResponse(err);
      }
    },
  },
];
