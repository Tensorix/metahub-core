/** @jsxImportSource preact */
// Blob 管理弹窗（设置 → 存储 → 本机存储）。一个共享面板，按需打开，列出这台设备
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

/** Server-backed source: BlobCacheSettings (desktop + server WebUI). */
function serverSource(): BlobSource {
  return {
    title: "Blob 管理",
    subtitle:
      "图片和大文件的本机副本。可清理项随时能腾空间（用时自动取回）；没被任何文档或站点引用的孤儿可彻底删除。",
    deleteSemantics: "purge",
    list: () => api.blobs(),
    clear: (h) => api.clearBlobs(h),
    remove: (h) => api.deleteBlobs(h),
    pin: async (h, p) => {
      await api.pinBlob(h, p);
    },
  };
}

/** No-origin source: blobs live in the browser byte cache; the bucket is the durable
 *  home and is never mutated from the client, so an unpinned cached byte is always
 *  re-downloadable (clearable) and a "delete" is just a local eviction. */
function localSource(): BlobSource {
  return {
    title: "Blob 管理",
    subtitle:
      "已下载到这台设备的图片和大文件。清理只删本机副本，需要时从云端重新取回；桶里的原件始终不动。",
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

export function openServerBlobManager(): void {
  openModal(<BlobManager source={serverSource()} />);
}
export function openLocalBlobManager(): void {
  openModal(<BlobManager source={localSource()} />);
}

// ---- helpers -----------------------------------------------------------------

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtAgo(ts: number | null): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "刚刚";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

type Kind = "image" | "video" | "audio" | "file" | "other";
const KIND_LABEL: Record<Kind, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
  file: "文件",
  other: "其他",
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
  const t = ct.toLowerCase();
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  if (t.startsWith("application/") || t.startsWith("text/")) return "file";
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
  pending: "待上传",
  pinned: "已固定",
  orphan: "孤儿",
  clearable: "可清理",
  retained: "保留",
};

type SortKey = "size" | "type" | "access";
const SORT_LABEL: Record<SortKey, string> = { size: "大小", type: "类型", access: "最近使用" };

const TYPE_FILTERS: { key: Kind | "all"; label: string }[] = [
  { key: "all", label: "全部类型" },
  { key: "image", label: "图片" },
  { key: "video", label: "视频" },
  { key: "audio", label: "音频" },
  { key: "file", label: "文件" },
  { key: "other", label: "其他" },
];
const STATUS_FILTERS: { key: Status | "all"; label: string }[] = [
  { key: "all", label: "全部状态" },
  { key: "clearable", label: "可清理" },
  { key: "retained", label: "保留中" },
  { key: "pinned", label: "已固定" },
  { key: "pending", label: "待上传" },
  { key: "orphan", label: "孤儿" },
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
      toast(r.cleared ? `已清理 ${r.cleared} 项 · 腾出 ${fmtBytes(r.freedBytes)}` : "没有可清理的项");
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
      title: "删除孤儿 blob",
      message: evict
        ? `将从这台设备移除 ${orphans.length} 个未被任何文档/站点引用的 blob，约 ${fmtBytes(bytes)}。桶里的原件不动，需要时仍可重新下载。`
        : `将永久删除 ${orphans.length} 个未被任何文档/站点引用的 blob，约 ${fmtBytes(bytes)}。此操作不可恢复。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await source.remove(orphans.map((o) => o.hash));
      toast(r.removed ? `已删除 ${r.removed} 项 · 腾出 ${fmtBytes(r.freedBytes)}` : "没有可删除的孤儿");
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
        <MenuLabel>排序依据</MenuLabel>
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
        <MenuLabel>按类型</MenuLabel>
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
        <MenuLabel>按状态</MenuLabel>
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
              <>
                已选 <b>{sel.size}</b> 项 · {fmtBytes(selBytes)}
              </>
            ) : rows ? (
              <>
                共 {rows.length} 项 · {fmtBytes(rows.reduce((s, r) => s + r.size, 0))}
              </>
            ) : (
              ""
            )}
          </div>
          <button class="btn btn-secondary" disabled={busy || !selClearable.length} onClick={() => void doClear()}>
            <Icon name="trash" cls="ico sm" />
            清理所选{selClearable.length ? `（${selClearable.length}）` : ""}
          </button>
          <button class="btn btn-danger" disabled={busy || !selOrphans.length} onClick={() => void doDelete()}>
            <Icon name="trash" cls="ico sm" />
            删除孤儿{selOrphans.length ? `（${selOrphans.length}）` : ""}
          </button>
          <button class="btn btn-ghost" onClick={() => closeModal()}>
            关闭
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
              placeholder="搜索 hash 或类型…"
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
          <div class="blob-mgr-empty">无法读取：{err}</div>
        ) : !rows ? (
          <div class="blob-mgr-empty">加载中…</div>
        ) : filtered.length === 0 ? (
          <div class="blob-mgr-empty">{rows.length ? "没有符合条件的项" : "这台设备还没有缓存的 blob"}</div>
        ) : (
          <div class="blob-mgr-list">
            <div class="blob-mgr-row blob-mgr-head">
              <label class="blob-mgr-check">
                <input type="checkbox" checked={allShownSelected} onChange={toggleAll} />
              </label>
              <span />
              <span>名称</span>
              <span class="blob-mgr-r">大小</span>
              <span>状态</span>
              <span class="blob-mgr-age">最近使用</span>
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
                  <span class="blob-mgr-age">{fmtAgo(b.lastAccess)}</span>
                  <button
                    class={"blob-mgr-pin" + (b.pinned ? " on" : "")}
                    disabled={busy || b.pending}
                    title={b.pinned ? "取消固定" : "固定（不被自动清理）"}
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
