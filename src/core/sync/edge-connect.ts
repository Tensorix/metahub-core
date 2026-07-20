import { MhError } from "../errors.ts";
import { EXPECTED_EDGE_WORKER_VERSION, type EdgeCapability } from "./edge-config.ts";
import { httpDropHost } from "./drop-host.ts";

export type EdgeConnectionMode = "edge" | "inbox";

export interface VerifiedEdgeConnection {
  endpoint: string;
  token: string;
  version: string | undefined;
  capabilities: EdgeCapability[];
}

/** Portable connection validation shared by Bun server/CLI and the OPFS
 * browser worker. `edge` means our versioned Worker with Rooms; `inbox` keeps
 * the historical third-party protocol-host contract. */
export async function verifyEdgeConnection(
  endpointInput: string,
  tokenInput: string,
  mode: EdgeConnectionMode,
): Promise<VerifiedEdgeConnection> {
  let endpoint: string;
  try {
    const parsed = new URL(endpointInput.trim());
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost")
      throw new Error(`${mode === "edge" ? "Edge" : "Inbox"} endpoint must use HTTPS`);
    endpoint = parsed.toString().replace(/\/+$/, "");
  } catch (e) {
    throw new MhError("invalid_input", (e as Error).message || "invalid Edge endpoint");
  }
  const token = tokenInput.trim();
  if (!token) throw new MhError("invalid_input", "owner token is required");
  const host = httpDropHost(endpoint, token);
  const health = mode === "edge" ? await host.ownerHealth() : await host.health();
  if (!health.ok)
    throw new MhError(
      "network",
      `${mode === "edge" ? "Edge" : "Inbox host"} at ${endpoint} is not healthy`,
    );
  if (mode === "edge" && health.version !== EXPECTED_EDGE_WORKER_VERSION)
    throw new MhError(
      "conflict",
      `Edge version ${health.version ?? "unknown"} is incompatible; expected ${EXPECTED_EDGE_WORKER_VERSION}`,
    );
  return {
    endpoint,
    token,
    version: health.version,
    capabilities: mode === "edge" ? ["inbox", "room"] : ["inbox"],
  };
}
