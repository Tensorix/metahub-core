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
  region?: string | null;
  provider?: string | null;
}

/** Host of an endpoint URL for compact row display ("…r2.cloudflarestorage.com"). */
export function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

// ---- bucket vendor display --------------------------------------------------
// Three honest layers: the preset recorded at connect time → a host-suffix
// match for buckets connected before that → the bare host. The mapping can't
// be complete and doesn't need to be: an unknown vendor shows its host, which
// for a self-hosted MinIO is the most accurate name there is. Display-only;
// nothing in sync depends on it.

const PROVIDER_NAME: Record<string, string> = {
  r2: "Cloudflare R2",
  s3: "Amazon S3",
  cos: "腾讯云 COS",
  oss: "阿里云 OSS",
  minio: "MinIO",
  b2: "Backblaze B2",
  wasabi: "Wasabi",
  spaces: "DigitalOcean Spaces",
  gcs: "Google Cloud Storage",
};
const HOST_SUFFIX: [suffix: string, id: string][] = [
  ["amazonaws.com", "s3"],
  ["r2.cloudflarestorage.com", "r2"],
  ["myqcloud.com", "cos"],
  ["aliyuncs.com", "oss"],
  ["backblazeb2.com", "b2"],
  ["wasabisys.com", "wasabi"],
  ["digitaloceanspaces.com", "spaces"],
  ["storage.googleapis.com", "gcs"],
];

/** Vendor name for a bucket row. `provider` = the stored preset id (may be
 *  null/"custom"); `endpoint` = the full URL. Never returns an empty string. */
export function providerName(provider: string | null | undefined, endpoint: string | null | undefined): string {
  if (provider && PROVIDER_NAME[provider]) return PROVIDER_NAME[provider]!;
  const host = endpoint ? hostOf(endpoint).toLowerCase() : "";
  for (const [suffix, id] of HOST_SUFFIX) if (host === suffix || host.endsWith("." + suffix)) return PROVIDER_NAME[id]!;
  return host || "存储桶";
}

const REGION_NAME: Record<string, string> = {
  // Tencent COS
  "ap-shanghai": "上海", "ap-beijing": "北京", "ap-guangzhou": "广州", "ap-chengdu": "成都",
  "ap-nanjing": "南京", "ap-hongkong": "香港", "ap-singapore": "新加坡", "ap-tokyo": "东京",
  // Aliyun OSS
  "oss-cn-hangzhou": "杭州", "oss-cn-shanghai": "上海", "oss-cn-beijing": "北京",
  "oss-cn-shenzhen": "深圳", "oss-cn-hongkong": "香港",
  // AWS
  "us-east-1": "美国东部", "us-east-2": "美国东部 2", "us-west-1": "美国西部", "us-west-2": "美国西部 2",
  "eu-west-1": "爱尔兰", "eu-central-1": "法兰克福", "ap-northeast-1": "东京", "ap-southeast-1": "新加坡",
};

/** Human region for the row caption; unknown codes show as-is, "auto" hides. */
export function regionName(region: string | null | undefined): string | null {
  if (!region || region === "auto") return null;
  return REGION_NAME[region] ?? region;
}

export function fmtTime(ms: number | null): string {
  if (!ms) return "从未";
  return new Date(ms).toLocaleString();
}
