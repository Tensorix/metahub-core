/** @jsxImportSource preact */
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, type Db, type DocSummary, type PropType, type PropConfig } from "./api.ts";
import { Icon } from "./icons.tsx";
import { clearDropMarks } from "./pointer-drag.ts";
import type { Navigate, View } from "./view.ts";
import {
  openMenu,
  MenuItem,
  MenuSep,
  openModal,
  closeModal,
  Modal,
  confirmDialog,
  promptDialog,
  toast,
} from "./ui.tsx";

interface SidebarProps {
  databases: Db[];
  docs: DocSummary[];
  /** Current view + the app's single navigation entry point (see view.ts). */
  view: View;
  navigate: Navigate;
  width: number;
  collapsed: boolean;
  onResize: (w: number) => void;
  onCollapse: () => void;
  /** Show a dot on the settings entry: a core update is staged or available. */
  updatePending?: boolean;
  onError: (msg: string) => void;
}

let dragId: string | null = null;

// Sidebar list state — a purely local UI preference (per device, never
// replicated). Keys: "tab" (which list the sidebar shows: docs | db; defaults
// to docs) and "dbHidden" (true = the collapsed-databases group is OPEN; it
// defaults to closed). Legacy "db"/"docs" fold booleans may linger in old
// storage; they're simply ignored.
const SEC_KEY = "mh.sb.sections";
type SbTab = "docs" | "db";
interface SecState {
  tab?: SbTab;
  dbHidden?: boolean;
}
function loadSec(): SecState {
  try {
    return JSON.parse(localStorage.getItem(SEC_KEY) || "{}");
  } catch {
    return {};
  }
}

// The two sidebar lists, in tab order (docs first — it's the primary surface).
const TABS: { key: SbTab; icon: string; label: string }[] = [
  { key: "docs", icon: "fileText", label: "文档" },
  { key: "db", icon: "table", label: "数据表" },
];

/** The replicated per-database fold flag (meta.collapsed): tucks site-facing /
 *  rarely-browsed tables into the section's tail "已折叠" group. */
function isDbCollapsed(db: Db): boolean {
  return db.meta?.collapsed === true;
}

