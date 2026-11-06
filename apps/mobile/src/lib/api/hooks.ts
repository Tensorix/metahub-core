import { useCallback, useEffect, useRef, useState } from "react";

import { useSession } from "../auth/session";
import type { LiveChange } from "./live";

/** Minimal fetch-state hook: load on mount / when `fetcher` identity changes,
 *  expose refetch for pull-to-refresh and live invalidation. */
export function useApiData<T>(fetcher: () => Promise<T>, retainKey?: string) {
  const [state, setState] = useState<{
    source: typeof fetcher;
    retainKey?: string;
    data: T | null;
    error: Error | null;
    loading: boolean;
  }>({ source: fetcher, retainKey, data: null, error: null, loading: true });
  const gen = useRef(0);
  const load = useCallback(async () => {
    const g = ++gen.current;
    setState((prev) => ({
      source: fetcher,
      retainKey,
      data:
        prev.source === fetcher ||
        (retainKey !== undefined && retainKey === prev.retainKey)
          ? prev.data
          : null,
      error: null,
      loading: true,
    }));
    try {
      const data = await fetcher();
      if (g === gen.current) {
        setState({
          source: fetcher,
          retainKey,
          data,
          error: null,
          loading: false,
        });
      }
    } catch (e) {
      if (g === gen.current) {
        setState((prev) => ({
          source: fetcher,
          retainKey,
          data:
            prev.source === fetcher ||
            (retainKey !== undefined && retainKey === prev.retainKey)
              ? prev.data
              : null,
          error: e instanceof Error ? e : new Error(String(e)),
          loading: false,
        }));
      }
    }
  }, [fetcher, retainKey]);
  useEffect(() => {
    const generation = gen;
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  const current =
    state.source === fetcher ||
    (retainKey !== undefined && state.retainKey === retainKey)
      ? state
      : { data: null, error: null, loading: true };
  return { ...current, refetch: load };
}

/** Invoke `onChange` when the SSE feed reports changes touching any of
 *  `datasets` (empty array = every change). Callback identity is kept in a
 *  ref so screens can pass their refetch inline. */
export function useLiveInvalidate(
  datasets: string[],
  onChange: (change: LiveChange) => void,
): void {
  const { live } = useSession();
  const cb = useRef(onChange);
  useEffect(() => {
    cb.current = onChange;
  });
  const key = datasets.join(",");
  useEffect(() => {
    const wanted = key ? key.split(",") : [];
    return live.onChange((change) => {
      if (!wanted.length || change.datasets.some((d) => wanted.includes(d)))
        cb.current(change);
    });
  }, [live, key]);
}

/** The SSE connection state, for the settings live dot. */
export function useLiveStatus(): boolean {
  const { live } = useSession();
  const [connected, setConnected] = useState(live.connected);
  useEffect(() => live.onStatus(setConnected), [live]);
  return connected;
}
