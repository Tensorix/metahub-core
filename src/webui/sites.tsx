/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";
import {
  api,
  type Site,
  type SiteFile,
  type ShareListItem,
  type SiteHostingInfo,
} from "./api.ts";
import { normalizeSiteName } from "../core/sites-core.ts";
import {
  siteChannelInput,
  siteChannels,
  siteState,
  siteCardAddress,
  SITE_STATE_LABEL,
  CHANNEL_STATUS_LABEL,
  channelAudienceLabel,
  channelHostingLabel,
} from "./site-status.ts";
import { openShareModal, SHARES_CHANGED } from "./share-modal.tsx";
import { Icon } from "./icons.tsx";
import type { Navigate } from "./view.ts";
import {
  openMenu,
  MenuItem,
  MenuSep,
  toast,
  confirmDialog,
  promptDialog,
  openModal,
  closeModal,
  Modal,
} from "./ui.tsx";

// "站点管理" — GUI over the static-file sites the `mh site` CLI publishes. Sites
// are served at /sites/<name>/, so preview just points an iframe at the real URL
// (no inlining) and file preview fetches the served bytes.

/** Broadcast after a site is created / deleted / renamed, so site lists outside
 *  this view (the sidebar's 站点 pane) refresh — SitesView reloads itself too,
 *  which lets a sidebar-created site land before the ?site= deep link resolves. */
export const SITES_CHANGED = "mh-sites-changed";
export function notifySitesChanged(): void {
  document.dispatchEvent(new Event(SITES_CHANGED));
}

const siteUrl = (name: string) => location.origin + "/sites/" + name + "/";
// Display form: drop the shared `${origin}/sites` prefix (identical for every
// site) and show only the part that varies. Full URL is still used for copy/open.
const siteUrlShort = (name: string) => "/sites/" + name + "/";
const ext = (p: string) => (/\.([a-z0-9]+)$/i.exec(p)?.[1] ?? "").toLowerCase();
const isImage = (ct: string) => ct.startsWith("image/");

function fmtDate(hlc: string): string {
  const ms = Number(hlc.split("-")[0]);
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  return new Date(ms).toISOString().slice(0, 10);
}

function fileIcon(f: SiteFile): string {
  const e = ext(f.path);
  if (["html", "htm", "js", "mjs", "css", "json", "xml"].includes(e)) return "code";
  if (isImage(f.content_type)) return "file";
  if (["md", "txt"].includes(e)) return "text";
  return "file";
}

function copyText(t: string) {
  navigator.clipboard?.writeText(t).catch(() => {});
  toast("已复制");
}

/** Human-readable byte size; null (blob bytes not held locally) renders "—". */
function fmtSize(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---- directory upload (drag-drop + webkitdirectory fallback) -----------------

interface DroppedFile {
  path: string;
  file: File;
}
interface UploadFailure {
  path: string;
  error: string;
}

/** Hidden files/dirs (.DS_Store, .git/…) never publish. */
const HIDDEN_RE = /(^|\/)\./;

/** Recursively read a FileSystemEntry (webkitGetAsEntry) into path+File pairs,
 *  keeping relative paths. readEntries hands out ≤100 entries per call — loop
 *  until it comes back empty or big directories silently truncate. */
async function collectEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: DroppedFile[],
): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    out.push({ path: prefix + entry.name, file });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await collectEntry(e, prefix + entry.name + "/", out);
    }
  }
}

/** Grab a drop's entries SYNCHRONOUSLY (DataTransfer items are dead once the
 *  handler yields) so the async walk can run afterwards. Browsers without
 *  webkitGetAsEntry fall back to the flat file list. */
function dropEntries(dt: DataTransfer): { entries: FileSystemEntry[]; files: File[] } {
  const entries = Array.from(dt.items ?? [])
    .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => e != null);
  return { entries, files: Array.from(dt.files ?? []) };
}

async function collectDropped(drop: {
  entries: FileSystemEntry[];
  files: File[];
}): Promise<DroppedFile[]> {
  const out: DroppedFile[] = [];
  if (drop.entries.length) for (const e of drop.entries) await collectEntry(e, "", out);
  else for (const f of drop.files) out.push({ path: f.name, file: f });
  return out.filter((f) => !HIDDEN_RE.test(f.path));
}

/** Upload a batch through a small worker pool (≤4), reporting progress.
 *  Failures collect instead of aborting so one bad file doesn't strand the
 *  rest of the directory. */
async function uploadBatch(
  siteRef: string,
  files: DroppedFile[],
  onProgress: (done: number, total: number) => void,
): Promise<UploadFailure[]> {
  let next = 0;
  let done = 0;
  const failed: UploadFailure[] = [];
  const width = Math.max(1, Math.min(4, files.length));
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < files.length) {
        const f = files[next++]!;
        try {
          await api.uploadSiteFile(siteRef, f.path, f.file);
        } catch (e) {
          failed.push({ path: f.path, error: (e as Error).message });
        }
        onProgress(++done, files.length);
      }
    }),
  );
  return failed;
}

