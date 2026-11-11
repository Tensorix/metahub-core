import { expect, test } from "bun:test";
import { createSearchFeed } from "./search-feed";
import type { SearchHitInfo } from "./sdk";
const hit = (id: string) =>
  ({ id, type: "document", title: id, snippet: "" }) as SearchHitInfo;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test("appends results once despite duplicate end-reached events and stops at the end", async () => {
  const tail = deferred<{ hits: SearchHitInfo[]; hasMore: boolean }>();
  const offsets: number[] = [];
  const feed = createSearchFeed(async (offset) => {
    offsets.push(offset);
    return offset
      ? tail.promise
      : { hits: [hit("a"), hit("b")], hasMore: true };
  });
  await feed.reload();
  const next = feed.loadMore();
  await feed.loadMore();
  expect(offsets).toEqual([0, 2]);
  tail.resolve({ hits: [hit("b"), hit("c")], hasMore: false });
  await next;
  expect(feed.snapshot().hits.map((h) => h.id)).toEqual(["a", "b", "c"]);
  await feed.loadMore();
  expect(offsets).toEqual([0, 2]);
});

test("failed tail keeps existing rows and retries the same offset", async () => {
  let fail = true;
  const offsets: number[] = [];
  const feed = createSearchFeed(async (offset) => {
    offsets.push(offset);
    if (offset && fail) throw Error("offline");
    return { hits: [hit(offset ? "b" : "a")], hasMore: !offset };
  });
  await feed.reload();
  await feed.loadMore();
  expect(feed.snapshot().hits.map((h) => h.id)).toEqual(["a"]);
  expect(feed.snapshot().moreError?.message).toBe("offline");
  fail = false;
  await feed.loadMore();
  expect(offsets).toEqual([0, 1, 1]);
  expect(feed.snapshot().hits.map((h) => h.id)).toEqual(["a", "b"]);
});

test("discarding a query prevents a late response from publishing", async () => {
  const late = deferred<{ hits: SearchHitInfo[]; hasMore: boolean }>();
  const feed = createSearchFeed(() => late.promise);
  const task = feed.reload();
  feed.dispose();
  const snapshot = feed.snapshot();
  late.resolve({ hits: [hit("old")], hasMore: true });
  await task;
  expect(feed.snapshot()).toBe(snapshot);
});

test("refresh supersedes an in-flight tail and resets its offset", async () => {
  const late = deferred<{ hits: SearchHitInfo[]; hasMore: boolean }>();
  let version = "a";
  const feed = createSearchFeed(async (offset) =>
    offset ? late.promise : { hits: [hit(version)], hasMore: true },
  );
  await feed.reload();
  const next = feed.loadMore();
  version = "new";
  await feed.reload();
  late.resolve({ hits: [hit("stale")], hasMore: false });
  await next;
  expect(feed.snapshot().hits.map((h) => h.id)).toEqual(["new"]);
  expect(feed.snapshot().hasMore).toBe(true);
});

test("empty batches cannot create an automatic request loop", async () => {
  const feed = createSearchFeed(async () => ({ hits: [], hasMore: true }));
  await feed.reload();
  expect(feed.snapshot().hasMore).toBe(false);
});
