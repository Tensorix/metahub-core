import type { RoomPeerConfig } from "./peers.ts";

/** Guest-facing Room URL shared by Bun services and the browser worker. */
export function roomUrlOf(config: Pick<RoomPeerConfig, "base" | "slug">): string {
  return `${config.base.replace(/\/+$/, "")}/r/${config.slug}/`;
}
