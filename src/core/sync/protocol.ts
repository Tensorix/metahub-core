import type { Change } from "../crdt.ts";

export interface SyncRequest {
  node_id: string;
  since: number; // server cursor the client last pulled
  changes: Change[]; // client's changes to push
}

export interface SyncResponse {
  node_id: string;
  changes: Change[]; // server changes after `since`
  cursor: number; // new server cursor for the client to store
}

export const SYNC_PATH = "/sync";
export const HEALTH_PATH = "/health";
