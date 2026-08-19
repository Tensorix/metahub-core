// live.ts needs a DOM (document events, window timers, localStorage). Register
// happy-dom for this file only — see markdown.dom.test.ts for why it must be
// unregistered afterwards.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

import { afterAll, expect, test } from "bun:test";
import { ensureLive, stopLive } from "./live.ts";
import { SYNCED_EVENT } from "./data/replica.ts";
import { NAV_INVALIDATE } from "./api.ts";

const ORIGINAL_FETCH = globalThis.fetch;
const enc = new TextEncoder();

const requests: string[] = [];
let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  requests.push(url);
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}) as typeof fetch;

afterAll(() => {
  stopLive();
  globalThis.fetch = ORIGINAL_FETCH;
  GlobalRegistrator.unregister();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("condition not met in time");
    await sleep(10);
  }
}

function push(text: string): void {
  controller!.enqueue(enc.encode(text));
}

test("pokes fan out as SYNCED_EVENT (+NAV_INVALIDATE), aggregated per debounce window", async () => {
  const synced: any[] = [];
  let navs = 0;
  document.addEventListener(SYNCED_EVENT, (e) => synced.push((e as CustomEvent).detail));
  document.addEventListener(NAV_INVALIDATE, () => navs++);

  ensureLive();
  await until(() => controller != null);
  expect(requests[0]).toBe("/api/changes"); // first connect: no cursor yet

  push('event: hello\ndata: {"cursor":5}\n\n');
  push(": hb\n\n"); // heartbeat must be ignored
  // Two pokes inside one debounce window → one SYNCED_EVENT with the union.
  push('event: changes\ndata: {"datasets":["records"],"rowIds":["r1"],"cursor":6,"truncated":false}\n\n');
  push('event: changes\ndata: {"datasets":["records","documents"],"rowIds":["r2","d1"],"cursor":7,"truncated":false}\n\n');

  await until(() => synced.length > 0);
  expect(synced.length).toBe(1);
  expect(synced[0].datasets.sort()).toEqual(["documents", "records"]);
  expect(synced[0].rowIds.sort()).toEqual(["d1", "r1", "r2"]);
  expect(navs).toBe(1); // documents touched → sidebar invalidated

  // Server restart: stream ends → read loop sees `done`, retries with backoff,
  // and the reconnect carries the last cursor.
  const c1 = controller!;
  controller = null;
  c1.close();
  await until(() => requests.length >= 2, 4000);
  expect(requests[1]).toBe("/api/changes?since=7");
});
