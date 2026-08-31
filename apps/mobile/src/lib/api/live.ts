// SSE live-change feed — port of src/webui/live.ts to React Native.
// expo/fetch (WinterCG) streams response bodies on both platforms; RN's
// global fetch historically buffers, so don't swap it back.
// DOM events become a tiny in-module emitter; visibilitychange becomes
// AppState (background → stop now and keep the cursor; the radio dies anyway).

import { fetch as expoFetch } from "expo/fetch";
import { AppState, type AppStateStatus } from "react-native";

import type { MobileApi } from "./mobile-api";

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
/** A CLI batch (N records in a loop) lands as one reload. */
const DEBOUNCE_MS = 150;
/** Server heartbeats every 8s; a read stalled 25s means the mobile radio died
 *  under us without an error — abort and reconnect with ?since= catch-up. */
const READ_STALL_MS = 25_000;

export interface LiveChange {
  datasets: string[];
  rowIds: string[];
  /** True when the server capped rowIds (500) — treat as "anything may have
   *  changed in these datasets" and refetch unconditionally. */
  truncated: boolean;
}

type ChangeListener = (change: LiveChange) => void;
type StatusListener = (connected: boolean) => void;

export class LiveFeed {
  private api: MobileApi;
  private generation = 0;
  private looping = false;
  private backoff = BACKOFF_MIN_MS;
  private cursor: number | null = null;
  private currentAbort: AbortController | null = null;
  private connectedFlag = false;

  private pendDatasets = new Set<string>();
  private pendRowIds = new Set<string>();
  private pendTruncated = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private changeListeners = new Set<ChangeListener>();
  private statusListeners = new Set<StatusListener>();
  private appStateSub: { remove(): void } | null = null;

  constructor(api: MobileApi) {
    this.api = api;
  }

  onChange(fn: ChangeListener): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  get connected(): boolean {
    return this.connectedFlag;
  }

  install(): void {
    if (this.appStateSub) return;
    this.appStateSub = AppState.addEventListener("change", this.onAppState);
    this.start();
  }

  destroy(): void {
    this.appStateSub?.remove();
    this.appStateSub = null;
    this.stop();
    if (this.flushTimer != null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pendDatasets = new Set();
    this.pendRowIds = new Set();
    this.pendTruncated = false;
    this.changeListeners.clear();
    this.statusListeners.clear();
  }

  private onAppState = (state: AppStateStatus): void => {
    if (state === "active") this.start();
    else if (state === "background") this.stop();
  };

  private setConnected(on: boolean): void {
    if (this.connectedFlag === on) return;
    this.connectedFlag = on;
    for (const fn of this.statusListeners) fn(on);
  }

  private flush = (): void => {
    this.flushTimer = null;
    if (!this.pendDatasets.size) return;
    const change: LiveChange = {
      datasets: [...this.pendDatasets],
      rowIds: [...this.pendRowIds],
      truncated: this.pendTruncated,
    };
    this.pendDatasets = new Set();
    this.pendRowIds = new Set();
    this.pendTruncated = false;
    for (const fn of this.changeListeners) fn(change);
  };

  private queue(datasets: string[], rowIds: string[], truncated: boolean): void {
    for (const d of datasets) this.pendDatasets.add(d);
    for (const r of rowIds) this.pendRowIds.add(r);
    if (truncated) this.pendTruncated = true;
    this.flushTimer ??= setTimeout(this.flush, DEBOUNCE_MS);
  }

  private handleBlock(block: string): void {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue; // heartbeat comment
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    let data: {
      cursor?: number;
      datasets?: string[];
      rowIds?: string[];
      truncated?: boolean;
    };
    try {
      data = JSON.parse(dataLines.join("\n"));
    } catch {
      return;
    }
    this.backoff = BACKOFF_MIN_MS; // a parsed event proves the stream is healthy
    this.setConnected(true);
    if (typeof data.cursor === "number") this.cursor = data.cursor;
    if (event === "changes")
      this.queue(data.datasets ?? [], data.rowIds ?? [], data.truncated === true);
  }

  private async runLoop(gen: number): Promise<void> {
    while (gen === this.generation) {
      const ctrl = new AbortController();
      this.currentAbort = ctrl;
      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        const path =
          this.cursor != null ? `/api/changes?since=${this.cursor}` : "/api/changes";
        const res = await expoFetch(this.api.baseUrl + path, {
          signal: ctrl.signal,
          headers: {
            accept: "text/event-stream",
            authorization: `Bearer ${this.api.token}`,
          },
        });
        if (res.status === 401) {
          // Stream can't ride authFetch (needs expo/fetch for streaming);
          // rotate the token here and let the retry loop reconnect.
          await this.api.renew().catch(() => {});
          throw new Error("changes stream: 401");
        }
        if (!res.ok || !res.body) throw new Error(`changes stream: ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          stallTimer = setTimeout(() => ctrl.abort(), READ_STALL_MS);
          const { done, value } = await reader.read();
          clearTimeout(stallTimer);
          stallTimer = null;
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            this.handleBlock(buf.slice(0, i));
            buf = buf.slice(i + 2);
          }
        }
      } catch {
        /* aborted or network error — fall through to the retry delay */
      } finally {
        if (stallTimer != null) clearTimeout(stallTimer);
      }
      this.setConnected(false);
      if (gen !== this.generation) return;
      await new Promise((r) => setTimeout(r, this.backoff + Math.random() * 250));
      this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    }
  }

  private start(): void {
    if (this.looping) return;
    this.looping = true;
    this.backoff = BACKOFF_MIN_MS;
    const gen = ++this.generation;
    void this.runLoop(gen).finally(() => {
      // A superseded loop exiting late (it may finish a backoff sleep after
      // stop()+start()) must not clear the flag of the loop that replaced it.
      if (gen === this.generation) this.looping = false;
    });
  }

  private stop(): void {
    this.looping = false;
    this.generation++;
    this.currentAbort?.abort();
    this.setConnected(false);
  }
}
