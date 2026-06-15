import { z } from "zod";
import { MhError } from "../errors.ts";
import { errorResponse, type Route, type RouteCtx } from "./routes.ts";
import {
  PairRequestSchema,
  PairResponseSchema,
  PAIR_PATH,
  type PairRequest,
} from "./protocol.ts";
import {
  generatePairingCode,
  handlePairRequest,
  performPairing,
  listGrants,
  revokeGrant,
} from "./pairing.ts";
import {
  listPeers,
  removePeer,
  setPeerEnabled,
  setPeerLabel,
  syncPeer,
  addAndSyncStoragePeer,
} from "./peers.ts";
import { putBucketCors } from "./storage-s3-bun.ts";
import type { S3Config } from "./storage.ts";

// Peer pairing + management API. Mirrors the `mh config peer` CLI; the WebUI
// settings page calls these. POST /api/pair is the cross-device handshake
// endpoint (exempt from the master-token gate in server.ts — it authenticates
// via the one-time code inside handlePairRequest). Everything else is gated by
// the master token like the rest of /api/*.

// --- schemas (drive /docs; intentionally loose) -----------------------------

const PeerSchema = z.object({
  url: z.string(),
  pull_cursor: z.number(),
  push_cursor: z.number(),
  token: z.string().nullable(),
  label: z.string().nullable(),
  node_id: z.string().nullable(),
  enabled: z.number(),
  last_sync_at: z.number().nullable(),
  last_status: z.string().nullable(),
  last_error: z.string().nullable(),
});
const PairingCodeSchema = z.object({ code: z.string(), exp: z.number() });
const AddPeerReq = z.object({
  url: z.string(),
  code: z.string(),
  self_url: z.string().optional(),
});
const AddPeerRes = z.object({ node_id: z.string(), url: z.string() });
const UpdatePeerReq = z.object({
  enabled: z.boolean().optional(),
  label: z.string().optional(),
});
const PeerSyncRes = z.object({
  url: z.string(),
  ok: z.boolean(),
  pushed: z.number().optional(),
  pulled: z.number().optional(),
  error: z.string().optional(),
});
const AddS3PeerReq = z.object({
  endpoint: z.string(),
  bucket: z.string(),
  accessKeyId: z.string(),
  secretAccessKey: z.string(),
  region: z.string().optional(),
  prefix: z.string().optional(),
  encrypt: z.boolean().optional(),
  passphrase: z.string().optional(),
  /** Browser origin(s) to open bucket CORS for, so a replica behind this server
   *  can hit the bucket directly (away-from-server sync). Usually [location.origin]. */
  corsOrigins: z.array(z.string()).optional(),
});
/** S3 peer view for the WebUI — no secrets (creds/master key stay server-side). */
const S3PeerSchema = z.object({
  url: z.string(),
  label: z.string().nullable(),
  enabled: z.number(),
  status: z.string().nullable(),
  error: z.string().nullable(),
  lastSyncAt: z.number().nullable(),
  publish: z.boolean(),
  endpoint: z.string().nullable(),
  bucket: z.string().nullable(),
  // Non-secret config bits so a browser replica can re-activate this server
  // bucket for its OWN away-sync by re-entering only the secret (the secret and
  // the encryption passphrase never leave the server). accessKeyId is the
  // non-secret half (travels in every request header), so it's safe to surface.
  region: z.string().nullable(),
  prefix: z.string().nullable(),
  accessKeyId: z.string().nullable(),
  encrypt: z.boolean(),
  virtualHostedStyle: z.boolean().nullable(),
});
const GrantSchema = z.object({
  token: z.string(),
  peer_url: z.string().nullable(),
  node_id: z.string().nullable(),
  created_at: z.number().nullable(),
});
const RevokeRes = z.object({ revoked: z.number() });
const OkSchema = z.object({ ok: z.boolean() });

// --- helpers ----------------------------------------------------------------

function need(req: Request, key: string): string {
  const v = new URL(req.url).searchParams.get(key);
  if (!v) throw new MhError("invalid_input", `missing query param: ${key}`);
  return v;
}

/** Sanitized views of this server's 's3' peers for the WebUI: status + the
 *  non-secret config a replica needs to re-attach the same bucket (endpoint,
 *  bucket, region, prefix, accessKeyId, encrypt flag, addressing style). The
 *  secretAccessKey, the encryption passphrase and the master key never leave the
 *  server — the browser re-enters the secret to activate the bucket on itself.
 *  endpoint is the full URL (the UI extracts the host for display). */
function s3PeerViews(db: RouteCtx["db"]): z.infer<typeof S3PeerSchema>[] {
  return listPeers(db)
    .filter((p) => p.kind === "s3" && p.config)
    .map((p) => {
      const c = JSON.parse(p.config!) as S3Config;
      return {
        url: p.url,
        label: p.label,
        enabled: p.enabled,
        status: p.last_status,
        error: p.last_error,
        lastSyncAt: p.last_sync_at,
        publish: c.publish === true,
        endpoint: c.endpoint || null,
        bucket: c.bucket ?? null,
        region: c.region ?? null,
        prefix: c.prefix ?? null,
        accessKeyId: c.accessKeyId ?? null,
        encrypt: c.encrypt !== false,
        virtualHostedStyle: c.virtualHostedStyle ?? null,
      };
    });
}

/** Full stored config (incl. secretAccessKey) for one 's3' peer. Unlike
 *  s3PeerViews this does NOT redact — it's served only on the master-token-gated
 *  /api/* surface to the local desktop owner so it can build a phone-enroll QR
 *  (which carries the bucket creds) for a bucket the sidecar holds. */