// For the search shortcut badge only (navigator.platform is deprecated but
// remains the fallback where userAgentData hasn't shipped).
const IS_MAC = /mac/i.test(
  (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform,
);

export function Sidebar(props: SidebarProps) {
  const { view, navigate } = props;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  // Mobile only: the search box is hidden until the header's search button
  // reveals it (CSS-gated, like the sites/settings .sb-act buttons). Desktop
  // ignores this and always shows the box.
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [version, setVersion] = useState<string | null>(null);
  const startResize = useResize(props.onResize);

  useEffect(() => {
    api.version().then((v) => setVersion(v.version)).catch(() => setVersion(null));
  }, []);

  // Focus the input as it reveals so the soft keyboard comes up immediately.
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const toggle = (id: string) => {
    const next = new Set(expanded);
    next.has(id) ? next.delete(id) : next.add(id);
    setExpanded(next);
  };

  const [sec, setSec] = useState<SecState>(loadSec);
  const patchSec = (patch: Partial<SecState>) => {
    const next = { ...sec, ...patch };
    setSec(next);
    try {
      localStorage.setItem(SEC_KEY, JSON.stringify(next));
    } catch {
      /* private mode: list state just doesn't persist */
    }
  };

  // Which list the sidebar shows. Switching remounts the pane (key={tab}) with
  // a direction-aware slide; the ref gate keeps the very first render still.
  const tab = sec.tab ?? "docs";
  const paneDir = useRef<"r" | "l">("r");
  const paneAnim = useRef(false);
  const setTab = (t: SbTab) => {
    if (t === tab) return;
    paneDir.current = t === "db" ? "r" : "l";
    paneAnim.current = true;
    patchSec({ tab: t });
  };

  // Follow navigation: opening a doc (search result, backlink, history) should
  // reveal it in the list. Manual tab switches don't change the view, so they
  // never get yanked back. The id dep matters — doc→doc back/forward must
  // retrigger even though kind stays "doc".
  useEffect(() => {
    if (view.kind === "doc") setTab("docs");
    else if (view.kind === "db") setTab("db");
  }, [view.kind, "id" in view ? view.id : ""]);

  // Sliding pill under the active tab. The label expands via a CSS 0fr→1fr
  // grid transition, so a one-shot measurement would capture a mid-flight
  // width; instead a ResizeObserver keeps retargeting the indicator's
  // transition while the button grows — it chases the label open, Notion-style.
  const tabsRef = useRef<HTMLDivElement>(null);
  const indReady = useRef(false);
  useLayoutEffect(() => {
    const wrap = tabsRef.current;
    const ind = wrap?.querySelector<HTMLElement>(".sb-tab-ind");
    if (!wrap || !ind) return;
    const move = () => {
      const btn = wrap.querySelector<HTMLElement>(".sb-tab.on");
      if (!btn) return;
      ind.style.transform = `translateX(${btn.offsetLeft}px)`;
      ind.style.width = `${btn.offsetWidth}px`;
    };
    if (indReady.current) move();
    else {
      // First paint: place the pill without a slide-in from x=0.
      ind.style.transition = "none";
      move();
      requestAnimationFrame(() => {
        ind.style.transition = "";
        indReady.current = true;
      });
    }
    const ro = new ResizeObserver(move);
    wrap.querySelectorAll(".sb-tab").forEach((b) => ro.observe(b));
    return () => ro.disconnect();
  }, [tab]);

  const guard = (fn: () => Promise<void>) => fn().catch((e) => props.onError(String(e.message)));

  // After deleting the entity currently on screen, replace (not push) to the
  // home view: a deleted entity must not stay reachable via forward.
  const leaveIfActive = (id: string) => {
    if ("id" in view && view.id === id) navigate({ kind: "empty" }, { replace: true });
  };

  const newDoc = (parent: string | null) =>
    guard(async () => {
      const doc = await api.createDocument({ title: "", ...(parent ? { parent_id: parent } : {}) });
      if (parent) expanded.add(parent);
      navigate({ kind: "doc", id: doc.id });
    });

  const onDrop = (srcId: string, tgt: DocSummary, where: "into" | "before" | "after") =>
    guard(async () => {
      if (srcId === tgt.id) return;
      if (isAncestor(props.docs, srcId, tgt.id)) return; // no cycles
      // One call handles both reparenting and sibling ordering — the core keeps
      // parent_id and order_key consistent for every drop position.
      await api.moveDocument(srcId, tgt.id, where);
      if (where === "into") expanded.add(tgt.id);
    });

  const dbMenu = (e: MouseEvent, db: Db) => {
    e.stopPropagation();
    openMenu(e, (close) => (
      <>
        <MenuItem
          icon="hash"
          label="复制 ID"
          onClick={() => {
            close();
            navigator.clipboard?.writeText(db.id).then(() => toast("已复制 ID"));
          }}
        />
        <MenuItem
          icon="settings"
          label="重命名…"
          onClick={async () => {
            close();
            const name = await promptDialog({ title: "重命名数据库", value: db.name });
            if (name && name !== db.name)
              guard(async () => {
                await api.updateDatabase(db.id, { name });
              });
          }}
        />
        <MenuItem
          icon={isDbCollapsed(db) ? "chevronDown" : "chevron"}
          label={isDbCollapsed(db) ? "移出折叠组" : "折叠此数据库"}
          onClick={() => {
            close();
            // meta is a whole-object register — merge the current value in.
            guard(async () => {
              await api.updateDatabase(db.id, {
                meta: { ...(db.meta ?? {}), collapsed: !isDbCollapsed(db) },
              });
            });
          }}
        />
        <MenuSep />
        <MenuItem
          icon="trash"
          label="删除数据库"
          danger
          onClick={async () => {
            close();
            const ok = await confirmDialog({
              title: "删除数据库？",
              message: `「${db.name}」及其所有记录将被永久删除。`,
              confirmLabel: "删除",
              danger: true,
            });
            if (ok)
              guard(async () => {
                await api.deleteDatabase(db.id);
                leaveIfActive(db.id);
              });
          }}
        />
      </>
    ));
  };

  const dbItem = (db: Db, dim = false) => (
    <div
      key={db.id}
      class={"navitem" + (dim ? " dim" : "") + (view.kind === "db" && view.id === db.id ? " active" : "")}
      onClick={() => navigate({ kind: "db", id: db.id })}
    >
      <span class="emoji">{db.icon || "🗂️"}</span>
      <span class="label">{db.name}</span>
      <span class="acts">
        <button title="更多" onClick={(e) => dbMenu(e, db)}>
          <Icon name="dots" cls="ico sm" />
        </button>
      </span>
    </div>
  );

  const docMenu = (e: MouseEvent, d: DocSummary) => {
    e.stopPropagation();
    const childCount = props.docs.filter((x) => x.parent_id === d.id).length;
    openMenu(e, (close) => (
      <>
        <MenuItem icon="plus" label="新建子页" onClick={() => { close(); newDoc(d.id); }} />
        <MenuItem
          icon="hash"
          label="复制 ID"
          onClick={() => {
            close();
            navigator.clipboard?.writeText(d.id).then(() => toast("已复制 ID"));
          }}
        />
        <MenuItem
          icon="settings"
          label="重命名…"
          onClick={async () => {
            close();
            const title = await promptDialog({ title: "重命名文档", value: d.title });
            if (title)
              guard(async () => {
                await api.updateDocument(d.id, { title });
              });
          }}
        />
        {d.parent_id && (
          <MenuItem
            icon="cornerUpRight"
            label="移到顶层"
            onClick={() => {
              close();
              guard(async () => {
                await api.updateDocument(d.id, { parent_id: null });
              });
            }}
          />
        )}
        <MenuSep />
        <MenuItem
          icon="trash"
          label="删除"
          danger
          onClick={async () => {
            close();
            const ok = await confirmDialog({
              title: "删除文档？",
              message: childCount
                ? `「${d.title || "无标题"}」及其 ${childCount} 个子页将被删除。`
                : `「${d.title || "无标题"}」将被删除。`,
              confirmLabel: "删除",
              danger: true,
            });
            if (ok)
              guard(async () => {
                await deleteDocTree(props.docs, d.id);
                leaveIfActive(d.id);
              });
          }}
        />
      </>
    ));
  };

  const renderTree = (parentId: string | null, depth = 0) => {
    const children = props.docs.filter((d) => d.parent_id === parentId);
    return children.map((d) => {
      const kids = props.docs.filter((x) => x.parent_id === d.id);
      const open = kids.length > 0 && expanded.has(d.id);
      return (
        <div key={d.id} class={depth ? "navchildren" : ""}>
          <div
            class={"navitem" + (view.kind === "doc" && view.id === d.id ? " active" : "")}
            draggable
            onClick={() => navigate({ kind: "doc", id: d.id })}
            onDragStart={(e) => { e.stopPropagation(); dragId = d.id; (e.currentTarget as HTMLElement).classList.add("dragging"); }}
            onDragEnd={(e) => { (e.currentTarget as HTMLElement).classList.remove("dragging"); clearDrop(); }}
            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); markDrop(e.currentTarget as HTMLElement, e); }}
            onDrop={(e) => {
              e.preventDefault(); e.stopPropagation();
              const where = dropWhere(e.currentTarget as HTMLElement, e);
              const src = dragId; dragId = null; clearDrop();
              if (src) onDrop(src, d, where);
            }}
          >
            <span
              class={"tw" + (open ? " open" : "")}
              onClick={(e) => { e.stopPropagation(); if (kids.length) toggle(d.id); }}
            >
              {kids.length > 0 && <Icon name="chevron" cls="ico sm" />}
            </span>
            <span class="emoji">
              <Icon name="file" cls="ico sm" />
            </span>
            <span class="label">{d.title || "无标题"}</span>
            <span class="acts">
              <button title="新建子页" onClick={(e) => { e.stopPropagation(); newDoc(d.id); }}>
                <Icon name="plus" cls="ico sm" />
              </button>
              <button title="更多" onClick={(e) => docMenu(e, d)}>
                <Icon name="dots" cls="ico sm" />
              </button>
            </span>
          </div>
          {open && renderTree(d.id, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div
      class={"sidebar" + (props.collapsed ? " collapsed" : "")}
      style={{ width: props.width, marginLeft: props.collapsed ? -props.width : undefined }}
    >
      <div class="sb-head">
        <div class="brand">
          <span class="mark"><Icon name="cube" /></span>Metahub
        </div>
        {/* Mobile-only (CSS-gated, like the collapse button below): on the
            full-page home the sites/settings entries live up here as icon
            buttons instead of the desktop .sb-footer rows, freeing the bottom.
            The search button reveals the (mobile-hidden) search box below. */}
        <button
          class={"sb-act" + (searchOpen ? " active" : "")}
          title="搜索"
          aria-label="搜索"
          onClick={() => setSearchOpen((v) => !v)}
        >
          <Icon name="search" cls="ico" />
        </button>
        <button
          class={"sb-act" + (view.kind === "sites" ? " active" : "")}
          title="站点"
          aria-label="站点"
          onClick={() => navigate({ kind: "sites" })}
        >
          <Icon name="globe" cls="ico" />
        </button>
        <button
          class={"sb-act" + (view.kind === "shares" ? " active" : "")}
          title="分享"
          aria-label="分享"
          onClick={() => navigate({ kind: "shares" })}
        >
          <Icon name="link" cls="ico" />
        </button>
        <button
          class={"sb-act" + (view.kind === "settings" ? " active" : "")}
          title="设置"
          aria-label="设置"
          onClick={() => navigate({ kind: "settings" })}
        >
          <Icon name="settings" cls="ico" />
          {props.updatePending && <span class="nav-dot" title="有可用更新" />}
        </button>
        <button class="iconbtn" title="收起侧栏" onClick={props.onCollapse}>
          <Icon name="panelLeft" />
        </button>
      </div>

      {/* List switcher (Notion-style): active tab = icon+label pill, inactive
          = icon only. The + creates whatever the active tab holds. */}
      <div class="sb-tabs" role="tablist" ref={tabsRef}>
        <span class="sb-tab-ind" aria-hidden="true" />
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            class={"sb-tab" + (tab === t.key ? " on" : "")}
            title={t.label}
            onClick={() => setTab(t.key)}
          >
            <Icon name={t.icon} cls="ico sm" />
            <span class="tab-label"><span>{t.label}</span></span>
          </button>
        ))}
        <button
          class="add"
          title={tab === "docs" ? "新建文档" : "新建数据库"}
          onClick={() =>
            tab === "docs"
              ? newDoc(null)
              : openCreateDb((id) => navigate({ kind: "db", id }), props.onError)}
        >
          <Icon name="plus" cls="ico sm" />
        </button>
      </div>

      <div class={"sb-search" + (searchOpen ? " open" : "")} onClick={(e) => (e.currentTarget.querySelector("input") as HTMLInputElement)?.focus()}>
        <Icon name="search" cls="ico sm" />
        <input
          ref={searchRef}
          placeholder="搜索…"
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            // entering search pushes once; re-searching within it replaces, so
            // one back press leaves search instead of replaying every query
            if (e.key === "Enter" && q.trim())
              navigate({ kind: "search", q: q.trim() }, { replace: view.kind === "search" });
          }}
        />
        {/* the shortcut itself lives in app.tsx (global keydown) */}
        <kbd>{IS_MAC ? "⌘K" : "Ctrl K"}</kbd>
      </div>

      <div class="sb-scroll">
        <div
          key={tab}
          class={"sb-pane" + (paneAnim.current ? (paneDir.current === "r" ? " in-r" : " in-l") : "")}
        >
          {tab === "docs" ? (
            <>
              {renderTree(null)}
              {props.docs.length === 0 && <div class="navitem muted">暂无文档</div>}
            </>
          ) : (
            <>
              {props.databases.filter((db) => !isDbCollapsed(db)).map((db) => dbItem(db))}
              {props.databases.length === 0 && <div class="navitem muted">暂无数据表</div>}
              {props.databases.some(isDbCollapsed) && (
                <>
                  <button class="sb-subfold" onClick={() => patchSec({ dbHidden: !sec.dbHidden })} aria-expanded={!!sec.dbHidden}>
                    <Icon name="chevron" cls={"ico sm chev" + (sec.dbHidden ? " open" : "")} />
                    <span>已折叠 · {props.databases.filter(isDbCollapsed).length}</span>
                  </button>
                  {sec.dbHidden && props.databases.filter(isDbCollapsed).map((db) => dbItem(db, true))}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* Desktop-only slim status row (mobile hides it and uses the .sb-head
          icons): sites/settings as icon buttons, core version at the right. */}
      <div class="sb-footer">
        <button
          class={"sb-act" + (view.kind === "settings" ? " active" : "")}
          title="设置"
          aria-label="设置"
          onClick={() => navigate({ kind: "settings" })}
        >
          <Icon name="settings" cls="ico sm" />
          {props.updatePending && <span class="nav-dot" title="有可用更新" />}
        </button>
        <button
          class={"sb-act" + (view.kind === "sites" ? " active" : "")}
          title="站点"
          aria-label="站点"
          onClick={() => navigate({ kind: "sites" })}
        >
          <Icon name="globe" cls="ico sm" />
        </button>
        <button
          class={"sb-act" + (view.kind === "shares" ? " active" : "")}
          title="分享"
          aria-label="分享"
          onClick={() => navigate({ kind: "shares" })}
        >
          <Icon name="link" cls="ico sm" />
        </button>
        {version && <span class="sbf-ver" title={`Metahub Core v${version}`}>v{version}</span>}
      </div>

      <div class="sb-resizer" onMouseDown={startResize} />
    </div>
  );
}

// ---- drag-drop visual helpers ----
// The sidebar tree has a three-way drop (into/before/after), so it marks
// targets itself; only the clearing is shared.
const clearDrop = clearDropMarks;
function dropWhere(el: HTMLElement, e: DragEvent): "into" | "before" | "after" {
  const r = el.getBoundingClientRect();
  const y = e.clientY - r.top;
  return y < r.height * 0.28 ? "before" : y > r.height * 0.72 ? "after" : "into";
}
function markDrop(el: HTMLElement, e: DragEvent) {
  clearDrop();
  el.classList.add("drop-" + dropWhere(el, e));
}

// ---- tree utilities ----
function isAncestor(docs: DocSummary[], ancestorId: string, nodeId: string): boolean {
  let cur = docs.find((d) => d.id === nodeId);
  while (cur) {
    if (cur.parent_id === ancestorId) return true;
    cur = docs.find((d) => d.id === cur!.parent_id);
  }
  return false;
}
async function deleteDocTree(docs: DocSummary[], id: string) {
  for (const child of docs.filter((d) => d.parent_id === id)) await deleteDocTree(docs, child.id);
  await api.deleteDocument(id);
}

// ---- sidebar resize ----
function useResize(onResize: (w: number) => void) {
  return (e: MouseEvent) => {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.classList.add("dragging");
    document.body.classList.add("col-resizing");
    const move = (ev: MouseEvent) => onResize(Math.max(210, Math.min(460, ev.clientX)));
    const up = () => {
      handle.classList.remove("dragging");
      document.body.classList.remove("col-resizing");
      removeEventListener("mousemove", move);
      removeEventListener("mouseup", up);
    };
    addEventListener("mousemove", move);
    addEventListener("mouseup", up);
  };
}

// ---- create-database modal ----
const TEMPLATES: Record<string, { name: string; type: PropType; config?: PropConfig }[]> = {
  blank: [{ name: "名称", type: "text" }],
  tasks: [
    { name: "名称", type: "text" },
    { name: "状态", type: "select", config: { options: ["待办", "进行中", "已完成"] } },
    { name: "优先级", type: "select", config: { options: ["高", "中", "低"] } },
    { name: "截止", type: "date" },
  ],
  crm: [
    { name: "姓名", type: "text" },
    { name: "公司", type: "text" },
    { name: "分类", type: "select", config: { options: ["客户", "合作", "潜在"] } },
    { name: "邮箱", type: "url" },
  ],
};

function openCreateDb(
  onOpenDb: (id: string) => void,
  onError: (m: string) => void,
) {
  openModal(<CreateDbForm onOpenDb={onOpenDb} onError={onError} />);
}

function CreateDbForm(props: {
  onOpenDb: (id: string) => void;
  onError: (m: string) => void;
}) {
  const ICONS = ["🗂️", "🎯", "🤝", "📦", "📚", "💡", "🧩", "📊", "🗓️", "✅"];
  const TMPLS: [string, string, string][] = [
    ["blank", "空白", "仅一个「名称」列"],
    ["tasks", "任务", "状态·优先级·截止"],
    ["crm", "联系人", "公司·分类·邮箱"],
  ];
  const [name, setName] = useState("");
  const [icon, setIcon] = useState(ICONS[0]!);
  const [tmpl, setTmpl] = useState("blank");
  const busy = useRef(false);

  const create = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const db = await api.createDatabase({ name: name.trim() || "未命名数据库", icon });
      for (const spec of TEMPLATES[tmpl] ?? TEMPLATES.blank!)
        await api.createProperty({ db: db.id, name: spec.name, type: spec.type, config: spec.config });
      closeModal();
      props.onOpenDb(db.id);
      toast(`已创建数据库「${db.name}」`);
    } catch (e) {
      props.onError(String((e as Error).message));
    } finally {
      busy.current = false;
    }
  };

  return (
    <Modal
      title="新建数据库"
      sub="创建一个带属性列的结构化数据表。"
      footer={
        <>
          <button class="btn btn-secondary" onClick={closeModal}>取消</button>
          <button class="btn btn-primary" onClick={create}>创建</button>
        </>
      }
    >
      <div class="field-label">名称</div>
      <input
        class="text-input"
        autofocus
        placeholder="例如：项目、客户、库存…"
        value={name}
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => e.key === "Enter" && create()}
      />
      <div class="field-label">图标</div>
      <div class="icon-pick">
        {ICONS.map((ic) => (
          <button key={ic} class={ic === icon ? "sel" : ""} onClick={() => setIcon(ic)}>{ic}</button>
        ))}
      </div>
      <div class="field-label">模板</div>
      <div class="tmpl">
        {TMPLS.map(([k, t, d]) => (
          <button key={k} class={k === tmpl ? "sel" : ""} onClick={() => setTmpl(k)}>
            <div class="tt">{t}</div>
            <div class="td">{d}</div>
          </button>
        ))}
      </div>
    </Modal>
  );
}
