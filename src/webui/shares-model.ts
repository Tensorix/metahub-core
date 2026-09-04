// Pure view-model for the global 分享 list (shares-view.tsx keeps only wiring +
// JSX, like share-modal-model.ts does for the dialog). Everything here is a
// plain function over already-fetched ShareListItem rows so the status
// derivation, the state→action matrix, filtering, counting and grouping are
// unit-testable without a DOM.
//
// Product facts these encode (see core/sync/share-actions.ts):
//   - server / peer / room rows always carry a url and may expire (410 after,
//     row kept); s3 rows carry no url (links are re-signed on demand),
//     expiresAt is the presigned-link validity and contentUpdatedAt the
//     snapshot time.
//   - renew only exists for s3; an expired device/Edge link can only be
//     re-created.
//   - lifecycle (room only): provisioning / cleanup_pending.

import type { ShareListItem } from "./api.ts";

export type ShareState = "active" | "expiring" | "expired" | "provisioning" | "cleanup_pending";
export type StatusTone = "ok" | "warn" | "muted" | "busy";
export interface ShareStatus {
  state: ShareState;
  label: string;
  tone: StatusTone;
}

/** Links with less than this left read as "快过期". */
export const EXPIRING_WINDOW_MS = 3 * 86_400_000;

export function isExpired(s: Pick<ShareListItem, "expiresAt">, now: number): boolean {
  return s.expiresAt != null && now >= s.expiresAt;
}

function remainingText(ms: number): string {
  const d = Math.floor(ms / 86_400_000);
  if (d >= 1) return `${d} 天后过期`;
  const h = Math.floor(ms / 3_600_000);
  if (h >= 1) return `${h} 小时后过期`;
  return `${Math.max(1, Math.floor(ms / 60_000))} 分钟后过期`;
}

/** The single status judgment for a row. Lifecycle wins over expiry: a room
 *  being torn down is "撤销中" no matter what its clock says. Expiry is a
 *  share's normal ending, so it reads muted — never danger. */
export function shareStatus(s: ShareListItem, now = Date.now()): ShareStatus {
  if (s.lifecycle === "cleanup_pending") return { state: "cleanup_pending", label: "撤销中", tone: "warn" };
  if (s.lifecycle === "provisioning") return { state: "provisioning", label: "准备中", tone: "busy" };
  if (s.expiresAt == null) return { state: "active", label: "永久", tone: "ok" };
  const ms = s.expiresAt - now;
  if (ms <= 0) return { state: "expired", label: "已过期", tone: "muted" };
  const label = remainingText(ms);
  return ms < EXPIRING_WINDOW_MS
    ? { state: "expiring", label, tone: "warn" }
    : { state: "active", label, tone: "ok" };
}

export type PrimaryKind = "copy" | "renew" | "recreate" | "retryRevoke";
export interface PrimaryAction {
  kind: PrimaryKind;
  label: string;
  disabled?: boolean;
  danger?: boolean;
}

/** One primary button per row, chosen by state × transport. For s3 "copy" and
 *  "renew" are the same call (re-sign + copy) — the label just says what the
 *  user is about to get. */
export function primaryAction(s: Pick<ShareListItem, "transport">, st: ShareStatus): PrimaryAction {
  const s3 = s.transport === "s3";
  switch (st.state) {
    case "cleanup_pending":
      return { kind: "retryRevoke", label: "重试撤销", danger: true };
    case "provisioning":
      return { kind: "copy", label: "复制链接", disabled: true };
    case "expired":
      return s3 ? { kind: "renew", label: "续期" } : { kind: "recreate", label: "重新分享" };
    case "expiring":
      return s3 ? { kind: "renew", label: "续期" } : { kind: "copy", label: "复制链接" };
    default:
      return { kind: "copy", label: "复制链接" };
  }
}

export type SourceKind = ShareListItem["sourceKind"];
export const SOURCE_KINDS: SourceKind[] = ["server", "peer", "room", "bucket"];
export const SOURCE_KIND_LABEL: Record<SourceKind, string> = {
  server: "本机",
  peer: "设备",
  room: "Edge",
  bucket: "存储桶",
};

