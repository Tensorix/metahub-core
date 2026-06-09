/** @jsxImportSource preact */
import { useRef, useState } from "preact/hooks";
import { api, type Db, type DocSummary, type PropType, type PropConfig } from "./api.ts";
import { Icon } from "./icons.tsx";
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
  activeKind: string;
  activeId?: string;
  width: number;
  collapsed: boolean;
  onResize: (w: number) => void;
  onOpenDb: (id: string) => void;
  onOpenDoc: (id: string) => void;
  onSearch: (q: string) => void;
  onCollapse: () => void;
  onOpenSettings: () => void;
  settingsActive: boolean;
  onOpenSites: () => void;
  sitesActive: boolean;
  /** Show a dot on the settings entry: a core update is staged or available. */
  updatePending?: boolean;
  reloadNav: () => Promise<void>;
  onError: (msg: string) => void;
  afterDelete: (kind: "db" | "doc", id: string) => void;
}

let dragId: string | null = null;

export function Sidebar(props: SidebarProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const startResize = useResize(props.onResize);

  const toggle = (id: string) => {
    const next = new Set(expanded);
    next.has(id) ? next.delete(id) : next.add(id);
    setExpanded(next);
  };

  const guard = (fn: () => Promise<void>) => fn().catch((e) => props.onError(String(e.message)));

  const newDoc = (parent: string | null) =>
    guard(async () => {
      const doc = await api.createDocument({ title: "", ...(parent ? { parent_id: parent } : {}) });
      if (parent) expanded.add(parent);
      await props.reloadNav();
      props.onOpenDoc(doc.id);
    });

  const onDrop = (srcId: string, tgt: DocSummary, where: "into" | "before" | "after") =>
    guard(async () => {
      if (srcId === tgt.id) return;
      if (isAncestor(props.docs, srcId, tgt.id)) return; // no cycles
      // One call handles both reparenting and sibling ordering — the core keeps
      // parent_id and order_key consistent for every drop position.
      await api.moveDocument(srcId, tgt.id, where);
      if (where === "into") expanded.add(tgt.id);
      await props.reloadNav();
    });

  const dbMenu = (e: MouseEvent, db: Db) => {
    e.stopPropagation();
    openMenu(e, (close) => (
      <>
        <MenuItem
          icon="settings"
          label="重命名…"
          onClick={async () => {
            close();
            const name = await promptDialog({ title: "重命名数据库", value: db.name });
            if (name && name !== db.name)
              guard(async () => {
                await api.updateDatabase(db.id, { name });
                await props.reloadNav();
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
                await props.reloadNav();
                props.afterDelete("db", db.id);
              });
          }}
        />
      </>
    ));
  };

  const docMenu = (e: MouseEvent, d: DocSummary) => {
    e.stopPropagation();
    const childCount = props.docs.filter((x) => x.parent_id === d.id).length;
    openMenu(e, (close) => (
      <>
        <MenuItem icon="plus" label="新建子页" onClick={() => { close(); newDoc(d.id); }} />
        <MenuItem
          icon="settings"
          label="重命名…"
          onClick={async () => {
            close();
            const title = await promptDialog({ title: "重命名文档", value: d.title });
            if (title)
              guard(async () => {
                await api.updateDocument(d.id, { title });
                await props.reloadNav();
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
                await props.reloadNav();
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
                await props.reloadNav();
                props.afterDelete("doc", d.id);
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
            class={"navitem" + (props.activeKind === "doc" && props.activeId === d.id ? " active" : "")}
            draggable
            onClick={() => props.onOpenDoc(d.id)}
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
        <button class="iconbtn" title="收起侧栏" onClick={props.onCollapse}>
          <Icon name="panelLeft" />
        </button>
      </div>

      <div class="sb-search" onClick={(e) => (e.currentTarget.querySelector("input") as HTMLInputElement)?.focus()}>
        <Icon name="search" cls="ico sm" />
        <input
          placeholder="搜索…"
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === "Enter" && q.trim()) props.onSearch(q.trim()); }}
        />
      </div>

      <div class="sb-scroll">
        <div class="sb-section">
          <div class="sb-section-head">
            <span>数据库</span>
            <button class="add" title="新建数据库" onClick={() => openCreateDb(props.onOpenDb, props.reloadNav, props.onError)}>
              <Icon name="plus" cls="ico sm" />
            </button>
          </div>
          {props.databases.map((db) => (
            <div
              key={db.id}
              class={"navitem" + (props.activeKind === "db" && props.activeId === db.id ? " active" : "")}
              onClick={() => props.onOpenDb(db.id)}
            >
              <span class="emoji">{db.icon || "🗂️"}</span>
              <span class="label">{db.name}</span>
              <span class="acts">
                <button title="更多" onClick={(e) => dbMenu(e, db)}>
                  <Icon name="dots" cls="ico sm" />
                </button>
              </span>
            </div>
          ))}
          {props.databases.length === 0 && <div class="navitem muted">暂无</div>}
        </div>

        <div class="sb-section">
          <div class="sb-section-head">
            <span>文档</span>
            <button class="add" title="新建文档" onClick={() => newDoc(null)}>
              <Icon name="plus" cls="ico sm" />
            </button>
          </div>
          {renderTree(null)}
          {props.docs.length === 0 && <div class="navitem muted">暂无</div>}
        </div>
      </div>

      <div class="sb-footer">
        <button
          class={"navitem" + (props.sitesActive ? " active" : "")}
          onClick={props.onOpenSites}
        >
          <span class="emoji"><Icon name="globe" cls="ico sm" /></span>
          <span class="label">站点</span>
        </button>
        <button
          class={"navitem" + (props.settingsActive ? " active" : "")}
          onClick={props.onOpenSettings}
        >
          <span class="emoji"><Icon name="settings" cls="ico sm" /></span>
          <span class="label">设置</span>
          {props.updatePending && <span class="nav-dot" title="有可用更新" />}
        </button>
      </div>

      <div class="sb-resizer" onMouseDown={startResize} />
    </div>
  );
}

// ---- drag-drop visual helpers ----
function clearDrop() {
  document
    .querySelectorAll(".drop-into,.drop-before,.drop-after")
    .forEach((n) => n.classList.remove("drop-into", "drop-before", "drop-after"));
}
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
    const move = (ev: MouseEvent) => onResize(Math.max(210, Math.min(460, ev.clientX)));
    const up = () => {
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
  reloadNav: () => Promise<void>,
  onError: (m: string) => void,
) {
  openModal(<CreateDbForm onOpenDb={onOpenDb} reloadNav={reloadNav} onError={onError} />);
}

function CreateDbForm(props: {
  onOpenDb: (id: string) => void;
  reloadNav: () => Promise<void>;
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
      await props.reloadNav();
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
