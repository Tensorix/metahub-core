/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";
import { api, type Site, type SiteFile, type GrantOp, type GrantSet } from "./api.ts";
import { normalizeSiteName } from "../core/sites-core.ts";
import { openShareModal, useSharedTargets } from "./share-modal.tsx";
import { Icon } from "./icons.tsx";
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
  useDrawerTransition,
} from "./ui.tsx";

// "站点管理" — GUI over the static-file sites the `mh site` CLI publishes. Sites
// are served at /sites/<name>/, so preview just points an iframe at the real URL
// (no inlining) and file preview fetches the served bytes.

const siteUrl = (name: string) => location.origin + "/sites/" + name + "/";
// Display form: drop the shared `${origin}/sites` prefix (identical for every
// site) and show only the part that varies. Full URL is still used for copy/open.
const siteUrlShort = (name: string) => "/" + name + "/";
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

export function SitesView() {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [peek, setPeek] = useState<Site | null>(null);
  const [preview, setPreview] = useState<Site | null>(null);
  const [drag, setDrag] = useState(false);
  const [upload, setUpload] = useState<{ done: number; total: number } | null>(null);
  const shared = useSharedTargets();

  const reload = () =>
    api
      .listSites()
      .then((s) => {
        setSites(s);
        // keep the open drawer's metadata fresh after writes
        setPeek((cur) => (cur ? (s.find((x) => x.id === cur.id) ?? null) : null));
      })
      .catch((e) => toast(`加载失败：${e.message}`));

  useEffect(() => {
    reload();
  }, []);

  const newSite = () => openModal(<NewSiteModal onCreated={(site) => { reload(); setPeek(site); }} />);

  // Dropping a DIRECTORY on the list publishes it as a site (dir name = slug),
  // mirroring `mh site publish <name> <dir> --create`: a missing site is only
  // created after an explicit confirm.
  const onGridDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (peek || preview || upload) return; // the open drawer owns its own drop zone
    const drop = dropEntries(e.dataTransfer!); // sync — before any await
    if (drop.entries.length !== 1 || !drop.entries[0]!.isDirectory)
      return toast("拖入一个目录即可发布为站点（目录名 = 站点名）");
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
        message: `站点「${slug}」不存在。创建它并发布 ${inner.length} 个文件？`,
        confirmLabel: "创建并发布",
      });
      if (!ok) return;
      try {
        target = await api.createSite({ name: slug });
      } catch (err) {
        return toast((err as Error).message);
      }
    }
    setUpload({ done: 0, total: inner.length });
    const failed = await uploadBatch(target.id, inner, (done, total) => setUpload({ done, total }));
    setUpload(null);
    reportUpload(inner.length, failed);
    await reload();
    setPeek(target);
  };

  // Default-deny, same rule as core isSitePublic: only exactly "public" counts.
  const isPublic = (s: Site) => s.visibility === "public";

  const togglePublic = async (s: Site) => {
    if (!isPublic(s)) {
      const ok = await confirmDialog({
        title: "公开此站点？",
        message:
          "公开后：任何人无需登录即可读取该站点的所有页面和文件；页面内对 /api 的数据调用默认不可用（公开不等于授权读取数据）；只要任何一台已配对设备在运行 server，都会公开提供此站点。若之后改回私有，外部 CDN／浏览器缓存里已取到的内容最多可能在数分钟内仍可访问。",
        confirmLabel: "设为公开",
      });
      if (!ok) return;
    }
    try {
      await api.updateSite(s.id, { visibility: isPublic(s) ? "private" : "public" });
    } catch (err) {
      return toast((err as Error).message);
    }
    toast(isPublic(s) ? "已恢复为私有" : "已设为公开");
    reload();
  };

  const toggleSpa = async (s: Site) => {
    try {
      await api.updateSite(s.id, { spa: s.spa !== 1 });
    } catch (err) {
      return toast((err as Error).message);
    }
    toast(s.spa === 1 ? "已关闭 SPA 模式" : "已开启 SPA 模式（无扩展名路径回落到 index.html）");
    reload();
  };

  const siteMenu = (e: MouseEvent, s: Site, fromPeek?: boolean) => {
    openMenu(e, (close) => (
      <>
        <MenuItem
          icon="externalLink"
          label="复制访问地址"
          onClick={() => {
            close();
            copyText(siteUrl(s.name));
          }}
        />
        <MenuItem
          icon="link"
          label="通过设备分享…"
          onClick={() => {
            close();
            openShareModal({ kind: "site", ref: s.id, title: s.title ?? s.name });
          }}
        />
        <MenuItem
          icon="globe"
          label={isPublic(s) ? "关闭公开访问" : "开启公开访问…"}
          onClick={() => {
            close();
            togglePublic(s);
          }}
        />
        <MenuItem
          icon="code"
          label={s.spa === 1 ? "关闭 SPA 模式" : "开启 SPA 模式"}
          onClick={() => {
            close();
            toggleSpa(s);
          }}
        />
        <MenuItem
          icon="link"
          label={
            isPublic(s) ? (
              "公开数据授权…"
            ) : (
              <span style={{ opacity: 0.5 }}>公开数据授权（需先公开）</span>
            )
          }
          onClick={() => {
            close();
            if (!isPublic(s)) return toast("先开启公开访问，公开数据授权才会生效");
            openModal(<SiteGrantsModal site={s} onSaved={reload} />);
          }}
        />
        <MenuItem
          icon="settings"
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
            reload();
          }}
        />
        <MenuItem
          icon="pencil"
          label="重命名（slug）…"
          onClick={() => {
            close();
            openModal(<RenameSlugModal site={s} onRenamed={reload} />);
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
            if (fromPeek) setPeek(null);
            reload();
          }}
        />
      </>
    ));
  };

  return (
    <div
      class="db sites-page"
      onDragOver={(e) => {
        if (!e.dataTransfer?.types.includes("Files")) return;
        e.preventDefault();
        if (!peek && !preview && !upload) setDrag(true);
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
          <div class="ed">站点是一个命名文件桶，发布后可通过 /sites/&lt;name&gt;/ 直接访问。</div>
          <button class="btn btn-primary" onClick={newSite}>
            <Icon name="plus" cls="ico sm" />
            新建站点
          </button>
        </div>
      ) : (
        <>
          <div class="sites-grid">
            {sites.map((s, i) => (
              <div class="site-card" key={s.id} style={`--i:${i}`} onClick={() => setPeek(s)}>
                <div class="site-card-head">
                  <span class="si">
                    <Icon name="globe" />
                  </span>
                  <div class="site-card-id">
                    <div class="slug">{s.name}</div>
                    <div class={"ttl" + (s.title ? "" : " muted")}>{s.title || "未命名站点"}</div>
                  </div>
                  {isPublic(s) && (
                    <span
                      class="share-badge"
                      title="公开站点 · 任何人可访问"
                      style={{ marginLeft: "auto" }}
                    >
                      <Icon name="globe" />
                    </span>
                  )}
                  {shared.has(s.id) && (
                    <span
                      class="share-badge"
                      title="已分享 · 管理分享"
                      style={{ marginLeft: isPublic(s) ? undefined : "auto" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        openShareModal({ kind: "site", ref: s.id, title: s.title ?? s.name });
                      }}
                    >
                      <Icon name="link" />
                    </span>
                  )}
                </div>
                <button
                  class="site-addr"
                  title="点击复制访问地址"
                  onClick={(e) => {
                    e.stopPropagation();
                    copyText(siteUrl(s.name));
                  }}
                >
                  <Icon name="link" cls="ico sm" />
                  <span>{siteUrlShort(s.name)}</span>
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
                      setPreview(s);
                    }}
                  >
                    <Icon name="globe" cls="ico sm" />
                    访问
                  </button>
                  <button
                    class="iconbtn"
                    title="更多"
                    onClick={(e) => {
                      e.stopPropagation();
                      siteMenu(e as unknown as MouseEvent, s);
                    }}
                  >
                    <Icon name="dots" />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div class="gridfoot">
            <span>共 {sites.length} 个站点</span>
            <span>{sites.reduce((n, s) => n + s.file_count, 0)} 个文件</span>
          </div>
        </>
      )}

      {peek && (
        <SitePeek
          site={peek}
          onClose={() => setPeek(null)}
          onVisit={() => setPreview(peek)}
          onMenu={(e) => siteMenu(e, peek, true)}
          onChanged={reload}
        />
      )}
      {preview && <SitePreview site={preview} onClose={() => setPreview(null)} />}
      {upload && <UploadProgress done={upload.done} total={upload.total} />}
    </div>
  );
}

