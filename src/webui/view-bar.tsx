/** @jsxImportSource preact */
// View chrome for the database page: view tabs, the 筛选/排序/属性/搜索 toolbar,
// the active-rule chip row and the popovers that edit them. Pure UI over a
// ViewDef — persistence is the caller's (table.tsx updateView).
import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { Prop } from "./api.ts";
import { Icon, TYPE_ICON } from "./icons.tsx";
import { imeGhost } from "./keys.ts";
import { tip } from "./shortcuts.ts";
import { rankMatches } from "./title-match.ts";
import { Chip, relationLabel, docLabel } from "./cells.tsx";
import { DatePicker } from "./date-picker.tsx";
import { startGhostDrag, type DropWhere } from "./pointer-drag.ts";
import { t } from "./i18n/t.ts";
import { openMenu, closeMenu, MenuItem, MenuLabel, MenuSep, Highlight, promptDialog, confirmDialog, type MenuAnchor } from "./ui.tsx";
import {
  LAYOUTS, LAYOUT_ICON, layoutLabel, condsFor, WITHIN_PRESETS, newViewId,
  type ViewDef, type Layout, type FilterRule, type SortRule,
} from "./view-model.ts";

export type ViewPatch = Partial<Omit<ViewDef, "id">>;
/** Opens the record/document picker for a relation/doc filter value — table.tsx
 *  owns those menus, so the editor receives them as a callback. */
export type PickRefs = (anchor: MenuAnchor, prop: Prop, current: string[], onPick: (ids: string[]) => void) => void;

// ---- view tabs --------------------------------------------------------------

export function ViewTabs({ views, activeId, onSelect, onCreate, onRename, onDuplicate, onDelete, children }: {
  views: ViewDef[];
  activeId: string;
  onSelect: (id: string) => void;
  onCreate: (layout: Layout, name: string) => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  children?: ComponentChildren;
}) {
  const viewMenu = (e: MouseEvent, v: ViewDef) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e, (close) => (
      <>
        <MenuItem icon="pencil" label={t("重命名视图")} onClick={() => {
          close();
          promptDialog({ title: t("重命名视图"), value: v.name, confirmLabel: t("保存") }).then((name) => { if (name && name !== v.name) onRename(v.id, name); });
        }} />
        <MenuItem icon="copy" label={t("复制视图")} onClick={() => { close(); onDuplicate(v.id); }} />
        {views.length > 1 && (
          <>
            <MenuSep />
            <MenuItem icon="trash" label={t("删除视图")} danger onClick={async () => {
              close();
              const ok = await confirmDialog({ title: t("删除视图？"), message: t("「{name}」的筛选、排序和隐藏列设置将一并删除，记录不受影响。", { name: v.name }), confirmLabel: t("删除"), danger: true });
              if (ok) onDelete(v.id);
            }} />
          </>
        )}
      </>
    ));
  };
  const addMenu = (e: MouseEvent) =>
    openMenu(e, (close) => (
      <>
        <MenuLabel>{t("新建视图 · 选择布局")}</MenuLabel>
        {LAYOUTS.map((l) => (
          <MenuItem key={l} icon={LAYOUT_ICON[l]} label={layoutLabel(l)} onClick={() => {
            close();
            promptDialog({ title: t("新建视图"), value: layoutLabel(l), confirmLabel: t("创建") }).then((name) => { if (name) onCreate(l, name); });
          }} />
        ))}
      </>
    ));
  return (
    <div class="views">
      {views.map((v) => {
        const active = v.id === activeId;
        return (
          <div
            key={v.id}
            class={"view-tab" + (active ? " active" : "")}
            onClick={(e) => (active ? viewMenu(e, v) : onSelect(v.id))}
            onContextMenu={(e) => viewMenu(e, v)}
          >
            <Icon name={LAYOUT_ICON[v.layout]} />
            <span class="nm">{v.name}</span>
            {active && <Icon name="chevronDown" cls="ico sm caret" />}
          </div>
        );
      })}
      <button class="view-add" {...tip(t("新建视图"))} onClick={addMenu}><Icon name="plus" cls="ico sm" /></button>
      <div class="spacer" style={{ flex: 1 }} />
      {children}
    </div>
  );
}

