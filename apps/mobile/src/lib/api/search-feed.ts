import type { SearchHitInfo } from "./sdk";

type Batch = { hits: SearchHitInfo[]; hasMore: boolean };
type Snapshot = {
  hits: SearchHitInfo[];
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: Error | null;
  moreError: Error | null;
};

/** One query's lazy result stream. Discarded streams cannot publish late responses. */
export function createSearchFeed(
  fetchBatch: (offset: number) => Promise<Batch>,
) {
  let state: Snapshot = {
    hits: [],
    hasMore: false,
    loading: true,
    loadingMore: false,
    error: null,
    moreError: null,
  };
  let offset = 0;
  let generation = 0;
  let disposed = false;
  const listeners = new Set<() => void>();
  const publish = (next: Snapshot) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  async function load(first: boolean) {
    if (
      disposed ||
      (!first && (state.loading || state.loadingMore || !state.hasMore))
    )
      return;
    const request = first ? ++generation : generation;
    const start = first ? 0 : offset;
    publish(
      first
        ? {
            hits: [],
            hasMore: false,
            loading: true,
            loadingMore: false,
            error: null,
            moreError: null,
          }
        : { ...state, loadingMore: true, moreError: null },
    );
    try {
      const batch = await fetchBatch(start);
      if (disposed || request !== generation) return;
      const previous = first ? [] : state.hits;
      const unique = new Map(
        previous.map((hit) => [`${hit.type}:${hit.id}`, hit]),
      );
      for (const hit of batch.hits) unique.set(`${hit.type}:${hit.id}`, hit);
      offset = start + batch.hits.length;
      publish({
        hits: [...unique.values()],
        hasMore: batch.hasMore && batch.hits.length > 0,
        loading: false,
        loadingMore: false,
        error: null,
        moreError: null,
      });
    } catch (cause) {
      if (disposed || request !== generation) return;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      publish({
        ...state,
        loading: false,
        loadingMore: false,
        ...(first ? { error } : { moreError: error }),
      });
    }
  }
  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reload: () => load(true),
    loadMore: () => load(false),
    // Strict Mode may reconnect the same store after effect cleanup.
    activate: () => {
      disposed = false;
    },
    dispose: () => {
      disposed = true;
      generation++;
    },
  };
}