/** Strip a shared leading directory segment (a webkitdirectory pick or a single
 *  dropped folder) so the folder's CONTENTS land at the site root — matching
 *  `mh site publish` and the grid's publish-a-directory drop, so the same files
 *  don't 404 at the root just because of the gesture used. Loose files with no
 *  common segment are left untouched (they land at the root by name). */
function stripCommonDirPrefix(files: DroppedFile[]): DroppedFile[] {
  if (files.length === 0) return files;
  const seg = (p: string) => (p.includes("/") ? p.slice(0, p.indexOf("/")) : null);
  const first = seg(files[0]!.path);
  if (!first || !files.every((f) => seg(f.path) === first)) return files;
  return files.map((f) => ({ ...f, path: f.path.slice(first.length + 1) }));
}

/** Heads-up for files under the reserved api/ namespace: they upload but are
 *  permanently shadowed by the site's data-API route (parity with the CLI's
 *  publishDirectory warning). Non-blocking — the upload still proceeds. */
function warnReservedApiPaths(files: DroppedFile[]): void {
  const n = files.filter((f) => f.path === "api" || f.path.startsWith("api/")).length;
  if (n) toast(`${n} 个 api/ 下的文件会被站点数据 API 遮蔽（仍会上传，但无法访问）`);
}

function reportUpload(total: number, failed: UploadFailure[]) {
  if (!failed.length) return toast(`已上传 ${total} 个文件`);
  toast(`已上传 ${total - failed.length}/${total} 个，${failed.length} 个失败`);
  openModal(<UploadFailuresModal failed={failed} />);
}

