/** @jsxImportSource preact */
// Blob 管理弹窗（设置 → 离线与缓存 → 本机缓存，以及 数据与备份 → 附件存储）。
// 一个共享面板，按需打开，列出这台设备
// 持有的每个 blob（图片/大文件的本机副本），支持按大小/类型/最近使用排序、按类型与
// 状态筛选，并对单项或批量执行「清理」（删别处已备份的副本，用时自动取回）或「删除
// 孤儿」（没有任何文档/站点引用的 blob）。
//
// 两种数据源经同一个 BlobSource 适配器接口解耦（里氏替换）：
//   - 服务端模式：走 /api/blobs*（数据家在 sidecar/服务器）。
//   - 无源 PWA 壳：走浏览器 Cache Storage（blob-store.ts）+ worker 的 blobRefs。
// UI 只认 BlobRow，单一来源、零重复。

import { useEffect, useMemo, useState } from "preact/hooks";
import { Icon } from "./icons.tsx";
import { timeAgo } from "./date.ts";
import { t } from "./i18n/t.ts";
import {
  Modal,
  openModal,
  closeModal,
  openMenu,
  MenuItem,
  MenuLabel,
  toast,
  confirmDialog,
} from "./ui.tsx";
import { api, type BlobRow } from "./api.ts";
import {
  listBlobs as localListBlobs,
  clearBlobs as localClearBlobs,
  deleteBlobs as localDeleteBlobs,
  setCachePinned,
} from "./data/blob-store.ts";
import { call as replicaCall } from "./data/replica.ts";
import type { Scope } from "./data/scopes.ts";

// ---- data source -------------------------------------------------------------

/** What the popup needs from either backend. `deleteSemantics` tailors the
 *  destructive-delete copy: "purge" truly removes bytes (server ledger), "evict"
 *  only drops the local cache copy (no-origin — the bucket original stays). */
export interface BlobSource {
  title: string;
  subtitle: string;
  deleteSemantics: "purge" | "evict";
  list(): Promise<BlobRow[]>;
  clear(hashes: string[]): Promise<{ cleared: number; freedBytes: number }>;
  remove(hashes: string[]): Promise<{ removed: number; freedBytes: number }>;
  pin(hash: string, pinned: boolean): Promise<void>;
}

/** Build the BlobSource adapter for a storage Scope (scopes.ts). One backend per
 *  scope kind: "local" manages this device's byte cache (evict semantics — the
 *  bucket original stays, an unpinned byte re-downloads); "server" manages the
 *  data home's ledger (purge semantics). The blob-specific copy is intentionally
 *  kept here, NOT read from scope.label/subtitle (those are the generic 本机/云端
 *  workspace names). Callers (本机缓存 / 附件存储 sections) only ever hold
 *  local|server scopes, never buckets; server is the fall-through default. */
export function sourceForScope(scope: Scope): BlobSource {
  if (scope.kind === "local") {
    return {
      title: t("管理本机缓存"),
      subtitle:
        t("已下载到这台设备的图片和大文件。清理只删本机副本，需要时从云端重新取回；桶里的原件始终不动。"),
      deleteSemantics: "evict",
      list: async () => {
        const [blobs, refs] = await Promise.all([
          localListBlobs(),
          replicaCall<string[]>("blobRefs").catch(() => [] as string[]),
        ]);
        const refSet = new Set(refs);
        return blobs.map((b) => ({
          hash: b.hash,
          size: b.size,
          contentType: b.content_type,
          lastAccess: b.accessed,
          pinned: b.pinned,
          pending: b.pending,
          // every unpinned, non-pending cached byte re-downloads on demand
          clearable: !b.pinned && !b.pending,
          referenced: refSet.has(b.hash),
        }));
      },
      clear: (h) => localClearBlobs(h),
      remove: (h) => localDeleteBlobs(h),
      pin: async (h, p) => {
        await setCachePinned(h, p);
      },
    };
  }
  return {
    title: t("管理附件存储"),
    subtitle:
      t("工作区里的全部图片和大文件，所有设备共用。可清理项已有长期备份、随时能腾空间（用时自动取回）；没被任何文档或站点引用的孤儿可彻底删除。"),
    deleteSemantics: "purge",
    list: () => api.blobs(),
    clear: (h) => api.clearBlobs(h),
    remove: (h) => api.deleteBlobs(h),
    pin: async (h, p) => {
      await api.pinBlob(h, p);
    },
  };
}

