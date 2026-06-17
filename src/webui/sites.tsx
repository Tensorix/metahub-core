/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";
import { api, type Site, type SiteFile } from "./api.ts";
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

export function SitesView() {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [peek, setPeek] = useState<Site | null>(null);
  const [preview, setPreview] = useState<Site | null>(null);

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
    <div class="db sites-page">
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
    </div>
  );
}

function NewSiteModal({ onCreated }: { onCreated: (s: Site) => void }) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const create = async () => {
    const slug = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!slug) return toast("请填写站点名称");
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

  const onPick = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const list = Array.from(input.files ?? []);
    input.value = "";
    if (!list.length) return;
    // Upload sequentially; on a mid-batch failure, report what actually landed
    // and always refresh from the server so the list reflects real state.
    let done = 0;
    try {
      for (const f of list) {
        await api.uploadSiteFile(site.id, f.name, f);
        done++;
      }
      toast(`已上传 ${done} 个文件`);
    } catch (err) {
      toast(`已上传 ${done}/${list.length} 个，其余失败：${(err as Error).message}`);
    } finally {
      reload();
      onChanged();
    }
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
      <div class={"peek" + (open ? " open" : "")}>
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