function UploadFailuresModal({ failed }: { failed: UploadFailure[] }) {
  return (
    <Modal
      title="部分文件上传失败"
      sub={`${failed.length} 个文件未能上传，可修正后重新拖入（成功的文件无需重传）。`}
      footer={
        <button class="btn btn-primary" onClick={closeModal}>
          关闭
        </button>
      }
    >
      <div style={{ maxHeight: 260, overflow: "auto", fontSize: 13 }}>
        {failed.map((f) => (
          <div key={f.path} style={{ padding: "4px 0", borderBottom: "1px solid var(--line)" }}>
            <div style={{ fontFamily: "var(--mono)" }}>{f.path}</div>
            <div class="muted">{f.error}</div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function UploadProgress({ done, total }: { done: number; total: number }) {
  return (
    <div
      style={{
        position: "fixed",
        bottom: 24,
        left: "50%",
        transform: "translateX(-50%)",
        background: "var(--fg)",
        color: "var(--bg)",
        padding: "10px 14px",
        borderRadius: 9,
        fontSize: 13,
        boxShadow: "var(--shadow-lg)",
        zIndex: 300,
      }}
    >
      上传中 {done}/{total}…
    </div>
  );
}

/** The shared per-site "更多" menu (grid cards, the sidebar's 站点 pane, the
 *  config page). Every mutation broadcasts SITES_CHANGED, so each open list /
 *  page refreshes itself — no reload callback threads through here. */
export function openSiteMenu(
  e: MouseEvent,
  s: Site,
  opts?: {
    onOpenConfig?: () => void;
    /** Called with the new slug after a successful rename (fix stale routes). */
    onRenamed?: (newName: string) => void;
    onDeleted?: () => void;
  },
) {
  const toggleSpa = async () => {
    try {
      await api.updateSite(s.id, { spa: s.spa !== 1 });
    } catch (err) {
      return toast((err as Error).message);
    }
    toast(s.spa === 1 ? "已关闭 SPA 模式" : "已开启 SPA 模式（无扩展名路径回落到 index.html）");
    notifySitesChanged();
  };
  openMenu(e, (close) => (
    <>
      {opts?.onOpenConfig && (
        <MenuItem
          icon="settings"
          label="配置管理"
          onClick={() => {
            close();
            opts.onOpenConfig!();
          }}
        />
      )}
      <MenuItem
        icon="externalLink"
        label="复制私有预览地址"
        onClick={() => {
          close();
          copyText(siteUrl(s.name));
        }}
      />
      <MenuItem
        icon="link"
        label="发布与分享…"
        onClick={() => {
          close();
          openShareModal({ kind: "site", ref: s.id, title: s.title ?? s.name });
        }}
      />
      <MenuItem
        icon="code"
        label={s.spa === 1 ? "关闭 SPA 模式" : "开启 SPA 模式"}
        onClick={() => {
          close();
          toggleSpa();
        }}
      />
      <MenuItem
        icon="pencil"
        label="修改标题…"
        onClick={async () => {
          close();
          const t = await promptDialog({
            title: "修改标题",
            label: "标题",
            value: s.title ?? s.name,
          });
          if (t == null) return;
          try {
            await api.updateSite(s.id, { title: t });
          } catch (err) {
            return toast((err as Error).message);
          }
          notifySitesChanged();
        }}
      />
      <MenuItem
        icon="hash"
        label="重命名（slug）…"
        onClick={() => {
          close();
          openModal(<RenameSlugModal site={s} onRenamed={(n) => opts?.onRenamed?.(n)} />);
        }}
      />
      <MenuSep />
      <MenuItem
        icon="trash"
        label="删除站点"
        danger
        onClick={async () => {
          close();
          const ok = await confirmDialog({
            title: "删除站点？",
            message: `「${s.name}」及其 ${s.file_count} 个文件将被删除。`,
            confirmLabel: "删除",
            danger: true,
          });
          if (!ok) return;
          try {
            await api.deleteSite(s.id);
          } catch (err) {
            return toast((err as Error).message);
          }
          notifySitesChanged();
          opts?.onDeleted?.();
        }}
      />
    </>
  ));
}

export function SitesView({ navigate }: { navigate: Navigate }) {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [drag, setDrag] = useState(false);
  const [upload, setUpload] = useState<{ done: number; total: number } | null>(null);
  const [shares, setShares] = useState<ShareListItem[]>([]);
  const [hostingInfo, setHostingInfo] = useState<SiteHostingInfo | null>(null);

  const reload = () =>
    api
      .listSites()
      .then(setSites)
      .catch((e) => toast(`加载失败：${e.message}`));
  const reloadHosting = () =>
    api.getSiteHosting().then(setHostingInfo).catch(() => setHostingInfo(null));

  useEffect(() => {
    reload();
    const loadShares = () => api.listShares().then(setShares).catch(() => undefined);
    const refreshPublishState = () => {
      loadShares();
      reload();
      reloadHosting();
    };
    loadShares();
    reloadHosting();
    document.addEventListener(SHARES_CHANGED, refreshPublishState);
    document.addEventListener(SITES_CHANGED, reload);
    return () => {
      document.removeEventListener(SHARES_CHANGED, refreshPublishState);
      document.removeEventListener(SITES_CHANGED, reload);
    };
  }, []);

  // A fresh site has no files: land on the config page, where uploads live.
  const newSite = () =>
    openModal(<NewSiteModal onCreated={(site) => navigate({ kind: "site", name: site.name, tab: "config" })} />);

  // Dropping a DIRECTORY on the list publishes it as a site (dir name = slug),
  // mirroring `mh site publish <name> <dir> --create`: a missing site is only
  // created after an explicit confirm.
  const onGridDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (upload) return;
    const drop = dropEntries(e.dataTransfer!); // sync — before any await
    if (drop.entries.length !== 1 || !drop.entries[0]!.isDirectory)
      return toast("拖入一个目录即可上传为站点（目录名 = 站点名）");
    const dirName = drop.entries[0]!.name;
    let slug: string;
    try {
      slug = normalizeSiteName(dirName);
    } catch {
      return toast(`目录名「${dirName}」无法转成有效的站点名`);
    }
    const all = await collectDropped(drop);
    // publish semantics: the dropped directory's CONTENTS become the site root
    const inner = all.map((f) => ({ ...f, path: f.path.slice(dirName.length + 1) }));
    if (!inner.length) return toast("目录里没有可上传的文件");
    warnReservedApiPaths(inner);
    let target = (sites ?? []).find((s) => s.name === slug) ?? null;
    if (!target) {
      const ok = await confirmDialog({
        title: `创建站点「${slug}」？`,
        message: `站点「${slug}」不存在。创建它并上传 ${inner.length} 个文件？`,
        confirmLabel: "创建并上传",
      });
      if (!ok) return;
      try {
        target = await api.createSite({ name: slug });
      } catch (err) {
        return toast((err as Error).message);
      }
      notifySitesChanged();
    }
    setUpload({ done: 0, total: inner.length });
    const failed = await uploadBatch(target.id, inner, (done, total) => setUpload({ done, total }));
    setUpload(null);
    reportUpload(inner.length, failed);
    notifySitesChanged();
    navigate({ kind: "site", name: target.name, tab: "config" });
  };

  return (
    <div
      class="db sites-page"
      onDragOver={(e) => {
        if (!e.dataTransfer?.types.includes("Files")) return;
        e.preventDefault();
        if (!upload) setDrag(true);
      }}
      onDragLeave={(e) => {
        if (!(e.currentTarget as Node).contains(e.relatedTarget as Node)) setDrag(false);
      }}
      onDrop={onGridDrop}
      style={drag ? { outline: "2px dashed var(--accent)", outlineOffset: -8, borderRadius: 12 } : undefined}
    >
      <div class="db-head">
        <div>
          <div class="db-title">站点管理</div>
          <div class="db-desc">发布静态站点，生成可分享的访问链接。</div>
        </div>
        <button class="btn btn-primary site-new" onClick={newSite}>
          <Icon name="plus" cls="ico sm" />
          新建站点
        </button>
      </div>

      {sites == null ? (
        <div class="muted" style={{ padding: 20 }}>
          加载中…
        </div>
      ) : sites.length === 0 ? (
        <div class="site-empty">
          <div class="ei"><Icon name="globe" /></div>
          <div class="et">还没有站点</div>
          <div class="ed">站点是一组网页文件，可先在本机预览，发布后供他人访问。</div>
          <button class="btn btn-primary" onClick={newSite}>
            <Icon name="plus" cls="ico sm" />
            新建站点
          </button>
        </div>
      ) : (
        <>
          <div class="sites-grid">
            {sites.map((s, i) => (
              (() => {
                const pendingRollback = hostingInfo?.pendingRollbacks.find((x) => x.siteId === s.id);
                // One shared derivation (core site-channels) — cards, the peek
                // drawer and the publish dialog must answer identically.
                const input = siteChannelInput(s, shares, hostingInfo);
                const channels = siteChannels(input);
                const state = SITE_STATE_LABEL[siteState(input)];
                // Four-rule address slot (site-status.ts): a capability link is
                // an access-granting SECRET and never appears as the card
                // address — only counts.
                const addr = siteCardAddress(channels);
                return (
              <div class="site-card" key={s.id} style={`--i:${i}`} onClick={() => navigate({ kind: "site", name: s.name })}>
                <div class="site-card-head">
                  <span class="si">
                    <Icon name="globe" />
                  </span>
                  <div class="site-card-id">
                    <div class="slug">{s.name}</div>
                    <div class={"ttl" + (s.title ? "" : " muted")}>{s.title || "未命名站点"}</div>
                  </div>
                  {channels.length > 0 && (
                    <span
                      class="share-badge"
                      title={state}
                      style={{ marginLeft: "auto" }}
                    >
                      <Icon
                        name={
                          addr.kind === "public" || addr.kind === "public_multi"
                            ? "globe"
                            : "lock"
                        }
                      />
                    </span>
                  )}
                </div>
                <div class="muted" style={{ fontSize: 12, marginBottom: 4 }}>{state}</div>
                <button
                  class="site-addr"
                  title={
                    addr.kind === "public"
                      ? "点击复制公开地址"
                      : addr.kind === "public_multi"
                        ? "存在多个公开地址；打开详情选择"
                        : addr.kind === "links_only"
                          ? "私密链接不在卡片显示；打开详情管理"
                          : "点击复制私有预览地址"
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    if (addr.kind === "public") copyText(addr.url);
                    else if (addr.kind === "preview") copyText(siteUrl(s.name));
                    else navigate({ kind: "site", name: s.name, tab: "config" });
                  }}
                >
                  <Icon
                    name={
                      addr.kind === "public" || addr.kind === "public_multi"
                        ? "globe"
                        : addr.kind === "links_only"
                          ? "lock"
                          : "link"
                    }
                    cls="ico sm"
                  />
                  <span>
                    {addr.kind === "public"
                      ? addr.url
                      : addr.kind === "public_multi"
                        ? `${addr.count} 个公开地址`
                        : addr.kind === "links_only"
                          ? `${addr.count} 个私密链接`
                          : `私有预览 · ${siteUrlShort(s.name)}`}
                  </span>
                </button>
                <div class="site-card-meta">
                  <span>
                    <b>{s.file_count}</b> 文件
                  </span>
                  <span class="dot">·</span>
                  <span>{fmtDate(s.created_hlc)}</span>
                </div>
                <div class="site-card-foot">
                  <button
                    class="btn btn-secondary"
                    style={{ flex: 1 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate({ kind: "site", name: s.name });
                    }}
                  >
                    <Icon name="globe" cls="ico sm" />
                    预览
                  </button>
                  <button
                    class={"btn " + (pendingRollback ? "btn-danger" : "btn-primary")}
                    style={{ flex: 1 }}
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (pendingRollback) {
                        try {
                          const result = await api.recoverSitePublish(
                            pendingRollback.siteId,
                            pendingRollback.peerUrl,
                          );
                          if (result.status === "rollback_pending")
                            toast(`回滚仍未确认：${result.error ?? "目标设备不可达"}`);
                          else toast("目标设备已确认恢复发布前状态");
                          await reloadHosting();
                        } catch (err) {
                          toast((err as Error).message);
                        }
                        return;
                      }
                      openShareModal({ kind: "site", ref: s.id, title: s.title ?? s.name });
                    }}
                  >
                    <Icon name="link" cls="ico sm" />
                    {pendingRollback ? "重试回滚" : channels.length ? "管理" : "发布"}
                  </button>
                  <button
                    class="iconbtn"
                    title="更多"
                    onClick={(e) => {
                      e.stopPropagation();
                      openSiteMenu(e as unknown as MouseEvent, s, {
                        onOpenConfig: () => navigate({ kind: "site", name: s.name, tab: "config" }),
                      });
                    }}
                  >
                    <Icon name="dots" />
                  </button>
                </div>
              </div>
                );
              })()
            ))}
          </div>
          <div class="gridfoot">
            <span>共 {sites.length} 个站点</span>
            <span>{sites.reduce((n, s) => n + s.file_count, 0)} 个文件</span>
          </div>
        </>
      )}

      {upload && <UploadProgress done={upload.done} total={upload.total} />}
    </div>
  );
}

export function NewSiteModal({ onCreated }: { onCreated: (s: Site) => void }) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const create = async () => {
    // Same canonicalization core applies on write (one shared slugify).
    let slug: string;
    try {
      slug = normalizeSiteName(name);
    } catch {
      return toast("请填写站点名称");
    }
    try {
      const site = await api.createSite({ name: slug, title: title.trim() || undefined });
      closeModal();
      toast(`已创建站点「${slug}」`);
      notifySitesChanged();
      onCreated(site);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <Modal
      title="新建站点"
      sub="创建一组网页文件，随你的设备自动同步。"
      footer={
        <>
          <button class="btn btn-secondary" onClick={closeModal}>
            取消
          </button>
          <button class="btn btn-primary" onClick={create}>
            创建
          </button>
        </>
      }
    >
      <div class="field-label">名称（slug）</div>
      <input
        class="text-input"
        autofocus
        value={name}
        placeholder="例如：docs、demo、status"
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") create();
        }}
      />
      <div class="field-label">标题（可选）</div>
      <input
        class="text-input"
        value={title}
        placeholder="人类可读的标题"
        onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") create();
        }}
      />
      <div class="muted" style={{ fontSize: 12, marginTop: 10 }}>
        将通过 <span style={{ fontFamily: "var(--mono)" }}>/sites/&lt;名称&gt;/</span> 对外提供。
      </div>
    </Modal>
  );
}

