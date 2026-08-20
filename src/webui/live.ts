// Live change feed client for window (HTTP) mode: holds one SSE connection to
// /api/changes and fans server pokes out through the SAME DOM events the
// replica path uses — SYNCED_EVENT for open views, NAV_INVALIDATE for the
// sidebar/doc lists — so every existing subscriber picks up CLI/agent writes
// with zero changes. Replica mode never starts this (db-worker already emits
// "synced" after each sync round); no-origin shells have no server to stream
// from.
//
// Not EventSource: it cannot send the Bearer header, and per spec a non-200
// (e.g. 401 after token rotation) kills it without retry. authFetch gives us
// seamless 401 renewal, and the read loop below adds reconnect-with-cursor so
// changes missed while disconnected are caught up server-side (?since=).

import { authFetch, NAV_INVALIDATE } from "./api.ts";
import { SYNCED_EVENT, clientMode } from "./data/replica.ts";

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
/** Browser tabs drop the stream after this long hidden; reconnect (with
 *  ?since= catch-up) on the next visibilitychange back. Desktop windows stay
 *  connected — loopback is free and a hidden-but-alive quick window must be
 *  fresh the instant it is revealed. */
const HIDDEN_GRACE_MS = 60_000;
/** Aggregation window: a CLI batch (N records in a loop) lands as one reload. */
const DEBOUNCE_MS = 150;

let installed = false;
let generation = 0; // bumping it stops the current read loop
let looping = false;
let backoff = BACKOFF_MIN_MS;
let cursor: number | null = null;
let currentAbort: AbortController | null = null;
let hiddenTimer: number | null = null;
let connected = false;

/** Fired on `document` when the feed's connection state flips; detail is
 *  `{connected: boolean}`. The quick-board window renders it as a live dot. */
export const LIVE_STATUS_EVENT = "mh-live-status";

/** Current connection state, for initializing UI before the first flip. */
export function liveConnected(): boolean {
  return connected;
}

function setConnected(on: boolean): void {
  if (connected === on) return;
  connected = on;
  document.dispatchEvent(new CustomEvent(LIVE_STATUS_EVENT, { detail: { connected: on } }));
}

let pendDatasets = new Set<string>();
let pendRowIds = new Set<string>();
let flushTimer: number | null = null;

function flush(): void {
  flushTimer = null;
  if (!pendDatasets.size) return;
  const datasets = [...pendDatasets];
  const rowIds = [...pendRowIds];
  pendDatasets = new Set();
  pendRowIds = new Set();
  document.dispatchEvent(
    new CustomEvent(SYNCED_EVENT, {
      detail: { datasets, rowIds, pushed: 0, pulled: rowIds.length },
    }),
  );
  // Mirror replica.ts's handleEvent: nav-shaped datasets also refresh the
  // sidebar and the quick-note list.
  if (datasets.some((d) => d === "databases" || d === "documents")) {
    document.dispatchEvent(new CustomEvent(NAV_INVALIDATE));
  }
}

function queue(datasets: string[], rowIds: string[]): void {
  for (const d of datasets) pendDatasets.add(d);
  for (const r of rowIds) pendRowIds.add(r);
  flushTimer ??= window.setTimeout(flush, DEBOUNCE_MS);
}

function handleBlock(block: string): void {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue; // heartbeat comment
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return;
  let data: { cursor?: number; datasets?: string[]; rowIds?: string[] };
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    return;
  }
  backoff = BACKOFF_MIN_MS; // a parsed event proves the stream is healthy
  setConnected(true);
  if (typeof data.cursor === "number") cursor = data.cursor;
  if (event === "changes") queue(data.datasets ?? [], data.rowIds ?? []);
}

async function runLoop(gen: number): Promise<void> {
  while (gen === generation) {
    const ctrl = new AbortController();
    currentAbort = ctrl;
    try {
      const res = await authFetch(
        cursor != null ? `/api/changes?since=${cursor}` : "/api/changes",
        { signal: ctrl.signal, headers: { accept: "text/event-stream" } },
      );
      if (!res.ok || !res.body) throw new Error(`changes stream: ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          handleBlock(buf.slice(0, i));
          buf = buf.slice(i + 2);
        }
      }
    } catch {
      /* aborted or network error — fall through to the retry delay */
    }
    setConnected(false);
    if (gen !== generation) return;
    await new Promise((r) => setTimeout(r, backoff + Math.random() * 250));
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }
}

function start(): void {
  if (looping) return;
  looping = true;
  backoff = BACKOFF_MIN_MS;
  void runLoop(++generation).finally(() => {
    /* loop only returns when superseded */
  });
}

function stop(): void {
  looping = false;
  generation++;
  currentAbort?.abort();
}

function onVisibility(): void {
  if (document.hidden) {
    hiddenTimer ??= window.setTimeout(() => {
      hiddenTimer = null;
      stop();
    }, HIDDEN_GRACE_MS);
  } else {
    if (hiddenTimer != null) {
      clearTimeout(hiddenTimer);
      hiddenTimer = null;
    }
    start(); // no-op if still connected; catch-up via ?since= otherwise
  }
}

/** Idempotent. Call once the UI is showing live server data (Root entering app
 *  mode, quick windows on mount). Decides from clientMode() whether a stream
 *  is warranted; safe to call in every mode. */
export function ensureLive(): void {
  if (installed) return;
  const mode = clientMode();
  // Replica holds get remote changes through the sync pipeline's own "synced"
  // events; no-origin has no server. Only the thin online window needs a feed.
  if (mode.dataHome !== "server" || mode.hold !== "window") return;
  installed = true;
  start();
  if (mode.surface === "web") document.addEventListener("visibilitychange", onVisibility);
}

/** Tear the feed down (tests; not used by the app — the stream lives as long
 *  as the tab). Resets state so ensureLive() can start fresh. */
export function stopLive(): void {
  installed = false;
  stop();
  setConnected(false);
  document.removeEventListener("visibilitychange", onVisibility);
  if (hiddenTimer != null) clearTimeout(hiddenTimer);
  hiddenTimer = null;
  if (flushTimer != null) clearTimeout(flushTimer);
  flushTimer = null;
  pendDatasets = new Set();
  pendRowIds = new Set();
  cursor = null;
}
