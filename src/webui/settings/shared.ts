// Small helpers + types shared between the settings page blocks and the
// extracted modals (settings/modals.tsx). Moved verbatim out of settings.tsx.
import { clientMode } from "../data/replica.ts";

/** Inside the desktop shell (Electron + local sidecar) the sidecar IS the data
 *  home — it stores everything on disk directly, so the "browser client" model
 *  (window vs replica, an OPFS replica, re-entering a bucket secret to direct-
 *  connect) doesn't apply. The 同步 section collapses to "connect a bucket so
 *  every device stays in sync"; device-to-device HTTP pairing (设备与授权) stays. */
export const isDesktop = () => clientMode().surface === "desktop";

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Why the replica can't run here, or null when it can. Shown in the section
 *  instead of hiding it — a silently missing switch is undebuggable (the
 *  common case: opening the server over plain http from a phone, which is not
 *  a secure context, so OPFS and service workers don't exist at all). */
export function replicaUnsupportedReason(): string | null {
  if (typeof Worker === "undefined" || typeof navigator === "undefined") {
    return "此浏览器不支持 Web Worker。";
  }
  if (!window.isSecureContext) {
    return "需要 HTTPS（安全上下文）。当前是 http:// 访问，浏览器不开放离线所需的 OPFS 与 Service Worker——给服务器配置 TLS（--tls-cert/--tls-key，或 Caddy / Tailscale Serve 反代；iPhone 需要受信任的证书），或在本机用 localhost 访问。";
  }
  if (!navigator.storage?.getDirectory) {
    return "此浏览器不支持 OPFS 本地存储（需要 Safari 17+ / Chrome / Firefox 较新版本）。";
  }
  return null;
}

export interface StoragePeerView {
  url: string;
  label: string | null;
  enabled: boolean;
  status: string | null;
  error: string | null;
  lastSyncAt: number | null;
  lastAttemptAt: number | null;
  bucket?: string | null;
  endpoint?: string | null;
}

/** Host of an endpoint URL for compact row display ("…r2.cloudflarestorage.com"). */
export function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

export function fmtTime(ms: number | null): string {
  if (!ms) return "从未";
  return new Date(ms).toLocaleString();
}