/** Rename a site's slug: live preview of the canonical (normalized) result,
 *  loud old-links warning; the PATCH guards duplicates (conflict → toast). */
function RenameSlugModal({ site, onRenamed }: { site: Site; onRenamed: (newName: string) => void }) {
  const [name, setName] = useState(site.name);
  const [busy, setBusy] = useState(false);
  // Same canonicalization core applies on write — what you see is what's saved.
  let preview: string | null = null;
  try {
    preview = normalizeSiteName(name);
  } catch {
    preview = null;
  }
  const changed = preview != null && preview !== site.name;
  const save = async () => {
    if (!preview) return toast("请输入有效的站点名（a-z、0-9、-）");
    if (!changed) return closeModal();
    setBusy(true);
    try {
      await api.updateSite(site.id, { name: preview });
      closeModal();
      toast(`已重命名为「${preview}」`);
      notifySitesChanged();
      onRenamed(preview);
    } catch (e) {
      toast((e as Error).message); // e.g. conflict: name already exists
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="重命名（slug）"
      sub="slug 决定站点的访问地址 /sites/<slug>/。"
      footer={
        <>
          <button class="btn btn-secondary" onClick={closeModal}>
            取消
          </button>
          <button class="btn btn-primary" disabled={busy || !preview} onClick={save}>
            {busy ? "保存中…" : "重命名"}
          </button>
        </>
      }
    >
      <div class="field-label">新名称（slug）</div>
      <input
        class="text-input"
        autofocus
        value={name}
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
        }}
      />
      <div class="muted" style={{ fontSize: 12, marginTop: 8, fontFamily: "var(--mono)" }}>
        {preview ? `将保存为 /sites/${preview}/` : "无法从输入得到有效的站点名"}
      </div>
      {changed && (
        <div style={{ fontSize: 12, marginTop: 8, color: "var(--danger, #c0392b)" }}>
          注意：重命名后旧链接将失效 — /sites/{site.name}/ 不再可访问，已分发的地址需要更新。
        </div>
      )}
    </Modal>
  );
}