export function openBlobManager(scope: Scope): void {
  openModal(<BlobManager source={sourceForScope(scope)} />);
}

// ---- helpers -----------------------------------------------------------------

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

type Kind = "image" | "video" | "audio" | "file" | "other";
const KIND_LABEL: Record<Kind, string> = {
  image: t("图片"),
  video: t("视频"),
  audio: t("音频"),
  file: t("文件"),
  other: t("其他"),
};
const KIND_ICON: Record<Kind, string> = {
  image: "image",
  video: "video",
  audio: "audio",
  file: "file",
  other: "file",
};

function blobKind(ct: string | null): Kind {
  if (!ct) return "other";
  const lc = ct.toLowerCase();
  if (lc.startsWith("image/")) return "image";
  if (lc.startsWith("video/")) return "video";
  if (lc.startsWith("audio/")) return "audio";
  if (lc.startsWith("application/") || lc.startsWith("text/")) return "file";
  return "other";
}

type Status = "pending" | "pinned" | "orphan" | "clearable" | "retained";
/** The one badge a row shows (most action-relevant first). Actions read the raw
 *  flags, not this label. */
function blobStatus(b: BlobRow): Status {
  if (b.pending) return "pending";
  if (b.pinned) return "pinned";
  if (!b.referenced) return "orphan";
  if (b.clearable) return "clearable";
  return "retained";
}
const STATUS_LABEL: Record<Status, string> = {
  pending: t("待上传"),
  pinned: t("已固定"),
  orphan: t("孤儿"),
  clearable: t("可清理"),
  retained: t("保留"),
};

type SortKey = "size" | "type" | "access";
const SORT_LABEL: Record<SortKey, string> = { size: t("大小"), type: t("类型"), access: t("最近使用") };

const TYPE_FILTERS: { key: Kind | "all"; label: string }[] = [
  { key: "all", label: t("全部类型") },
  { key: "image", label: t("图片") },
  { key: "video", label: t("视频") },
  { key: "audio", label: t("音频") },
  { key: "file", label: t("文件") },
  { key: "other", label: t("其他") },
];
const STATUS_FILTERS: { key: Status | "all"; label: string }[] = [
  { key: "all", label: t("全部状态") },
  { key: "clearable", label: t("可清理") },
  { key: "retained", label: t("保留中") },
  { key: "pinned", label: t("已固定") },
  { key: "pending", label: t("待上传") },
  { key: "orphan", label: t("孤儿") },
];

/** Small image thumbnail (served from /blob/<hash> — local cache or SW), falling
 *  back to the kind icon if the bytes aren't fetchable. */
