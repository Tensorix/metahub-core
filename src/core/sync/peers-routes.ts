import { z } from "zod";
import type { Route, RouteCtx } from "./routes.ts";
import {
  PairRequestSchema,
  PairResponseSchema,
  PAIR_PATH,
  type PairRequest,
} from "./protocol.ts";
import { generatePairingCode, handlePairRequest, performPairing } from "./pairing.ts";
import {
  listPeers,
  removePeer,
  setPeerEnabled,
  setPeerLabel,
  syncPeer,
} from "./peers.ts";

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
const OkSchema = z.object({ ok: z.boolean() });

// --- helpers ----------------------------------------------------------------

function need(req: Request, key: string): string {
  const v = new URL(req.url).searchParams.get(key);
  if (!v) throw new Error(`missing query param: ${key}`);
  return v;
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
      return Response.json({ error: (e as Error).message }, { status: 400 });
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
];