/** Full-page per-site view (#/site/<name>): the default mode renders the real
 *  served site in an iframe; ?view=config is the management page that replaced
 *  the old peek drawer (upload, publish channels, file list). Resolves the site
 *  by slug itself, so it deep-links and survives refresh. */
export function SiteView({
  name,
  tab,
  navigate,
  onResolved,
}: {
  name: string;
  tab?: "config";
  navigate: Navigate;
  // The app shell's topbar carries this site's global actions (发布与分享 / ⋯),
  // so it needs the resolved Site object; null while loading / when missing.
  onResolved?: (site: Site | null) => void;
}) {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [shares, setShares] = useState<ShareListItem[]>([]);
  const [hostingInfo, setHostingInfo] = useState<SiteHostingInfo | null>(null);
  const site = sites?.find((s) => s.name === name) ?? null;

  useEffect(() => {
    onResolved?.(site);
  }, [site?.id, site?.name, site?.title, site?.file_count, site?.spa]);
  useEffect(() => () => onResolved?.(null), []);

  useEffect(() => {
    const load = () => api.listSites().then(setSites).catch((e) => toast(`加载失败：${e.message}`));
    const loadShares = () => api.listShares().then(setShares).catch(() => undefined);
    const loadHosting = () =>
      api.getSiteHosting().then(setHostingInfo).catch(() => setHostingInfo(null));
    const refresh = () => {
      load();
      loadShares();
      loadHosting();
    };
    refresh();
    document.addEventListener(SHARES_CHANGED, refresh);
    document.addEventListener(SITES_CHANGED, load);
    return () => {
      document.removeEventListener(SHARES_CHANGED, refresh);
      document.removeEventListener(SITES_CHANGED, load);
    };
  }, []);

  if (sites == null)
    return (
      <div class="muted" style={{ padding: 24 }}>
        加载中…
      </div>
    );
  if (!site)
    return (
      <div class="site-empty" style={{ marginTop: 60 }}>
        <div class="ei">
          <Icon name="globe" />
        </div>
        <div class="et">站点不存在</div>
        <div class="ed">「{name}」可能已被删除或重命名。</div>
        <button class="btn btn-secondary" onClick={() => navigate({ kind: "sites" })}>
          查看全部站点
        </button>
      </div>
    );
  if (tab === "config")
    return <SiteConfig site={site} shares={shares} hostingInfo={hostingInfo} navigate={navigate} />;
  return <SiteVisit site={site} navigate={navigate} />;
}