function s3PeerConfig(db: RouteCtx["db"], url: string): S3Config {
  const p = listPeers(db).find((x) => x.url === url && x.kind === "s3" && x.config);
  if (!p) throw new MhError("not_found", `s3 storage peer ${url} not found`);
  return JSON.parse(p.config!) as S3Config;
}

function handle(
  fn: (req: Request, ctx: RouteCtx) => unknown | Promise<unknown>,
): Route["handler"] {
  return async (req, ctx) => {
    try {
      const out = await fn(req, ctx);
      if (out instanceof Response) return out;
      return Response.json(out ?? null);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

// --- routes -----------------------------------------------------------------

export const peersRoutes: Route[] = [
  {
    method: "POST",
    path: PAIR_PATH,
    summary: "Pairing handshake: redeem a one-time code and exchange credentials",
    request: PairRequestSchema,
    response: PairResponseSchema,
    handler: handle(async (req, { db, node }) => {
      const body = (await req.json()) as PairRequest;
      return handlePairRequest(db, node, body);
    }),
  },
  {
    method: "POST",
    path: "/api/pair/new",
    summary: "Mint a one-time pairing code for another device to redeem",
    response: PairingCodeSchema,
    handler: handle((_req, { db }) => generatePairingCode(db)),
  },
  {
    method: "POST",
    path: "/api/peers/pair",
    summary: "Pair this server with a remote one using its one-time code",
    request: AddPeerReq,
    response: AddPeerRes,
    handler: handle(async (req, { db, node }) => {
      const body = (await req.json()) as z.infer<typeof AddPeerReq>;
      return performPairing(db, node, body.url, body.code, body.self_url);
    }),
  },
  {
    method: "GET",
    path: "/api/peers",
    summary: "List configured sync peers with status",
    response: z.array(PeerSchema),
    handler: handle((_req, { db }) => listPeers(db)),
  },
  {
    method: "PATCH",
    path: "/api/peer",
    summary: "Update a peer (enable/disable or label). Query: ?url=<url>",
    request: UpdatePeerReq,
    response: OkSchema,
    handler: handle(async (req, { db }) => {
      const url = need(req, "url");
      const body = (await req.json()) as z.infer<typeof UpdatePeerReq>;
      if (body.enabled != null) setPeerEnabled(db, url, body.enabled);
      if (body.label != null) setPeerLabel(db, url, body.label);
      return { ok: true };
    }),
  },
  {
    method: "DELETE",
    path: "/api/peer",
    summary: "Remove a sync peer. Query: ?url=<url>",
    response: OkSchema,
    handler: handle((req, { db }) => ({ ok: removePeer(db, need(req, "url")) })),
  },
  {
    method: "POST",
    path: "/api/peer/sync",
    summary: "Manually sync once with a peer. Query: ?url=<url>",
    response: PeerSyncRes,
    handler: handle((req, { db }) => syncPeer(db, need(req, "url"))),
  },
  {
    // Attach an S3 bucket to THIS server (the data home), making the server the
    // bucket's publisher. The WebUI calls this in origin mode so "add a cloud
    // backup" targets the node that actually holds the hub — not the browser
    // replica (which would push nothing). Creds travel over the server's TLS and
    // are stored server-side, same as the CLI path.
    method: "POST",
    path: "/api/peer/s3",
    summary: "Attach an S3 storage bucket to this server (server becomes publisher)",
    request: AddS3PeerReq,
    response: S3PeerSchema,
    handler: handle(async (req, { db }) => {
      const { corsOrigins, ...spec } = (await req.json()) as z.infer<typeof AddS3PeerReq>;
      const { url, config } = await addAndSyncStoragePeer(db, { ...spec, publish: true, priority: 100 });
      // Open the bucket's CORS for the caller's browser origin(s) so a replica
      // behind this server can talk to the bucket directly (away-from-server sync).
      // Only the server can do this (Bun PutBucketCors). Best-effort: if it doesn't
      // take, the browser's own first sync surfaces a CORS error with a fix hint.
      if (corsOrigins?.length) {
        try {
          await putBucketCors(config, corsOrigins, { merge: true });
        } catch {
          /* non-fatal: bucket is attached; retry via `mh config peer cors` */
        }
      }
      const view = s3PeerViews(db).find((v) => v.url === url);
      if (!view) throw new MhError("not_found", `storage peer ${url} missing after add`);
      return view;
    }),
  },
  {
    method: "GET",
    path: "/api/peers/s3",
    summary: "List S3 storage buckets attached to this server (no secrets)",
    response: z.array(S3PeerSchema),
    handler: handle((_req, { db }) => s3PeerViews(db)),
  },
  {
    // Full config (incl. secretAccessKey) for one bucket. Master-token gated like
    // the rest of /api/*; the local desktop owner uses it to build a phone-enroll
    // QR for a bucket the sidecar holds (the desktop renderer has no replica to
    // read the config from, and the redacted /api/peers/s3 view omits the secret).
    method: "GET",
    path: "/api/peer/s3/config",
    summary: "Full stored config (incl. secret) for one S3 bucket. Query: ?url=<url>",
    response: z.record(z.string(), z.unknown()),
    handler: handle((req, { db }) => s3PeerConfig(db, need(req, "url"))),
  },
  {
    method: "GET",
    path: "/api/grants",
    summary: "List credentials this server issued and accepts on /sync (inbound)",
    response: z.array(GrantSchema),
    handler: handle((_req, { db }) => listGrants(db)),
  },
  {
    method: "DELETE",
    path: "/api/grant",
    summary: "Revoke an issued credential by token or prefix. Query: ?token=<token>",
    response: RevokeRes,
    handler: handle((req, { db }) => ({ revoked: revokeGrant(db, need(req, "token")) })),
  },
];