// ---- toolbar ----------------------------------------------------------------

export function ViewToolbar({ props, view, onChange, onReorder, pickRefs, query, onQuery, children }: {
  props: Prop[];
  view: ViewDef;
  onChange: (patch: ViewPatch) => void;
  onReorder: (srcId: string, targetId: string, where: DropWhere) => void;
  pickRefs: PickRefs;
  query: string;
  onQuery: (q: string) => void;
  children?: ComponentChildren;
}) {
  const [searchOpen, setSearchOpen] = useState(query.length > 0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (searchOpen) inputRef.current?.focus(); }, [searchOpen]);
  const nFilter = view.filter.rules.length;
  const nSort = view.sort.length;
  const nHidden = view.hidden.filter((h) => props.some((p) => p.id === h)).length;
  const hideable = view.layout === "table";
  return (
    <div class="toolbar">
      <button class={"tbtn" + (nFilter ? " on" : "")} onClick={(e) => openAddFilter(e, props, view, onChange, pickRefs)}>
        <Icon name="filter" cls="ico sm" />{t("筛选")}{nFilter > 0 && <span class="tb-n">{nFilter}</span>}
      </button>
      <button class={"tbtn" + (nSort ? " on" : "")} onClick={(e) => openSortMenu(e, props, view, onChange)}>
        <Icon name="sort" cls="ico sm" />{t("排序")}{nSort > 0 && <span class="tb-n">{nSort}</span>}
      </button>
      {hideable && (
        <button class={"tbtn" + (nHidden ? " on" : "")} onClick={(e) => openPropsMenu(e, props, view, onChange, onReorder)}>
          <Icon name="eyeOff" cls="ico sm" />{t("属性")}{nHidden > 0 && <span class="tb-n">{nHidden}</span>}
        </button>
      )}
      {searchOpen ? (
        <div class="tb-search">
          <Icon name="search" cls="ico sm" />
          <input
            ref={inputRef}
            value={query}
            placeholder={t("在表中搜索…")}
            onInput={(e) => onQuery((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (imeGhost(e)) return;
              if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onQuery(""); setSearchOpen(false); }
            }}
          />
          <button class="clear" {...tip(t("关闭搜索"))} onMouseDown={(e) => e.preventDefault()} onClick={() => { onQuery(""); setSearchOpen(false); }}>
            <Icon name="x" cls="ico sm" />
          </button>
        </div>
      ) : (
        <button class="tbtn icon" {...tip(t("在表中搜索"))} onClick={() => setSearchOpen(true)}><Icon name="search" cls="ico sm" /></button>
      )}
      <div class="spacer" />
      {children}
    </div>
  );
}

// ---- chip row ---------------------------------------------------------------

export function ChipRow({ props, view, onChange, pickRefs }: {
  props: Prop[];
  view: ViewDef;
  onChange: (patch: ViewPatch) => void;
  pickRefs: PickRefs;
}) {
  const rules = view.filter.rules.filter((r) => props.some((p) => p.id === r.prop));
  const sorts = view.sort.filter((s) => props.some((p) => p.id === s.prop));
  if (!rules.length && !sorts.length) return null;
  const setRule = (next: FilterRule) => onChange({ filter: { ...view.filter, rules: view.filter.rules.map((r) => (r.id === next.id ? next : r)) } });
  const removeRule = (id: string) => onChange({ filter: { ...view.filter, rules: view.filter.rules.filter((r) => r.id !== id) } });
  return (
    <div class="tb-chips">
      {rules.map((r) => {
        const p = props.find((x) => x.id === r.prop)!;
        return (
          <button
            key={r.id}
            class="chip-rule"
            onClick={(e) => openRuleEditor({ rect: (e.currentTarget as HTMLElement).getBoundingClientRect() }, p, r, setRule, () => removeRule(r.id), pickRefs)}
          >
            <Icon name={TYPE_ICON[p.type] ?? "text"} cls="ico sm" />
            <span class="k">{p.name}</span>
            <span class="v">{ruleText(p, r)}</span>
            <span class="x" {...tip(t("移除筛选"))} onClick={(e) => { e.stopPropagation(); removeRule(r.id); }}><Icon name="x" cls="ico sm" /></span>
          </button>
        );
      })}
      {rules.length > 1 && (
        <button class="chip-rule op" onClick={() => onChange({ filter: { ...view.filter, op: view.filter.op === "and" ? "or" : "and" } })}>
          {view.filter.op === "and" ? t("满足全部") : t("满足任一")}
        </button>
      )}
      {sorts.map((s) => {
        const p = props.find((x) => x.id === s.prop)!;
        return (
          <button key={"s" + s.prop} class="chip-rule sort" onClick={(e) => openSortMenu(e, props, view, onChange)}>
            <Icon name="sort" cls="ico sm" />
            <span class="k">{p.name}</span>
            <span class="v">{s.desc ? t("降序") : t("升序")}</span>
            <span class="x" {...tip(t("移除排序"))} onClick={(e) => { e.stopPropagation(); onChange({ sort: view.sort.filter((x) => x.prop !== s.prop) }); }}><Icon name="x" cls="ico sm" /></span>
          </button>
        );
      })}
    </div>
  );
}