function SiteVisit({ site, navigate }: { site: Site; navigate: Navigate }) {
  if (site.file_count === 0)
    return (
      <div class="site-empty" style={{ marginTop: 60 }}>
        <div class="ei">📁</div>
        <div class="et">站点还没有文件</div>
        <div class="ed">上传文件后，这里会直接显示站点页面。</div>
        <button
          class="btn btn-primary"
          onClick={() => navigate({ kind: "site", name: site.name, tab: "config" })}
        >
          <Icon name="upload" cls="ico sm" />
          去配置
        </button>
      </div>
    );
  return (
    <div class="site-visit">
      {/* Published sites assume a standalone white canvas, so the frame forces
          one regardless of the app theme. */}
      <iframe
        class="site-frame"
        src={"/sites/" + site.name + "/"}
        sandbox="allow-scripts allow-same-origin"
        title={site.title || site.name}
      />
    </div>
  );
}

/** Live thumbnail of the served site: the real page in a sandboxed iframe,
 *  laid out at a 1280px design width and scaled down by CSS (--w). Inert to
 *  the pointer; the wrapping button opens the visit page. `ver` remounts the
 *  frame after file changes so the picture tracks the current files. */
function SiteThumb({
  site,
  hasFiles,
  ver,
  onClick,
}: {
  site: Site;
  hasFiles: boolean;
  ver: number;
  onClick: () => void;
}) {
  if (!hasFiles)
    return (
      <div class="site-thumb empty">
        <Icon name="upload" cls="ico" />
        <span>还没有文件</span>
      </div>
    );
  return (
    <button class="site-thumb" title="打开站点" onClick={onClick}>
      <iframe
        key={ver}
        src={"/sites/" + site.name + "/?_t=" + ver}
        sandbox="allow-scripts allow-same-origin"
        tabIndex={-1}
        aria-hidden="true"
        title=""
      />
      <span class="site-thumb-open">
        <Icon name="externalLink" cls="ico sm" />
        打开
      </span>
    </button>
  );
}

