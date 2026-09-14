import { useEffect, useState } from "preact/hooks";
import { api, SHARES_CHANGED } from "./api.ts";

let ids = new Set<string>();
let state: "empty" | "fresh" | "stale" = "empty";
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function refresh(): Promise<void> {
  if (inflight) return inflight;
  inflight = api
    .listLocalShares()
    .then((list) => {
      ids = new Set(list.map((s) => s.target_id));
      state = "fresh";
      for (const fn of [...listeners]) fn();
    })
    .catch(() => undefined)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function sharedTargets(): Set<string> {
  if (state !== "fresh") void refresh();
  return ids;
}

export function onSharedTargetsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useSharedTargets(): Set<string> {
  const [cur, setCur] = useState(() => sharedTargets());
  useEffect(() => onSharedTargetsChange(() => setCur(ids)), []);
  return cur;
}

if (typeof document !== "undefined") {
  document.addEventListener(SHARES_CHANGED, () => {
    state = "stale";
    void refresh();
  });
}