/** Human source line: strips the engineering prefixes core bakes into
 *  `source` ("桶 x", "房间 slug") and classifies by sourceKind, which is the
 *  reliable field. The local server's served_base is redundant next to the
 *  link itself, so it collapses to 本机. */
export function sourceLabel(s: Pick<ShareListItem, "sourceKind" | "source">): string {
  switch (s.sourceKind) {
    case "bucket":
      return `存储桶 ${s.source.replace(/^桶\s*/, "")}`;
    case "room":
      return "Edge";
    case "peer":
      return `设备 ${s.source}`;
    default:
      return "本机";
  }
}

/** URL as shown in the row: no scheme, no trailing slash. */
export function displayUrl(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "");
}

/** "快照 8/21 14:02" (year shown only when it differs from now's). */
export function fmtSnapshot(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return `快照 ${d.getFullYear() === n.getFullYear() ? md : `${d.getFullYear()}/${md}`} ${hm}`;
}

export type StatusFilter = "all" | "active" | "expiring" | "expired";
export const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "active", label: "有效" },
  { id: "expiring", label: "快过期" },
  { id: "expired", label: "已过期" },
];

export interface ShareFilter {
  status: StatusFilter;
  source: "all" | SourceKind;
  q: string;
}
export const EMPTY_FILTER: ShareFilter = { status: "all", source: "all", q: "" };

export function matchesStatus(st: ShareStatus, f: StatusFilter): boolean {
  switch (f) {
    case "all":
      return true;
    case "active":
      return st.state === "active" || st.state === "provisioning";
    case "expiring":
      return st.state === "expiring";
    case "expired":
      return st.state === "expired";
  }
}

/** The two non-status axes (source + search). Status is applied separately
 *  so the segmented counts can be computed over this result. */
export function filterShares(list: ShareListItem[], f: Pick<ShareFilter, "source" | "q">): ShareListItem[] {
  const needle = f.q.trim().toLowerCase();
  return list.filter((s) => {
    if (f.source !== "all" && s.sourceKind !== f.source) return false;
    if (!needle) return true;
    return (
      s.title.toLowerCase().includes(needle) ||
      sourceLabel(s).toLowerCase().includes(needle) ||
      s.source.toLowerCase().includes(needle) ||
      (s.url ?? "").toLowerCase().includes(needle)
    );
  });
}

export function countByStatus(list: ShareListItem[], now = Date.now()): Record<StatusFilter, number> {
  const c: Record<StatusFilter, number> = { all: list.length, active: 0, expiring: 0, expired: 0 };
  for (const s of list) {
    const st = shareStatus(s, now);
    if (matchesStatus(st, "active")) c.active++;
    else if (st.state === "expiring") c.expiring++;
    else if (st.state === "expired") c.expired++;
  }
  return c;
}

export function countBySource(list: ShareListItem[]): Partial<Record<SourceKind, number>> {
  const c: Partial<Record<SourceKind, number>> = {};
  for (const s of list) c[s.sourceKind] = (c[s.sourceKind] ?? 0) + 1;
  return c;
}

/** Soonest-to-expire first; never-expiring last; ties keep input order. */
export function sortByExpiry(list: ShareListItem[]): ShareListItem[] {
  return list
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const ea = a.s.expiresAt ?? Infinity;
      const eb = b.s.expiresAt ?? Infinity;
      return ea === eb ? a.i - b.i : ea - eb;
    })
    .map((x) => x.s);
}

/** Live rows (sorted soonest-first) and expired rows (most recently expired
 *  first) — the expired group sinks below the live list in the view. */
export function groupShares(
  list: ShareListItem[],
  now = Date.now(),
): { live: ShareListItem[]; expired: ShareListItem[] } {
  const live: ShareListItem[] = [];
  const expired: ShareListItem[] = [];
  for (const s of list) (shareStatus(s, now).state === "expired" ? expired : live).push(s);
  expired.sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0));
  return { live: sortByExpiry(live), expired };
}