function SiteConfig({
  site,
  shares,
  hostingInfo,
  navigate,
}: {
  site: Site;
  shares: ShareListItem[];
  hostingInfo: SiteHostingInfo | null;
  navigate: Navigate;
}) {
  const channels = siteChannels(siteChannelInput(site, shares, hostingInfo));
  const [files, setFiles] = useState<SiteFile[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<{ done: number; total: number } | null>(null);
  const [drag, setDrag] = useState(false);
  // Bumped after every file change so the identity-card thumbnail remounts and
  // shows the site as it is now.
  const [thumbVer, setThumbVer] = useState(0);

  const reload = () =>
    api
      .listSiteFiles(site.id)
      .then(setFiles)
      .catch((e) => toast(e.message));

  // Load on site switch; ignore a stale response if the page moved to another
  // site before this one returned (avoids one site's files flashing under another).
  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    api
      .listSiteFiles(site.id)
      .then((fs) => !cancelled && setFiles(fs))
      .catch((e) => !cancelled && toast(e.message));
    return () => {
      cancelled = true;
    };
  }, [site.id]);

  // Shared upload tail for every source (file picker, directory picker, drop):
  // pooled uploads with progress, a failure list instead of an aborted batch,
  // and always a refresh from the server so the list reflects real state.
  const doUpload = async (list: DroppedFile[]) => {
    if (!list.length || upload) return;
    warnReservedApiPaths(list);
    setUpload({ done: 0, total: list.length });
    const failed = await uploadBatch(site.id, list, (done, total) => setUpload({ done, total }));
    setUpload(null);
    reportUpload(list.length, failed);
    reload();
    setThumbVer((v) => v + 1);
    notifySitesChanged(); // file_count changed — grid cards / sidebar refresh
  };

  const onPick = (e: Event) => {
    const input = e.target as HTMLInputElement;
    // A webkitdirectory pick carries webkitRelativePath (with the root dir name);
    // the plain file picker doesn't — those land at the site root by name.
    const list = Array.from(input.files ?? []).map((f) => ({
      path: f.webkitRelativePath || f.name,
      file: f,
    }));
    input.value = "";
    // A directory pick shares one root segment (webkitRelativePath) — strip it so
    // its contents fill the site root, like `mh site publish`.
    doUpload(stripCommonDirPrefix(list.filter((f) => !HIDDEN_RE.test(f.path))));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const drop = dropEntries(e.dataTransfer!); // sync — before any await
    // A single dropped folder fills the site root (its shared root segment is
    // stripped, matching the picker and CLI); loose files land at the root.
    collectDropped(drop).then((files) => doUpload(stripCommonDirPrefix(files)));
  };

  const removeFile = async (f: SiteFile) => {
    const ok = await confirmDialog({
      title: "删除文件？",
      message: `「${f.path}」将从站点「${site.name}」中删除。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteSiteFile(site.id, f.path);
    } catch (e) {
      return toast((e as Error).message);
    }
    reload();
    setThumbVer((v) => v + 1);
    notifySitesChanged();
  };

  const url = siteUrl(site.name);
  const urlShort = siteUrlShort(site.name);
  return (
    <div
      class="db site-config"
      onDragOver={(e) => {
        if (!e.dataTransfer?.types.includes("Files")) return;
        e.preventDefault();
        if (!upload) setDrag(true);
      }}
      onDragLeave={(e) => {
        if (!(e.currentTarget as Node).contains(e.relatedTarget as Node)) setDrag(false);
      }}
      onDrop={onDrop}
      style={drag ? { outline: "2px dashed var(--accent)", outlineOffset: -8, borderRadius: 12 } : undefined}
    >
      <div class="site-config-body">
        {/* Identity card: live thumbnail + name/slug/meta/status. Deliberately
            no buttons — the site's global actions live in the app topbar. */}
        <aside class="site-id">
          <SiteThumb
            site={site}
            hasFiles={(files?.length ?? site.file_count) > 0}
            ver={thumbVer}
            onClick={() => navigate({ kind: "site", name: site.name })}
          />
          <div class="site-id-text">
            <h1 class="site-id-title">{site.title || site.name}</h1>
            {site.title && <div class="site-id-slug">{site.name}</div>}
            <div class="site-id-meta">
              {files?.length ?? site.file_count} 个文件 · 创建于 {fmtDate(site.created_hlc)}
            </div>
            <span class={"chan-badge" + (channels.length ? " anyone" : "")}>
              {channels.length ? `已发布 · ${channels.length} 个渠道` : "私有"}
            </span>
          </div>
        </aside>
        <div class="site-config-main">
        <input ref={fileInput} type="file" multiple style={{ display: "none" }} onChange={onPick} />
        <input
          // webkitdirectory isn't in Preact's JSX attribute types — set it on
          // the element directly. Directory picks recurse client-side and
          // carry webkitRelativePath.
          ref={(el) => {
            dirInput.current = el;
            el?.setAttribute("webkitdirectory", "");
          }}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={onPick}
        />
          <div class="sc-sect-head">
            <span>访问</span>
            <span class="sc-side">仅你和已配对设备可打开</span>
          </div>
          <div class="acc-link">
            <span class="url">{urlShort}</span>
            <button title="复制地址" onClick={() => copyText(url)}>
              <Icon name="copy" cls="ico sm" />
            </button>
            <button class="accent" title="访问站点" onClick={() => navigate({ kind: "site", name: site.name })}>
              <Icon name="globe" cls="ico sm" />
            </button>
          </div>

          <div class="sc-sect-head">
            <span>发布渠道</span>
            <span class="sc-side">{channels.length || ""}</span>
          </div>
          {channels.length === 0 ? (
            <div class="muted" style={{ fontSize: 12, margin: "4px 0 20px" }}>
              还没有发布 — 目前只有你（和已配对设备）能打开上面的预览地址。
              <button
                class="linkbtn"
                onClick={() => openShareModal({ kind: "site", ref: site.id, title: site.title ?? site.name })}
              >
                发布与分享…
              </button>
            </div>
          ) : (
            <div style={{ marginBottom: 20 }}>
              {channels.map((c) => (
                <div class="chanrow" key={(c.slug ?? "public") + (c.url ?? "")}>
                  <span class={"chan-badge" + (c.audience === "anyone" ? " anyone" : "")}>
                    {channelAudienceLabel(c)}
                  </span>
                  <span class="chan-host">{channelHostingLabel(c)}托管</span>
                  <span
                    class={
                      "chan-status" +
                      (c.status === "rollback_pending" ||
                      c.status === "cleanup_pending" ||
                      c.status === "waiting_controller" ||
                      c.status === "error" ||
                      c.status === "expired"
                        ? " warn"
                        : c.status === "ready"
                          ? ""
                          : " busy")
                    }
                  >
                    {CHANNEL_STATUS_LABEL[c.status]}
                  </span>
                  {c.hasPassword && <span class="chan-host" title="需要口令">🔒</span>}
                  <span class="chan-url" title={c.url ?? undefined}>
                    {c.url ?? "—"}
                  </span>
                  {c.url && (
                    <>
                      <button title="复制地址" onClick={() => copyText(c.url!)}>
                        <Icon name="copy" cls="ico sm" />
                      </button>
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noreferrer"
                        style={{ display: "grid", placeItems: "center", width: 26, height: 26, color: "var(--muted)" }}
                        title="打开"
                      >
                        <Icon name="globe" cls="ico sm" />
                      </a>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          <div class="sc-sect-head">
            <span>文件{files != null ? ` · ${files.length}` : ""}</span>
            <span class="sc-acts">
              <button class="btn btn-ghost" onClick={() => fileInput.current?.click()}>
                <Icon name="upload" cls="ico sm" />
                上传文件
              </button>
              <button
                class="btn btn-ghost"
                title="上传整个目录（保留相对路径），也可以直接拖拽目录进来"
                onClick={() => dirInput.current?.click()}
              >
                <Icon name="upload" cls="ico sm" />
                上传目录
              </button>
            </span>
          </div>

          {files == null ? (
            <div class="muted">加载中…</div>
          ) : files.length === 0 ? (
            <div class="site-empty" style={{ marginTop: 4 }}>
              <div class="ei">📁</div>
              <div class="et">站点还没有文件</div>
              <div class="ed">上传文件后即可通过站点地址访问。</div>
              <button class="btn btn-secondary" onClick={() => fileInput.current?.click()}>
                <Icon name="upload" cls="ico sm" />
                上传文件
              </button>
            </div>
          ) : (
            <div>
              {files.map((f) => (
                <div
                  class="filerow"
                  key={f.id}
                  onClick={() => openModal(<FilePreviewModal site={site} file={f} />)}
                >
                  <span class="fi">
                    <Icon name={fileIcon(f)} cls="ico sm" />
                  </span>
                  <span class="fpath">{f.path}</span>
                  <span class="muted" style={{ fontSize: 12, whiteSpace: "nowrap" }} title="文件大小">
                    {fmtSize(f.size)}
                  </span>
                  <span class={"enc-badge" + (f.encoding === "blob" ? " blob" : "")}>
                    {f.encoding}
                  </span>
                  <div class="facts">
                    <button
                      title="预览"
                      onClick={(e) => {
                        e.stopPropagation();
                        openModal(<FilePreviewModal site={site} file={f} />);
                      }}
                    >
                      <Icon name="eye" cls="ico sm" />
                    </button>
                    <button
                      title="复制路径"
                      onClick={(e) => {
                        e.stopPropagation();
                        copyText("/sites/" + site.name + "/" + f.path);
                      }}
                    >
                      <Icon name="copy" cls="ico sm" />
                    </button>
                    <button
                      class="del"
                      title="删除"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeFile(f);
                      }}
                    >
                      <Icon name="trash" cls="ico sm" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {upload && <UploadProgress done={upload.done} total={upload.total} />}
    </div>
  );
}

function FilePreviewModal({ site, file }: { site: Site; file: SiteFile }) {
  const url = "/sites/" + site.name + "/" + file.path;
  const [text, setText] = useState<string | null>(null);
  const img = isImage(file.content_type);
  const textual =
    !img && (file.encoding === "utf8" || /text\/|json|javascript|xml/.test(file.content_type));

  useEffect(() => {
    if (!textual) return;
    fetch(url)
      .then((r) => r.text())
      .then(setText)
      .catch(() => setText("（无法加载内容）"));
  }, [url]);

  return (
    <Modal
      title={file.path}
      sub={url}
      width={680}
      footer={
        <>
          <button class="btn btn-secondary" onClick={() => copyText(url)}>
            复制路径
          </button>
          <button class="btn btn-primary" onClick={closeModal}>
            关闭
          </button>
        </>
      }
    >
      <div
        style={{
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          alignItems: "center",
          color: "var(--muted)",
          fontSize: 12,
          marginBottom: 12,
        }}
      >
        <span>{file.content_type}</span>
        <span>{fmtSize(file.size)}</span>
        <span class={"enc-badge" + (file.encoding === "blob" ? " blob" : "")}>{file.encoding}</span>
      </div>
      {img ? (
        <img
          src={url}
          style={{ maxWidth: "100%", borderRadius: "var(--radius)", border: "1px solid var(--line)" }}
        />
      ) : textual ? (
        text == null ? (
          <div class="muted">加载中…</div>
        ) : (
          <div class="preview-box">{text}</div>
        )
      ) : (
        <div class="preview-bin">
          <div class="pi">📦</div>
          <div class="pt">二进制文件 · 在新标签打开查看</div>
        </div>
      )}
    </Modal>
  );
}