/** Public data grants editor: which tables anonymous visitors of a PUBLIC site
 *  may read / create / update through /sites/<name>/api/*. */
function SiteGrantsModal({ site, onSaved }: { site: Site; onSaved: () => void }) {
  const [dbs, setDbs] = useState<{ id: string; name: string }[] | null>(null);
  const [draft, setDraft] = useState<Map<string, Set<GrantOp>>>(() => new Map());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api.listDatabases(), api.getSiteGrants(site.id)])
      .then(([list, res]) => {
        setDbs(list.map((d) => ({ id: d.id, name: d.name })));
        setDraft(new Map(res.grants.tables.map((t) => [t.db, new Set(t.ops)])));
      })
      .catch((e) => {
        toast((e as Error).message);
        setDbs([]);
      });
  }, [site.id]);

  const toggle = (dbId: string, op: GrantOp) => {
    setDraft((cur) => {
      const next = new Map(cur);
      const ops = new Set(next.get(dbId) ?? []);
      if (ops.has(op)) ops.delete(op);
      else ops.add(op);
      next.set(dbId, ops);
      return next;
    });
  };

  const save = async () => {
    const tables = [...draft.entries()]
      .filter(([, ops]) => ops.size > 0)
      .map(([db, ops]) => ({
        db,
        ops: (["read", "create", "update"] as GrantOp[]).filter((o) => ops.has(o)),
      }));
    const set: GrantSet = { v: 1, tables };
    setBusy(true);
    try {
      await api.setSiteGrants(site.id, set);
      closeModal();
      toast(tables.length ? "已保存公开数据授权" : "已清空公开数据授权");
      onSaved();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="公开数据授权"
      sub={`任何访客都能按下列授权读写数据（站点「${site.name}」的 api/ 调用）。写入以访客身份记录，可按来源回滚。`}
      footer={
        <>
          <button class="btn btn-secondary" onClick={closeModal}>
            取消
          </button>
          <button class="btn btn-primary" disabled={busy || dbs == null} onClick={save}>
            {busy ? "保存中…" : "保存"}
          </button>
        </>
      }
    >
      {dbs == null ? (
        <div class="muted">加载中…</div>
      ) : dbs.length === 0 ? (
        <div class="muted">还没有数据库可以授权。</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {dbs.map((d) => {
            const ops = draft.get(d.id) ?? new Set<GrantOp>();
            return (
              <div
                key={d.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 16,
                  padding: "6px 10px",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--radius)",
                }}
              >
                <span
                  style={{
                    flex: 1,
                    fontWeight: 600,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {d.name}
                </span>
                {(["read", "create", "update"] as GrantOp[]).map((op) => (
                  <label
                    key={op}
                    style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13, cursor: "pointer" }}
                  >
                    <input type="checkbox" checked={ops.has(op)} onChange={() => toggle(d.id, op)} />
                    {op === "read" ? "读" : op === "create" ? "新增" : "修改"}
                  </label>
                ))}
              </div>
            );
          })}
          <div class="muted" style={{ fontSize: 12, marginTop: 6 }}>
            「修改」允许匿名访客改动表中任何行，请谨慎勾选。删除永远不开放。
          </div>
        </div>
      )}
    </Modal>
  );
}

