import { useCallback, useEffect, useRef, useState } from "react";

import { useSession } from "../auth/session";
import type { LiveChange } from "./live";

/** Minimal fetch-state hook: load on mount / when `fetcher` identity changes,
 *  expose refetch for pull-to-refresh and live invalidation. */
export function useApiData<T>(fetcher: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const gen = useRef(0);

  const load = useCallback(async () => {
    const g = ++gen.current;
    try {
      const d = await fetcher();
      if (g !== gen.current) return;
      setData(d);
      setError(null);
    } catch (e) {
      if (g !== gen.current) return;
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      if (g === gen.current) setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    const g = gen;
    // load() is async — its setStates land after awaits, never synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => {
      g.current++;
    };
  }, [load]);

  return { data, error, loading, refetch: load };
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
