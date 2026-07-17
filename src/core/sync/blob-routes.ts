import { z } from "zod";
import { errorResponse, type Route, type RouteCtx } from "./routes.ts";
import { safeDecode } from "./http-util.ts";
import { MhError } from "../errors.ts";
import { putBlob, getBlob, blobExists } from "../cache.ts";
import { recordBlob, touchBlob, resolveBlob, blobContentType } from "../blobs.ts";
import { inferContentType } from "../sites-core.ts";
import { MAX_BLOB_UPLOAD_BYTES } from "../config.ts";

// Content-addressed blob byte transport (document images / large files). The
// oplog carries only the hash; bytes move on demand over this endpoint and the
// bucket (see blobs.ts resolveBlob). Reference lives wherever the caller put it
// (doc markdown `/blob/<hash>` or a site_files row) — this layer is hash-only.

/** A content-addressed blob hash: canonical 32-hex or legacy 64-hex (any length
 *  in between for forward-compat). The single source of truth for "is this a hash
 *  shape we serve" — used by both GET /blob/<hash> and the /api/blobs/has probe so
 *  the latter never feeds peer-supplied path fragments to the filesystem. */
const HASH_RE = /^[0-9a-f]{16,64}$/;
/** Cap a presence probe so a peer can't fan out an unbounded existence sweep. */
const MAX_HAS_HASHES = 1024;

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
    // Media: give the served URL a real extension so the byte route can infer
    // the right content-type and <video>/<audio> play (see sites-core MIME).
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/ogg": "ogv",
    "video/quicktime": "mov",
    "video/x-matroska": "mkv",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/flac": "flac",
    "audio/opus": "opus",
    "audio/webm": "weba",
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
  // safeDecode, not bare decodeURIComponent: a malformed %-escape must fall
  // through to the 404 path, not escape the handler as an uncaught URIError
  // (Bun.serve has no error handler — it would surface as a generic 500).
  const rest = safeDecode(url.pathname.slice("/blob/".length));
  if (!rest) return null;
  const dot = rest.indexOf(".");
  const hash = (dot >= 0 ? rest.slice(0, dot) : rest).toLowerCase();
  if (!HASH_RE.test(hash)) return null;

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

const BlobHasReq = z.object({
  hashes: z.array(z.string()).describe("Candidate blob hashes to check for presence."),
});
const BlobHasRes = z.object({
  has: z.array(z.string()).describe("Subset of the requested hashes this node holds."),
});

export const blobRoutes: Route[] = [
  {
    method: "POST",
    path: "/api/blobs/has",
    summary:
      "Given candidate blob hashes, return the subset this node durably holds. A peer's " +
      "clear-presence verify calls this on a designated full-blob device anchor to confirm " +
      "the anchor still holds a blob before the peer drops its own cached copy. " +
      "Authorized like /blob/ byte transport (master token or per-peer grant).",
    request: BlobHasReq,
    response: BlobHasRes,
    handler: async (req, _ctx) => {
      try {
        const body = (await req.json()) as { hashes?: unknown };
        // Validate the shape and cap the count BEFORE touching the filesystem:
        // `want` is peer-supplied and flows into blobExists → blobPath → join,
        // so an unchecked entry like "../../etc/passwd" would be a path-traversal
        // existence oracle, and an unbounded list a fan-out of exists() calls.
        const want = (Array.isArray(body.hashes) ? body.hashes : [])
          .filter((h): h is string => typeof h === "string" && HASH_RE.test(h))
          .slice(0, MAX_HAS_HASHES);
        // Disk is the truth: check each requested hash's bytes actually exist on
        // disk rather than trusting the ledger (which only grows — a row can
        // outlive its file after a crash, compaction GC, or manual cache wipe).
        // A peer drops its own last copy based on this answer, so a false "yes"
        // risks total loss.
        const present = await Promise.all(want.map((h) => blobExists(h)));
        return Response.json({ has: want.filter((_h, i) => present[i]) });
      } catch (err) {
        return errorResponse(err);
      }
    },
  },
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
        // Reject oversize uploads from the Content-Length header BEFORE buffering
        // the body, so a huge file can't blow up memory via arrayBuffer().
        const declared = Number(req.headers.get("content-length") || 0);
        if (declared > MAX_BLOB_UPLOAD_BYTES)
          throw new MhError("invalid_input", `blob too large (max ${MAX_BLOB_UPLOAD_BYTES} bytes)`);
        const bytes = new Uint8Array(await req.arrayBuffer());
        if (!bytes.byteLength) throw new MhError("invalid_input", "empty blob body");
        // Re-check the actual size (a chunked / spoofed Content-Length can lie).
        if (bytes.byteLength > MAX_BLOB_UPLOAD_BYTES)
          throw new MhError("invalid_input", `blob too large (max ${MAX_BLOB_UPLOAD_BYTES} bytes)`);
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