function NewSiteModal({ onCreated }: { onCreated: (s: Site) => void }) {
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
      onCreated(site);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <Modal
      title="新建站点"
      sub="创建一个命名文件桶，随同步无冲突复制。"
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
function RenameSlugModal({ site, onRenamed }: { site: Site; onRenamed: () => void }) {
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
      onRenamed();
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

function SitePeek({
  site,
  onClose,
  onVisit,
  onMenu,
  onChanged,
}: {
  site: Site;
  onClose: () => void;
  onVisit: () => void;
  onMenu: (e: MouseEvent) => void;
  onChanged: () => void;
}) {
  const [files, setFiles] = useState<SiteFile[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<{ done: number; total: number } | null>(null);
  const [drag, setDrag] = useState(false);
  const { open, close } = useDrawerTransition(onClose);

  const reload = () =>
    api
      .listSiteFiles(site.id)
      .then(setFiles)
      .catch((e) => toast(e.message));

  // Load on site switch; ignore a stale response if the drawer moved to another
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
    onChanged();
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
    e.stopPropagation(); // the grid behind has its own publish-a-directory drop zone
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
    onChanged();
  };

  const url = siteUrl(site.name);
  const urlShort = siteUrlShort(site.name);
  return (
    <>
      <div class={"scrim" + (open ? " open" : "")} onClick={close} />
      <div
        class={"peek" + (open ? " open" : "")}
        onDragOver={(e) => {
          if (!e.dataTransfer?.types.includes("Files")) return;
          e.preventDefault();
          e.stopPropagation();
          if (!upload) setDrag(true);
        }}
        onDragLeave={(e) => {
          if (!(e.currentTarget as Node).contains(e.relatedTarget as Node)) setDrag(false);
        }}
        onDrop={onDrop}
        style={drag ? { outline: "2px dashed var(--accent)", outlineOffset: -6 } : undefined}
      >
        <div class="peek-head">
          <button class="iconbtn" onClick={close}>
            <Icon name="x" />
          </button>
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              gap: 8,
              minWidth: 0,
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            <Icon name="globe" cls="ico sm" />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {site.name}
            </span>
          </div>
          <button class="btn btn-secondary" onClick={() => fileInput.current?.click()}>
            <Icon name="upload" cls="ico sm" />
            上传文件
          </button>
          <button
            class="btn btn-secondary"
            title="上传整个目录（保留相对路径），也可以直接拖拽目录进来"
            onClick={() => dirInput.current?.click()}
          >
            <Icon name="upload" cls="ico sm" />
            上传目录
          </button>
          <button class="iconbtn" title="更多" onClick={(e) => onMenu(e as unknown as MouseEvent)}>
            <Icon name="dots" />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={onPick}
          />
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
        </div>
        <div class="peek-body">
          <h2 style={{ margin: "0 0 20px" }}>{site.title || site.name}</h2>

          <div class="acc-link">
            <span class="url">{urlShort}</span>
            <button title="复制地址" onClick={() => copyText(url)}>
              <Icon name="copy" cls="ico sm" />
            </button>
            <button class="accent" title="访问站点" onClick={onVisit}>
              <Icon name="globe" cls="ico sm" />
            </button>
          </div>

          <div class="site-meta">
            <span>
              <b>{files?.length ?? site.file_count}</b> 个文件
            </span>
            <span>创建于 {fmtDate(site.created_hlc)}</span>
          </div>

          <div class="files-head">
            <span>文件</span>
            <span>{files?.length ?? ""}</span>
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
    </>
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

function SitePreview({ site, onClose }: { site: Site; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const url = "/sites/" + site.name + "/";
  return (
    <div
      class="spv-scrim open"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div class="spv">
        <div class="spv-chrome">
          <div class="spv-dots">
            <i />
            <i />
            <i />
          </div>
          <div class="spv-url">
            <Icon name="lock" cls="ico sm" />
            <span>{siteUrl(site.name)}</span>
          </div>
          <button class="spv-btn" title="在新标签打开" onClick={() => window.open(url, "_blank")}>
            <Icon name="externalLink" cls="ico sm" />
            新标签
          </button>
          <button class="spv-btn icon" title="关闭" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <iframe class="spv-frame" src={url} sandbox="allow-scripts allow-same-origin" />
      </div>
    </div>
  );
}
