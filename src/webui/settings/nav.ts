// Page-per-section settings navigation model: the single source of truth for
// the left rail, the narrow-screen drill-down index and URL → page resolution.
// Selection is fully URL-driven (#/settings?sec=<page>); legacy sec values from
// old deep links (share-modal: sec=hosting / sec=sync) map via LEGACY_SEC.
import { isNoOrigin } from "../data/replica.ts";
import { isDesktop } from "./shared.ts";

export type PageId = "appearance" | "quicknote" | "offline" | "backup" | "devices" | "audit" | "hosting" | "about";

export interface PageDef { id: PageId; label: string; icon: string; show: () => boolean }

export const GROUPS: { key: "device" | "workspace" | "app"; pages: PageDef[] }[] = [
  { key: "device", pages: [
    { id: "appearance", label: "外观", icon: "sun", show: () => true },
    { id: "quicknote", label: "快速小窗", icon: "pin", show: () => !!(window as any).metahubDesktop?.quicknote },
    // Desktop has no browser cache and no replica switch; the sidecar's bytes
    // are workspace storage (数据与备份 → 附件存储), so the page hides there.
    { id: "offline", label: "离线与缓存", icon: "database", show: () => !isDesktop() },
  ]},
  { key: "workspace", pages: [
    { id: "backup", label: "数据与备份", icon: "cloudCheck", show: () => true },
    { id: "devices", label: "设备", icon: "monitor", show: () => !isNoOrigin() },
    { id: "audit", label: "操作审计", icon: "history", show: () => true },
    { id: "hosting", label: "站点与发布", icon: "globe", show: () => true },
  ]},
  // Headless group (no .set-rail-group-head): the app itself, last in the list.
  // The cube is the product mark, so the row carries the product identity.
  { key: "app", pages: [
    { id: "about", label: "关于", icon: "cube", show: () => true },
  ]},
];

/** Old #/settings?sec= chapter ids → the page that now hosts that content. */
export const LEGACY_SEC: Record<string, PageId> = { sync: "backup", storage: "backup", devices: "devices", hosting: "hosting", appearance: "appearance", quicknote: "quicknote" };

/** Resolve a ?sec= value (legacy chapter id or page id) to a visible page;
 *  absent, unknown or hidden-here values fall back to the first visible page. */
export function resolvePage(sec?: string): PageId {
  const visible = GROUPS.flatMap((g) => g.pages).filter((p) => p.show());
  const want = sec ? (LEGACY_SEC[sec] ?? sec) : undefined;
  return visible.find((p) => p.id === want)?.id ?? visible[0]!.id;
}

/** A page's display label — single source for rail rows, index rows and each
 *  page's own PageHeader, so the three can never drift apart. */
export const pageLabel = (id: PageId): string =>
  GROUPS.flatMap((g) => g.pages).find((p) => p.id === id)?.label ?? "";