function ruleText(p: Prop, r: FilterRule): string {
  const cond = condsFor(p.type).find((c) => c.id === r.cond);
  if (!cond) return r.cond;
  const v = r.value;
  const has = !(v == null || v === "" || (Array.isArray(v) && v.length === 0));
  switch (cond.value) {
    case "none": return cond.label;
    case "text": return has ? `${cond.label} “${String(v)}”` : `${cond.label} …`;
    case "number": return has ? `${cond.label} ${String(v)}` : `${cond.label} …`;
    case "option": return has ? `${cond.label} ${String(v)}` : `${cond.label} …`;
    case "options": return has ? `${cond.label} ${(v as string[]).join(", ")}` : `${cond.label} …`;
    case "date": return has ? `${cond.label} ${String(v)}` : `${cond.label} …`;
    case "within": return has ? `${WITHIN_PRESETS.find((w) => w.id === v)?.label ?? String(v)}` : `${cond.label} …`;
    case "bool": return v === true || v === "true" ? t("已勾选") : t("未勾选");
    case "refs": return has ? `${cond.label} ${t("{n} 项", { n: (v as string[]).length })}` : `${cond.label} …`;
  }
}

// ---- filter: add + edit -----------------------------------------------------

function openAddFilter(e: MouseEvent, props: Prop[], view: ViewDef, onChange: (p: ViewPatch) => void, pickRefs: PickRefs) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  openMenu(e, (close) => (
    <PropPicker
      label={t("按属性筛选")}
      props={props}
      onPick={(p) => {
        close();
        const conds = condsFor(p.type);
        const rule: FilterRule = { id: newViewId().replace("v_", "f_"), prop: p.id, cond: conds[0]!.id, value: p.type === "checkbox" ? true : undefined };
        const rules = [...view.filter.rules, rule];
        onChange({ filter: { ...view.filter, rules } });
        let cur = rule;
        openRuleEditor(
          { rect },
          p,
          rule,
          (next) => { cur = next; onChange({ filter: { ...view.filter, rules: rules.map((r) => (r.id === next.id ? next : r)) } }); },
          () => onChange({ filter: { ...view.filter, rules: rules.filter((r) => r.id !== cur.id) } }),
          pickRefs,
        );
      }}
    />
  ), { minWidth: 240 });
}

