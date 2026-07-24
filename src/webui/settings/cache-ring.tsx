/** @jsxImportSource preact */
// The cache-usage ring gauge (数据与备份 → 附件存储, and 离线与缓存 → 本机缓存),
// recovered from the pre-Notionize BlobCacheSettings hero: a 152px three-segment SVG ring
// (freeable → accent, retained → neutral grey, pinned → muted/thinner) with a
// five-state centre, a legend column, caller-supplied action buttons and an
// optional last-verified footnote. Purely presentational — callers compute
// segments/state from their own cache source (browser blob-store or the
// server's /api/blob-cache). CSS: .blob-hero* / .blob-ring* in styles.css.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "../icons.tsx";
import { fmtBytes } from "./shared.ts";

const prefersReduced = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Smoothly counts the displayed byte figure from its previous value to the new
 *  target whenever it changes (easeOutCubic, ~600ms). Honours reduced-motion. */
function useCountUp(target: number, ms = 600): number {
  const [val, setVal] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (prefersReduced()) {
      from.current = target;
      setVal(target);
      return;
    }
    const start = from.current;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      const e = 1 - Math.pow(1 - p, 3);
      setVal(Math.round(start + (target - start) * e));
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return val;
}

/** Ring centre states mirror the core clear judgment (blobs-core isClearable):
 *  no anchor → nothing clearable; this device IS the full library → keeps
 *  everything; an anchor designated but never verified → unknown until a
 *  refresh confirms it. The browser cache only ever uses free/safe. */
export type RingState = "free" | "safe" | "no-anchor" | "unverified" | "self-full";

export function CacheRingHero({
  segs,
  count,
  totalBytes,
  state,
  verifying,
  actions,
  footnote,
}: {
  /** Segment bytes (sum ≤ totalBytes); `keep` is 0 for the browser cache. */
  segs: { free: number; keep: number; pin: number };
  count: number;
  totalBytes: number;
  state: RingState;
  /** Spins the unverified centre icon while a verify round-trip runs. */
  verifying?: boolean;
  /** Action buttons (清理 / 重新检查 / 管理), rendered under the legend. */
  actions?: ComponentChildren;
  /** Last-checked caption under the actions (server cache only). */
  footnote?: ComponentChildren;
}) {
  // `drawn` flips on after mount so the ring arcs animate from 0 → their share.
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(r);
  }, []);
  // Count-up for the free-state centre figure — called unconditionally (hook rules).
  const freeCount = useCountUp(segs.free);

  // Stroke is sized in pathLength=100 units so segment lengths read as percent.
  const total = Math.max(1, totalBytes);
  const pct = (v: number) => (v / total) * 100;
  const segClear = pct(segs.free);
  const segRetain = pct(segs.keep);
  const segPin = pct(segs.pin);
  const arc = (len: number) => (drawn ? len : 0);

  return (
    <div class="blob-hero">
      <div class="blob-hero-main">
        <div class="blob-legend">
          <div class="blob-legend-row">
            <span class="blob-dot free" /> <span class="blob-legend-k">可释放</span>
            <b>{fmtBytes(segs.free)}</b>
          </div>
          {segs.keep > 0 && (
            <div class="blob-legend-row">
              <span class="blob-dot keep" /> <span class="blob-legend-k">保留中</span>
              <b>{fmtBytes(segs.keep)}</b>
            </div>
          )}
          {segs.pin > 0 && (
            <div class="blob-legend-row">
              <span class="blob-dot pin" /> <span class="blob-legend-k">已固定</span>
              <b>{fmtBytes(segs.pin)}</b>
            </div>
          )}
        </div>
        <div class="blob-total">共 {count} 项 · {fmtBytes(totalBytes)}</div>
        {actions != null && <div class="blob-actions">{actions}</div>}
        {footnote != null && <div class="blob-verify-at">{footnote}</div>}
      </div>

      <div
        class={
          "blob-ring" +
          (state === "free" ? " has-free" : state === "safe" ? " all-safe" : " locked")
        }
      >
        <svg viewBox="0 0 100 100" class="blob-ring-svg" aria-hidden="true">
          <g transform="rotate(-90 50 50)">
            <circle class="blob-ring-track" cx="50" cy="50" r="42" pathLength={100} />
            {segPin > 0 && (
              <circle
                class="blob-seg pin"
                cx="50"
                cy="50"
                r="42"
                pathLength={100}
                stroke-dasharray={`${arc(segPin)} ${100 - arc(segPin)}`}
                stroke-dashoffset={-(segClear + segRetain)}
              />
            )}
            {segRetain > 0 && (
              <circle
                class="blob-seg keep"
                cx="50"
                cy="50"
                r="42"
                pathLength={100}
                stroke-dasharray={`${arc(segRetain)} ${100 - arc(segRetain)}`}
                stroke-dashoffset={-segClear}
              />
            )}
            {/* zero-length round-cap arcs still paint a dot — skip empty segs */}
            {segClear > 0 && (
              <circle
                class="blob-seg free"
                cx="50"
                cy="50"
                r="42"
                pathLength={100}
                stroke-dasharray={`${arc(segClear)} ${100 - arc(segClear)}`}
                stroke-dashoffset={0}
              />
            )}
          </g>
        </svg>
        <div class="blob-ring-center">
          {state === "free" && (
            <>
              <div class="blob-ring-big">{fmtBytes(freeCount)}</div>
              <div class="blob-ring-cap">可释放</div>
            </>
          )}
          {state === "safe" && (
            <>
              <div class="blob-ring-check"><Icon name="check" cls="ico" /></div>
              <div class="blob-ring-cap strong">都备份好了</div>
              <div class="blob-ring-cap">暂时无需清理</div>
            </>
          )}
          {state === "no-anchor" && (
            <>
              <div class="blob-ring-lock"><Icon name="lock" cls="ico" /></div>
              <div class="blob-ring-cap strong">未设置长期备份</div>
              <div class="blob-ring-cap">指定后才能清理</div>
            </>
          )}
          {state === "unverified" && (
            <>
              <div class="blob-ring-lock"><Icon name="history" cls={"ico" + (verifying ? " spin" : "")} /></div>
              <div class="blob-ring-cap strong">{verifying ? "检查中…" : "未检查"}</div>
              <div class="blob-ring-cap">检查后才知道</div>
            </>
          )}
          {state === "self-full" && (
            <>
              <div class="blob-ring-lock"><Icon name="database" cls="ico" /></div>
              <div class="blob-ring-cap strong">长期备份库</div>
              <div class="blob-ring-cap">保留全部副本</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
