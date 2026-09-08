/** @jsxImportSource preact */
import { useState } from "preact/hooks";

/** Remembered row count for a list's skeleton (session-scoped, clamp 2..8). */
export function useSkeletonRows(key: string, fallback = 3): [number, (n: number) => void] {
  const k = `mh_skel_${key}`;
  const [rows] = useState(() => {
    try {
      const n = Number(sessionStorage.getItem(k));
      return n > 0 ? Math.min(8, Math.max(2, n)) : fallback;
    } catch {
      return fallback;
    }
  });
  const remember = (n: number) => {
    try {
      sessionStorage.setItem(k, String(n));
    } catch {
      /* private mode */
    }
  };
  return [rows, remember];
}

/** N sheen text lines — the placeholder for any short block of prose. */
export function SkelLines({ n = 3, cls = "" }: { n?: number; cls?: string }) {
  return (
    <div class={"skel-lines skel-list" + (cls ? " " + cls : "")} role="status" aria-busy="true" aria-label="正在加载">
      {Array.from({ length: n }, (_, i) => (
        <span class="skel-b skel-s" key={i} style={`--i:${Math.min(i, 4)}`} />
      ))}
    </div>
  );
}

/** One sheen line sized like a caption/sub-line (page header sub, row caption). */
export function SkelText({ cls = "" }: { cls?: string }) {
  return <span class={"skel-b skel-s skel-list" + (cls ? " " + cls : "")} role="status" aria-busy="true" />;
}