function PropPicker({ label, props, onPick, exclude }: { label: string; props: Prop[]; onPick: (p: Prop) => void; exclude?: Set<string> }) {
  const [q, setQ] = useState("");
  const [selIdx, setSelIdx] = useState(0);
  const list = props.filter((p) => !exclude?.has(p.id));
  const ranked = rankMatches(q.trim(), list, (p) => p.name);
  const sel = Math.min(selIdx, Math.max(0, ranked.length - 1));
  return (
    <>
      <MenuLabel>{label}</MenuLabel>
      {list.length > 6 && (
        <div class="selsearch">
          <Icon name="search" cls="ico sm" />
          <input
            placeholder={t("搜索属性")}
            value={q}
            ref={(el) => { if (el && document.activeElement !== el) el.focus(); }}
            onInput={(e) => { setQ((e.target as HTMLInputElement).value); setSelIdx(0); }}
            onKeyDown={(e) => {
              if (imeGhost(e)) return;
              if (e.key === "ArrowDown") { e.preventDefault(); setSelIdx(Math.min(sel + 1, ranked.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSelIdx(Math.max(sel - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); if (ranked[sel]) onPick(ranked[sel].item); }
              else if (e.key === "Escape") { e.preventDefault(); closeMenu(); }
            }}
          />
        </div>
      )}
      <div class="rellist">
        {ranked.length === 0 && <div class="pal-empty">{t("没有匹配的属性")}</div>}
        {ranked.map(({ item: p, start, len }, i) => (
          <button key={p.id} class={"item" + (i === sel ? " sel" : "")} onClick={() => onPick(p)} onMouseEnter={() => setSelIdx(i)}>
            <span class="lico plain"><Icon name={TYPE_ICON[p.type] ?? "text"} cls="ico sm" /></span>
            <span class="meta"><span class="t"><Highlight text={p.name} span={start >= 0 ? [start, len] : undefined} /></span></span>
          </button>
        ))}
      </div>
    </>
  );
}

export function openRuleEditor(
  anchor: MenuAnchor,
  prop: Prop,
  rule: FilterRule,
  onChange: (r: FilterRule) => void,
  onRemove: () => void,
  pickRefs: PickRefs,
) {
  openMenu(anchor, (close) => (
    <RuleEditor prop={prop} rule={rule} onChange={onChange} onRemove={() => { close(); onRemove(); }} pickRefs={pickRefs} anchor={anchor} />
  ), { minWidth: 272 });
}

function RuleEditor({ prop, rule, onChange, onRemove, pickRefs, anchor }: {
  prop: Prop; rule: FilterRule; onChange: (r: FilterRule) => void; onRemove: () => void; pickRefs: PickRefs; anchor: MenuAnchor;
}) {
  const [cur, setCur] = useState<FilterRule>(rule);
  const conds = condsFor(prop.type);
  const cond = conds.find((c) => c.id === cur.cond) ?? conds[0]!;
  const set = (next: FilterRule) => { setCur(next); onChange(next); };
  const setCond = (id: string) => {
    const next = conds.find((c) => c.id === id)!;
    const keep = next.value === cond.value;
    set({ ...cur, cond: id, value: keep ? cur.value : next.value === "bool" ? true : undefined });
  };
  const options = prop.config?.options ?? [];
  const arr = Array.isArray(cur.value) ? (cur.value as string[]) : [];
  const toggle = (o: string) => {
    const s = new Set(arr);
    s.has(o) ? s.delete(o) : s.add(o);
    set({ ...cur, value: [...s] });
  };
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, [cond.value]);
  return (
    <div class="fr">
      <MenuLabel><Icon name={TYPE_ICON[prop.type] ?? "text"} cls="ico sm" /> {prop.name}</MenuLabel>
      <div class="fr-conds">
        {conds.map((c) => (
          <button key={c.id} class={"fr-cond" + (c.id === cur.cond ? " on" : "")} onClick={() => setCond(c.id)}>{c.label}</button>
        ))}
      </div>
      {cond.value === "text" || cond.value === "number" ? (
        <input
          ref={inputRef}
          class="field"
          inputMode={cond.value === "number" ? "decimal" : "text"}
          placeholder={cond.value === "number" ? t("数值") : t("文本")}
          value={cur.value == null ? "" : String(cur.value)}
          onInput={(e) => set({ ...cur, value: (e.target as HTMLInputElement).value })}
          onKeyDown={(e) => { if (!imeGhost(e) && (e.key === "Enter" || e.key === "Escape")) { e.preventDefault(); closeMenu(); } }}
        />
      ) : cond.value === "option" ? (
        <div class="rellist">
          {options.map((o) => (
            <button key={o} class="item" onClick={() => set({ ...cur, value: cur.value === o ? undefined : o })}>
              <Chip text={o} />{cur.value === o && <span class="chk"><Icon name="check" cls="ico sm" /></span>}
            </button>
          ))}
          {!options.length && <div class="pal-empty">{t("还没有选项")}</div>}
        </div>
      ) : cond.value === "options" ? (
        <div class="rellist">
          {options.map((o) => (
            <button key={o} class="item" onClick={() => toggle(o)}>
              <Chip text={o} />{arr.includes(o) && <span class="chk"><Icon name="check" cls="ico sm" /></span>}
            </button>
          ))}
          {!options.length && <div class="pal-empty">{t("还没有选项")}</div>}
        </div>
      ) : cond.value === "date" ? (
        <DatePicker value={cur.value} onPick={(v) => set({ ...cur, value: v ?? undefined })} />
      ) : cond.value === "within" ? (
        <div class="rellist">
          {WITHIN_PRESETS.map((w) => (
            <MenuItem key={w.id} label={w.label} checked={cur.value === w.id} onClick={() => set({ ...cur, value: w.id })} />
          ))}
        </div>
      ) : cond.value === "bool" ? (
        <>
          <MenuItem icon="check" label={t("已勾选")} checked={cur.value === true || cur.value === "true"} onClick={() => set({ ...cur, value: true })} />
          <MenuItem icon="x" label={t("未勾选")} checked={!(cur.value === true || cur.value === "true")} onClick={() => set({ ...cur, value: false })} />
        </>
      ) : cond.value === "refs" ? (
        <>
          <div class="fr-refs">
            {arr.map((id) => (
              <Chip key={id} text={prop.type === "doc" ? docLabel(id).label : relationLabel(prop.config?.database, id)} />
            ))}
            {!arr.length && <span class="muted">{t("未选择")}</span>}
          </div>
          <MenuItem icon="search" label={t("选择…")} onClick={() => pickRefs(anchor, prop, arr, (ids) => onChange({ ...cur, value: ids }))} />
        </>
      ) : null}
      <MenuSep />
      <MenuItem icon="trash" label={t("移除筛选")} danger onClick={onRemove} />
    </div>
  );
}

// ---- sort -------------------------------------------------------------------

export function openSortMenu(e: MouseEvent, props: Prop[], view: ViewDef, onChange: (p: ViewPatch) => void) {
  openMenu(e, (close) => <SortMenu props={props} initial={view.sort} onChange={(sort) => onChange({ sort })} close={close} />, { minWidth: 260 });
}

function SortMenu({ props, initial, onChange, close }: { props: Prop[]; initial: SortRule[]; onChange: (s: SortRule[]) => void; close: () => void }) {
  const [rules, setRules] = useState<SortRule[]>(initial.filter((s) => props.some((p) => p.id === s.prop)));
  const [adding, setAdding] = useState(rules.length === 0);
  const set = (next: SortRule[]) => { setRules(next); onChange(next); };
  const used = new Set(rules.map((r) => r.prop));
  const startDrag = (e: any, s: SortRule) => {
    if (e.button !== 0) return;
    const source = (e.currentTarget as HTMLElement).closest(".optrow") as HTMLElement | null;
    if (!source) return;
    startGhostDrag(e, {
      source, axis: "y", ghostCls: "col-ghost", ghostText: props.find((p) => p.id === s.prop)?.name ?? "", targetSelector: ".optrow[data-opt]",
      isSelf: (el) => el.dataset.opt === s.prop,
      onDrop: (el, where) => {
        const next = rules.filter((x) => x.prop !== s.prop);
        let to = next.findIndex((x) => x.prop === el.dataset.opt);
        if (to < 0) return;
        if (where === "after") to += 1;
        next.splice(to, 0, s);
        set(next);
      },
    });
  };
  if (adding) {
    return (
      <>
        <PropPicker label={t("添加排序")} props={props} exclude={used} onPick={(p) => { set([...rules, { prop: p.id, desc: false }]); setAdding(false); }} />
        {rules.length > 0 && (<><MenuSep /><MenuItem icon="arrowLeft" label={t("返回")} onClick={() => setAdding(false)} /></>)}
      </>
    );
  }
  return (
    <>
      <MenuLabel>{t("排序")}</MenuLabel>
      {rules.map((s) => {
        const p = props.find((x) => x.id === s.prop)!;
        return (
          <div key={s.prop} class="optrow sortrow" data-opt={s.prop}>
            <span class="grip" onPointerDown={(e) => startDrag(e, s)}><Icon name="grip" cls="ico sm" /></span>
            <span class="sortname"><Icon name={TYPE_ICON[p.type] ?? "text"} cls="ico sm" />{p.name}</span>
            <button class="sortdir" onClick={() => set(rules.map((x) => (x.prop === s.prop ? { ...x, desc: !x.desc } : x)))}>
              <Icon name={s.desc ? "arrowUp" : "arrowUp"} cls={"ico sm" + (s.desc ? " flipv" : "")} />{s.desc ? t("降序") : t("升序")}
            </button>
            <button class="x del" {...tip(t("移除排序"))} onClick={() => set(rules.filter((x) => x.prop !== s.prop))}><Icon name="x" cls="ico sm" /></button>
          </div>
        );
      })}
      <MenuSep />
      {used.size < props.length && <MenuItem icon="plus" label={t("添加排序")} onClick={() => setAdding(true)} />}
      {rules.length > 0 && <MenuItem icon="x" label={t("清除排序")} onClick={() => { set([]); close(); }} />}
    </>
  );
}

// ---- properties (visibility + order) ---------------------------------------

export function openPropsMenu(e: MouseEvent, props: Prop[], view: ViewDef, onChange: (p: ViewPatch) => void, onReorder: (srcId: string, targetId: string, where: DropWhere) => void) {
  openMenu(e, () => <PropsMenu props={props} initial={view.hidden} onChange={(hidden) => onChange({ hidden })} onReorder={onReorder} />, { minWidth: 250 });
}

function PropsMenu({ props: initialProps, initial, onChange, onReorder }: { props: Prop[]; initial: string[]; onChange: (h: string[]) => void; onReorder: (srcId: string, targetId: string, where: DropWhere) => void }) {
  const [hidden, setHidden] = useState<string[]>(initial);
  const [order, setOrder] = useState<Prop[]>(initialProps);
  const set = (next: string[]) => { setHidden(next); onChange(next); };
  const title = order[0];
  const toggle = (id: string) => set(hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id]);
  const startDrag = (e: any, p: Prop) => {
    if (e.button !== 0) return;
    const source = (e.currentTarget as HTMLElement).closest(".optrow") as HTMLElement | null;
    if (!source) return;
    startGhostDrag(e, {
      source, axis: "y", ghostCls: "col-ghost", ghostText: p.name, targetSelector: ".optrow[data-opt]",
      isSelf: (el) => el.dataset.opt === p.id,
      onDrop: (el, where) => {
        const next = order.filter((x) => x.id !== p.id);
        let to = next.findIndex((x) => x.id === el.dataset.opt);
        if (to < 0) return;
        if (where === "after") to += 1;
        next.splice(to, 0, p);
        setOrder(next);
        onReorder(p.id, el.dataset.opt!, where);
      },
    });
  };
  return (
    <>
      <MenuLabel>{t("属性")}</MenuLabel>
      {order.map((p) => {
        const on = !hidden.includes(p.id);
        const locked = p === title;
        return (
          <div key={p.id} class={"optrow proprow-v" + (on ? "" : " off")} data-opt={p.id}>
            <span class="grip" onPointerDown={(e) => startDrag(e, p)}><Icon name="grip" cls="ico sm" /></span>
            <button class="optlabel" disabled={locked} onClick={() => !locked && toggle(p.id)}>
              <Icon name={TYPE_ICON[p.type] ?? "text"} cls="ico sm" /><span class="nm">{p.name}</span>
            </button>
            <button class="x" disabled={locked} {...tip(locked ? t("标题列始终显示") : on ? t("隐藏") : t("显示"))} onClick={() => !locked && toggle(p.id)}>
              <Icon name={on ? "eye" : "eyeOff"} cls="ico sm" />
            </button>
          </div>
        );
      })}
      <MenuSep />
      <MenuItem icon="eye" label={t("全部显示")} onClick={() => set([])} />
      <MenuItem icon="eyeOff" label={t("隐藏全部")} onClick={() => set(order.filter((p) => p !== title).map((p) => p.id))} />
    </>
  );
}
