import { defineCommand } from "citty";
import { basename, extname } from "node:path";
import { openMetahub } from "../../core/db.ts";
import { putBlob } from "../../core/cache.ts";
import { recordBlob, resolveBlob } from "../../core/blobs.ts";
import { inferContentType } from "../../core/sites-core.ts";
import { MhError } from "../../core/errors.ts";
import { print, guard } from "../output.ts";

// Content-addressed blob bytes for document media (images / video / audio /
// files). The WebUI uploads over HTTP /api/blob; this gives the CLI agent the
// same in/out: `add` ingests a local file and prints a /blob/<hash> URL to embed
// in a doc body, `get` resolves a hash back to bytes (local cache → peers →
// bucket). A freshly added blob is anchored against GC only once a live document
// references its /blob/<hash> — embed the URL promptly.

const HASH_RE = /^[0-9a-f]{16,64}$/;

function kindOf(ct: string): "image" | "video" | "audio" | "file" {
  const m = ct.toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  return "file";
}

const add = defineCommand({
  meta: {
    name: "add",
    description:
      "Store a local file as a content-addressed blob and print its stable " +
      "/blob/<hash>.<ext> URL (and a ready-to-embed Markdown line) for a document.",
  },
  args: {
    file: { type: "positional", required: true, description: "Path to the file to ingest" },
    name: { type: "string", description: "Display name / image alt (defaults to the filename)" },
  },
  run: guard(async (args) => {
    const path = String(args.file);
    const f = Bun.file(path);
    if (!(await f.exists())) throw new MhError("not_found", `file not found: ${path}`);
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (!bytes.byteLength) throw new MhError("invalid_input", "file is empty");

    const ct = inferContentType(path);
    const info = await putBlob(bytes);
    const db = openMetahub();
    recordBlob(db, info.hash, info.size, ct); // produced here → pending=1

    const ext = extname(path).slice(1).toLowerCase();
    const url = `/blob/${info.hash}${ext ? "." + ext : ""}`;
    const name = (typeof args.name === "string" && args.name) || basename(path);
    const kind = kindOf(ct);
    // Media embeds as an image-style link (kind inferred from the extension on
    // read); a generic file embeds as a plain /blob link with its byte size.
    const markdown = kind === "file" ? `[${name}](${url} "${info.size}")` : `![${name}](${url})`;

    print({ hash: info.hash, size: info.size, content_type: ct, url, kind, markdown }, () =>
      [`stored ${kind} blob ${info.hash} (${info.size} bytes, ${ct})`, `url:   ${url}`, `embed: ${markdown}`].join("\n"),
    );
  }),
});

const get = defineCommand({
  meta: {
    name: "get",
    description:
      "Resolve a blob's bytes by hash (local cache → peers → bucket). Writes to " +
      "--out, or raw bytes to stdout (pipe-friendly).",
  },
  args: {
    hash: { type: "positional", required: true, description: "Blob hash (32 or 64 hex; a .ext suffix is tolerated)" },
    out: { type: "string", description: "Write bytes to this file (default: stdout)" },
  },
  run: guard(async (args) => {
    const hash = String(args.hash).toLowerCase().replace(/\.[a-z0-9]+$/i, "");
    if (!HASH_RE.test(hash)) throw new MhError("invalid_input", `invalid blob hash: ${args.hash}`);
    const db = openMetahub();
    const bytes = await resolveBlob(db, hash);
    if (!bytes) throw new MhError("not_found", `blob not available: ${hash}`);
    const out = typeof args.out === "string" ? args.out : "";
    if (out) {
      await Bun.write(out, bytes);
      print({ hash, size: bytes.byteLength, out }, () => `wrote ${bytes.byteLength} bytes → ${out}`);
    } else {
      process.stdout.write(bytes); // raw bytes, no envelope — safe to pipe/redirect
    }
  }),
});

export default defineCommand({
  meta: {
    name: "blob",
    description:
      "Content-addressed blobs for document media. `add` ingests a local file " +
      "(prints a /blob/<hash> URL to embed); `get` extracts a blob's bytes by hash.",
  },
  subCommands: { add, get },
});
