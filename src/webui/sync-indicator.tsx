/** @jsxImportSource preact */
// Ambient replica-sync indicator. The browser replica syncs silently on load,
// focus, online, after writes and (bucket-only) on a poll; nothing in the shell
// used to say so, so a phone user staring at a stale list couldn't tell "still
// pulling" from "already current". This is the one honest signal, built to be
// seen but never to nag:
//   - zero footprint while idle (not even a dot);
//   - a round shorter than SHOW_DELAY never appears (typing-triggered pushes);
//   - once shown it stays >= MIN_SHOWN, then flashes 已更新/已同步 briefly —
//     and only if it actually showed (no flash for quiet rounds);
//   - first hydration shows immediately with a live count;
//   - a failed round leaves a quiet, clickable 同步失败 until the next ok round;
//   - hidden while offline (.offline-bar already speaks).
// Window (SSE) clients and the desktop shell never sync this way → always hidden.

import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./icons.tsx";
import { clientMode, onReplicaStatus, replicaStatus } from "./data/replica.ts";
import type { ReplicaStatus } from "./data/db-worker.ts";

export type SyncPhase = "hidden" | "hydrating" | "syncing" | "done" | "error";

const SHOW_DELAY_MS = 300;
const MIN_SHOWN_MS = 700;
const DONE_FLASH_MS = 1100;

export interface SyncPhaseState {
  phase: SyncPhase;
  label: string;
  title: string;
}

export function useSyncPhase(): SyncPhaseState {
  const [st, setSt] = useState<ReplicaStatus>(() => replicaStatus());
  const [online, setOnline] = useState(typeof navigator === "undefined" || navigator.onLine !== false);
  // "shown" = the syncing/hydrating spinner is (or was, for this round) visible.
  const [shown, setShown] = useState(false);
  const [done, setDone] = useState<null | { pulled: number }>(null);
  const shownAt = useRef(0);
  const replica = clientMode().hold === "replica";

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  useEffect(() => onReplicaStatus((s) => setSt({ ...s })), []);

  const busy = Boolean(st.syncing) || st.state === "hydrating";
  useEffect(() => {
    if (!replica) return;
    if (busy) {
      setDone(null);
      if (shown) return;
      // Hydration is the long wait — show at once. Ordinary rounds wait out
      // SHOW_DELAY so a fast push after a keystroke never flickers.
      const delay = st.state === "hydrating" ? 0 : SHOW_DELAY_MS;
      const t = setTimeout(() => {
        shownAt.current = Date.now();
        setShown(true);
      }, delay);
      return () => clearTimeout(t);
    }
    if (!shown) return;
    // Round ended while visible: hold the minimum, then flash the outcome.
    const hold = Math.max(0, MIN_SHOWN_MS - (Date.now() - shownAt.current));
    const t = setTimeout(() => {
      setShown(false);
      if (st.lastSync?.ok) setDone({ pulled: st.lastSync.pulled });
    }, hold);
    return () => clearTimeout(t);
  }, [busy, st.state, replica]);

  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(null), DONE_FLASH_MS);
    return () => clearTimeout(t);
  }, [done]);

  if (!replica || !online) return { phase: "hidden", label: "", title: "" };
  if (shown && st.state === "hydrating") {
    const n = (st.hydrated ?? 0).toLocaleString();
    return { phase: "hydrating", label: `下载中 · ${n}`, title: `正在下载本地副本，已接收 ${n} 条变更` };
  }
  if (shown) return { phase: "syncing", label: "同步中", title: "正在与服务器同步" };
  if (done) return { phase: "done", label: done.pulled > 0 ? "已更新" : "已同步", title: "" };
  if (st.state === "ready" && st.lastSync && !st.lastSync.ok) {
    return {
      phase: "error",
      label: "同步失败",
      title: `上次同步失败：${st.lastSync.error ?? "未知错误"} · 本地读写不受影响，点击查看`,
    };
  }
  return { phase: "hidden", label: "", title: "" };
}

export function SyncIndicator({
  variant,
  onOpen,
}: {
  variant: "footer" | "head" | "topbar";
  onOpen: () => void;
}) {
  const { phase, label, title } = useSyncPhase();
  if (phase === "hidden") return null;
  return (
    <button
      class={`sync-ind sync-ind-${phase} sync-ind-${variant}`}
      title={title || label}
      aria-label={title || label}
      aria-live="polite"
      onClick={onOpen}
    >
      <span class="sync-ind-ico">
        {phase === "done" ? (
          <Icon name="cloudCheck" cls="ico sm" />
        ) : phase === "error" ? (
          <Icon name="cloudOff" cls="ico sm" />
        ) : (
          <span class="sync-ring" />
        )}
      </span>
      <span class="sync-ind-label">{label}</span>
    </button>
  );
}