function BlobThumb({ row }: { row: BlobRow }) {
  const kind = blobKind(row.contentType);
  const [failed, setFailed] = useState(false);
  if (kind === "image" && !failed) {
    return (
      <img
        class="blob-mgr-thumb"
        src={`/blob/${row.hash}`}
        loading="lazy"
        alt=""
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span class="blob-mgr-ico">
      <Icon name={KIND_ICON[kind]} cls="ico sm" />
    </span>
  );
}

// ---- modal -------------------------------------------------------------------

function BlobManager({ source }: { source: BlobSource }) {
  const [rows, setRows] = useState<BlobRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [query, setQuery] = useState("");
  const [typeF, setTypeF] = useState<Kind | "all">("all");
  const [statusF, setStatusF] = useState<Status | "all">("all");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "size", desc: true });
  const [sel, setSel] = useState<Set<string>>(new Set());

  const load = async () => {
    try {
      const list = await source.list();
      setRows(list);
      setErr(null);
      // drop selections that no longer exist
      setSel((cur) => new Set([...cur].filter((h) => list.some((r) => r.hash === h))));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const matchesStatus = (b: BlobRow, f: Status | "all") => {
    if (f === "all") return true;
    if (f === "clearable") return b.clearable && !b.pinned;
    if (f === "retained") return !b.clearable && !b.pending && b.referenced;
    if (f === "pinned") return b.pinned;
    if (f === "pending") return b.pending;
    if (f === "orphan") return !b.referenced;
    return true;
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (rows ?? []).filter((b) => {
      const kind = blobKind(b.contentType);
      if (typeF !== "all" && kind !== typeF) return false;
      if (!matchesStatus(b, statusF)) return false;
      if (q) {
        const hay = `${b.hash} ${b.contentType ?? ""} ${KIND_LABEL[kind]}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const dir = sort.desc ? -1 : 1;
    return [...list].sort((a, b) => {
      let cmp = 0;
      if (sort.key === "size") cmp = a.size - b.size;
      else if (sort.key === "access") cmp = (a.lastAccess ?? 0) - (b.lastAccess ?? 0);
      else cmp = KIND_LABEL[blobKind(a.contentType)].localeCompare(KIND_LABEL[blobKind(b.contentType)], "zh") || a.size - b.size;
      return dir * cmp;
    });
  }, [rows, query, typeF, statusF, sort]);

  const toggle = (hash: string) =>
    setSel((cur) => {
      const next = new Set(cur);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  const allShownSelected = filtered.length > 0 && filtered.every((r) => sel.has(r.hash));
  const toggleAll = () =>
    setSel((cur) => {
      if (filtered.every((r) => cur.has(r.hash))) {
        const next = new Set(cur);
        for (const r of filtered) next.delete(r.hash);
        return next;
      }
      return new Set([...cur, ...filtered.map((r) => r.hash)]);
    });

  const selectedRows = (rows ?? []).filter((r) => sel.has(r.hash));
  const selClearable = selectedRows.filter((r) => r.clearable && !r.pinned);
  const selOrphans = selectedRows.filter((r) => !r.referenced);
  const selBytes = selectedRows.reduce((s, r) => s + r.size, 0);

  const togglePin = async (b: BlobRow) => {
    setBusy(true);
    try {
      await source.pin(b.hash, !b.pinned);
      await load();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doClear = async () => {
    const hashes = selClearable.map((r) => r.hash);
    if (!hashes.length) return;
    setBusy(true);
    try {
      const r = await source.clear(hashes);
      toast(r.cleared ? t("已清理 {n} 项 · 腾出 {bytes}", { n: r.cleared, bytes: fmtBytes(r.freedBytes) }) : t("没有可清理的项"));
      await load();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    const orphans = selOrphans;
    if (!orphans.length) return;
    const bytes = orphans.reduce((s, r) => s + r.size, 0);
    const evict = source.deleteSemantics === "evict";
    const ok = await confirmDialog({
      title: t("删除孤儿 blob"),
      message: evict
        ? t("将从这台设备移除 {n} 个未被任何文档/站点引用的 blob，约 {bytes}。桶里的原件不动，需要时仍可重新下载。", { n: orphans.length, bytes: fmtBytes(bytes) })
        : t("将永久删除 {n} 个未被任何文档/站点引用的 blob，约 {bytes}。此操作不可恢复。", { n: orphans.length, bytes: fmtBytes(bytes) }),
      confirmLabel: t("删除"),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await source.remove(orphans.map((o) => o.hash));
      toast(r.removed ? t("已删除 {n} 项 · 腾出 {bytes}", { n: r.removed, bytes: fmtBytes(r.freedBytes) }) : t("没有可删除的孤儿"));
      await load();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sortMenu = (e: MouseEvent) =>
    openMenu(e, (close) => (
      <>
        <MenuLabel>{t("排序依据")}</MenuLabel>
        {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
          <MenuItem
            key={k}
            label={SORT_LABEL[k] + (sort.key === k ? (sort.desc ? " ↓" : " ↑") : "")}
            checked={sort.key === k}
            onClick={() => {
              setSort((s) => ({ key: k, desc: s.key === k ? !s.desc : true }));
              close();
            }}
          />
        ))}
      </>
    ));

  const typeMenu = (e: MouseEvent) =>
    openMenu(e, (close) => (
      <>
        <MenuLabel>{t("按类型")}</MenuLabel>
        {TYPE_FILTERS.map((f) => (
          <MenuItem
            key={f.key}
            label={f.label}
            checked={typeF === f.key}
            onClick={() => {
              setTypeF(f.key);
              close();
            }}
          />
        ))}
      </>
    ));

  const statusMenu = (e: MouseEvent) =>
    openMenu(e, (close) => (
      <>
        <MenuLabel>{t("按状态")}</MenuLabel>
        {STATUS_FILTERS.map((f) => (
          <MenuItem
            key={f.key}
            label={f.label}
            checked={statusF === f.key}
            onClick={() => {
              setStatusF(f.key);
              close();
            }}
          />
        ))}
      </>
    ));

  const typeFilterLabel = TYPE_FILTERS.find((f) => f.key === typeF)!.label;
  const statusFilterLabel = STATUS_FILTERS.find((f) => f.key === statusF)!.label;

  return (
    <Modal
      title={source.title}
      sub={source.subtitle}
      width={760}
      footer={
        <>
          <div class="blob-mgr-selsum">
            {sel.size > 0 ? (
              t("已选 {n} 项 · {bytes}", { n: sel.size, bytes: fmtBytes(selBytes) })
            ) : rows ? (
              t("共 {n} 项 · {bytes}", { n: rows.length, bytes: fmtBytes(rows.reduce((s, r) => s + r.size, 0)) })
            ) : (
              ""
            )}
          </div>
          <button class="btn btn-secondary" disabled={busy || !selClearable.length} onClick={() => void doClear()}>
            <Icon name="trash" cls="ico sm" />
            {selClearable.length ? t("清理所选（{n}）", { n: selClearable.length }) : t("清理所选")}
          </button>
          <button class="btn btn-danger" disabled={busy || !selOrphans.length} onClick={() => void doDelete()}>
            <Icon name="trash" cls="ico sm" />
            {selOrphans.length ? t("删除孤儿（{n}）", { n: selOrphans.length }) : t("删除孤儿")}
          </button>
          <button class="btn btn-ghost" onClick={() => closeModal()}>
            {t("关闭")}
          </button>
        </>
      }
    >
      <div class="blob-mgr">
        <div class="blob-mgr-bar">
          <div class="blob-mgr-search">
            <Icon name="search" cls="ico sm" />
            <input
              class="blob-mgr-search-in"
              placeholder={t("搜索 hash 或类型…")}
              value={query}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            />
          </div>
          <button class={"btn btn-ghost blob-mgr-fbtn" + (typeF !== "all" ? " on" : "")} onClick={(e) => typeMenu(e)}>
            <Icon name="filter" cls="ico sm" />
            {typeFilterLabel}
          </button>
          <button class={"btn btn-ghost blob-mgr-fbtn" + (statusF !== "all" ? " on" : "")} onClick={(e) => statusMenu(e)}>
            <Icon name="filter" cls="ico sm" />
            {statusFilterLabel}
          </button>
          <button class="btn btn-ghost blob-mgr-fbtn" onClick={(e) => sortMenu(e)}>
            <Icon name="sort" cls="ico sm" />
            {SORT_LABEL[sort.key]}
            {sort.desc ? " ↓" : " ↑"}
          </button>
        </div>

        {err ? (
          <div class="blob-mgr-empty">{t("无法读取：{err}", { err })}</div>
        ) : !rows ? (
          <div class="blob-mgr-empty">{t("加载中…")}</div>
        ) : filtered.length === 0 ? (
          <div class="blob-mgr-empty">{rows.length ? t("没有符合条件的项") : t("这台设备还没有缓存的 blob")}</div>
        ) : (
          <div class="blob-mgr-list">
            <div class="blob-mgr-row blob-mgr-head">
              <label class="blob-mgr-check">
                <input type="checkbox" checked={allShownSelected} onChange={toggleAll} />
              </label>
              <span />
              <span>{t("名称")}</span>
              <span class="blob-mgr-r">{t("大小")}</span>
              <span>{t("状态")}</span>
              <span class="blob-mgr-age">{t("最近使用")}</span>
              <span />
            </div>
            {filtered.map((b) => {
              const kind = blobKind(b.contentType);
              const status = blobStatus(b);
              return (
                <div class={"blob-mgr-row" + (sel.has(b.hash) ? " sel" : "")} key={b.hash}>
                  <label class="blob-mgr-check">
                    <input type="checkbox" checked={sel.has(b.hash)} onChange={() => toggle(b.hash)} />
                  </label>
                  <BlobThumb row={b} />
                  <div class="blob-mgr-name">
                    <span class="blob-mgr-hash">{b.hash.slice(0, 12)}</span>
                    <span class="blob-mgr-type">{b.contentType ?? KIND_LABEL[kind]}</span>
                  </div>
                  <span class="blob-mgr-r blob-mgr-size">{fmtBytes(b.size)}</span>
                  <span class={"blob-mgr-badge s-" + status}>{STATUS_LABEL[status]}</span>
                  <span class="blob-mgr-age">{b.lastAccess ? timeAgo(b.lastAccess) : "—"}</span>
                  <button
                    class={"blob-mgr-pin" + (b.pinned ? " on" : "")}
                    disabled={busy || b.pending}
                    title={b.pinned ? t("取消固定") : t("固定（不被自动清理）")}
                    onClick={() => void togglePin(b)}
                  >
                    <Icon name="pin" cls="ico sm" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
