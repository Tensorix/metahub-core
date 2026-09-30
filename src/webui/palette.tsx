/** @jsxImportSource preact */
// ⌘⇧P palette: recents, registered commands, local title matches, /api/resolve
// hits and full-text hits in one list. `open` mode = 「按 ID 打开…」.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { api, type Db, type DocSummary, type Hit, type LookupHit } from "./api.ts";
import { Icon } from "./icons.tsx";
import { Kbd } from "./kbd.tsx";
import { t } from "./i18n/t.ts";
import { Highlight, MenuItem, MenuLabel, ReturnHint, SnippetText, closeModal, openModal } from "./ui.tsx";
import { COMMAND_GROUPS, commandMatches, listCommands, onCommandsChange, type Command } from "./commands.ts";
import { resolveLocale } from "./i18n/locale.ts";
import { listRecents } from "./recents.ts";
import { matchTitles } from "./title-match.ts";
import { dbName, docPath } from "./crumb.ts";
import type { Navigate } from "./view.ts";
import { imeGhost } from "./keys.ts";

export type PaletteMode = "commands" | "open";
/** document event: any surface can ask the app shell to open the palette. */
export const OPEN_PALETTE = "mh-open-palette";

export interface PaletteCtx {
  navigate: Navigate;
  docs: () => DocSummary[];
  databases: () => Db[];
}

/** Input → resolver ref: hash link (deepest id), `[[id|text]]`, or the text itself. */
export function refFromInput(text: string): string {
  const s = text.trim();
  const url = s.match(/#\/(?:doc|db)\/((?:doc|db)_[a-z0-9][a-z0-9-]*)(?:\/(rec_[a-z0-9][a-z0-9-]*))?/);
  if (url) return url[2] ?? url[1]!;
  const link = s.match(/^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/);
  if (link) return link[1]!.trim();
  return s;
}

const looksLikeId = (ref: string) => /^(doc|db|rec)_/.test(ref);

type Kind = LookupHit["kind"];

interface Entry {
  kind: Kind;
  id: string;
  label: string;
  database_id: string | null;
  /** Highlighted span of `label`. */
  hl?: [number, number];
  /** Full-text snippet (content hits only). */
  snippet?: string;
}

export function openEntry(e: { kind: Kind; id: string; database_id: string | null }, navigate: Navigate): void {
  if (e.kind === "doc") navigate({ kind: "doc", id: e.id });
  else if (e.kind === "db") navigate({ kind: "db", id: e.id });
  else if (e.database_id) navigate({ kind: "db", id: e.database_id, rec: e.id });
}

const KIND_ICON: Record<Kind, string> = { doc: "fileText", db: "database", rec: "table" };
const kindNoun = (k: Kind) => (k === "doc" ? t("文档##kind") : k === "db" ? t("数据库") : t("记录"));
const untitled = (k: Kind) => (k === "db" ? t("未命名数据库") : k === "doc" ? t("无标题") : t("未命名记录"));
const kindOf = (id: string): Kind => (id.startsWith("db_") ? "db" : id.startsWith("rec_") ? "rec" : "doc");

type Row = { key: string; cmd: Command } | { key: string; entry: Entry } | { key: string; search: string };
interface Section {
  key: string;
  label: string | null;
  rows: Row[];
}

export function openPalette(mode: PaletteMode, ctx: PaletteCtx): void {
  openModal(<Palette mode={mode} ctx={ctx} />);
}

function useDebounced<T>(active: boolean, key: string, ms: number, run: () => Promise<T>, empty: T): T {
  const [val, setVal] = useState<T>(empty);
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    if (!active) {
      setVal(empty);
      return;
    }
    const timer = setTimeout(() => {
      run().then(
        (v) => my === seq.current && setVal(v),
        () => my === seq.current && setVal(empty),
      );
    }, ms);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key]);
  return val;
}

/** Client-side highlight for snippets that carry no `[..]` markers (CJK LIKE fallback). */
function Snippet({ text, q }: { text: string; q: string }) {
  if (/\[[^\[\]]*\]/.test(text) || !q) return <SnippetText text={text} />;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  return <Highlight text={text} span={i >= 0 ? [i, q.length] : undefined} />;
}

function Palette({ mode, ctx }: { mode: PaletteMode; ctx: PaletteCtx }) {
  const [query, setQuery] = useState("");
  const [selIdx, setSelIdx] = useState(0);
  const [, bump] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => onCommandsChange(() => bump((n) => n + 1)), []);

  const q = query.trim();
  const ql = q.toLowerCase();
  const showEn = resolveLocale() !== "en";
  const ref = refFromInput(query);
  const idMode = mode === "open" || looksLikeId(ref);

  const docs = ctx.docs();
  const dbs = ctx.databases();
  const docById = useMemo(() => new Map(docs.map((d) => [d.id, d])), [docs]);
  const dbById = useMemo(() => new Map(dbs.map((d) => [d.id, d])), [dbs]);

  const ownerOf = (id: string, kind: Kind, fallback: string | null): string | null =>
    kind === "doc" ? (docById.get(id)?.database_id ?? fallback) : kind === "rec" ? fallback : null;

  const crumb = (e: Entry): string => {
    if (e.kind === "doc") return docPath(e.id, docs, dbs).map((s) => s.label).join(" › ");
    if (e.kind === "rec" && e.database_id) return dbName(e.database_id, dbs);
    return "";
  };

  const resolved = useDebounced<LookupHit[]>(!!ref, ref, 120, () => api.resolve(ref, 20), []);
  const searchable = mode !== "open" && !looksLikeId(ref) && (q.length >= 2 || /[^\x00-\x7f]/.test(q));
  const found = useDebounced<Hit[]>(searchable, q, 200, () => api.search(q, 6), []);

  const sections: Section[] = [];
  const seen = new Set<string>();
  const entryRow = (e: Entry): Row | null => {
    if (seen.has(e.id)) return null;
    seen.add(e.id);
    return { key: "e:" + e.id, entry: e };
  };
  const cmdRow = (c: Command): Row => ({ key: "c:" + c.id, cmd: c });

  if (!q) {
    const recent: Row[] = [];
    for (const r of listRecents()) {
      const label = r.kind === "doc" ? docById.get(r.id)?.title : dbById.get(r.id)?.name;
      if (label === undefined) continue;
      const row = entryRow({ kind: r.kind, id: r.id, label, database_id: ownerOf(r.id, r.kind, null) });
      if (row) recent.push(row);
    }
    if (recent.length) sections.push({ key: "recent", label: t("最近打开"), rows: recent });
    if (mode !== "open") {
      const all = listCommands();
      for (const g of COMMAND_GROUPS) {
        const rows = all.filter((c) => c.group === g.key).map(cmdRow);
        if (rows.length) sections.push({ key: "g:" + g.key, label: g.label, rows });
      }
    }
  } else {
    const open: Row[] = [];
    const exact = resolved.filter((h) => h.id === ref);
    for (const h of exact) {
      const row = entryRow({ ...h });
      if (row) open.push(row);
    }
    for (const m of matchTitles(ql, 8)) {
      const kind = kindOf(m.id);
      const row = entryRow({
        kind,
        id: m.id,
        label: m.title,
        database_id: ownerOf(m.id, kind, null),
        hl: m.start >= 0 ? [m.start, m.len] : undefined,
      });
      if (row) open.push(row);
    }
    for (const h of resolved) {
      const row = entryRow({ ...h, database_id: ownerOf(h.id, h.kind, h.database_id) });
      if (row) open.push(row);
    }
    const cmds = mode === "open" ? [] : listCommands().filter((c) => commandMatches(c, q)).map(cmdRow);
    const content: Row[] = [];
    for (const h of found) {
      const kind: Kind = h.type === "document" ? "doc" : "rec";
      const row = entryRow({
        kind,
        id: h.id,
        label: h.title ?? (kind === "doc" ? docById.get(h.id)?.title ?? "" : ""),
        database_id: h.database_id,
        snippet: h.snippet,
      });
      if (row) content.push(row);
    }
    if (idMode) {
      if (open.length) sections.push({ key: "open", label: t("打开"), rows: open });
      if (cmds.length) sections.push({ key: "cmds", label: t("命令"), rows: cmds });
    } else {
      if (open.length) sections.push({ key: "open", label: t("打开"), rows: open });
      if (cmds.length) sections.push({ key: "cmds", label: t("命令"), rows: cmds });
      if (content.length) sections.push({ key: "content", label: t("内容匹配"), rows: content });
      sections.push({ key: "search", label: null, rows: [{ key: "s", search: q }] });
    }
  }

  const rows = sections.flatMap((s) => s.rows);
  const sel = Math.min(selIdx, Math.max(0, rows.length - 1));
  useEffect(() => {
    listRef.current?.querySelector(".item.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel, rows.length]);

  const pick = (r: Row) => {
    closeModal();
    if ("cmd" in r) r.cmd.run();
    else if ("search" in r) ctx.navigate({ kind: "search", q: r.search });
    else openEntry(r.entry, ctx.navigate);
  };

  const empty = rows.every((r) => "search" in r);
  const notFound = empty && !!q && looksLikeId(ref);

  let idx = 0;
  const renderRow = (r: Row) => {
    const i = idx++;
    const isSel = i === sel;
    if ("search" in r) {
      return (
        <MenuItem
          key={r.key}
          icon="search"
          label={t("在全部内容中搜索 “{q}”", { q: r.search })}
          sel={isSel}
          onHover={() => setSelIdx(i)}
          onClick={() => pick(r)}
        />
      );
    }
    if ("cmd" in r) {
      return (
        <MenuItem
          key={r.key}
          icon={r.cmd.icon}
          label={r.cmd.label}
          sublabel={showEn && r.cmd.en !== r.cmd.label ? r.cmd.en : undefined}
          shortcut={r.cmd.shortcut}
          sub="right"
          sel={isSel}
          onHover={() => setSelIdx(i)}
          onClick={() => pick(r)}
        />
      );
    }
    const e = r.entry;
    const emoji = e.kind === "db" ? dbById.get(e.id)?.icon || "🗂️" : null;
    const where = idMode ? e.id : crumb(e);
    const title: ComponentChildren = e.label ? (
      <Highlight text={e.label} span={e.hl} />
    ) : e.kind === "rec" && e.snippet ? (
      kindNoun(e.kind)
    ) : (
      untitled(e.kind)
    );
    return (
      <button key={r.key} class={"item sub-r" + (isSel ? " sel" : "")} onClick={() => pick(r)} onMouseEnter={() => setSelIdx(i)}>
        <span class="lico plain">{emoji ? <span class="emo">{emoji}</span> : <Icon name={KIND_ICON[e.kind]} cls="ico sm" />}</span>
        <span class="meta">
          <span class="t">{title}</span>
          {e.snippet ? (
            <span class="d snip"><Snippet text={e.snippet} q={q} /></span>
          ) : (
            where && <span class="d crumb">{where}</span>
          )}
        </span>
        <ReturnHint />
      </button>
    );
  };

  return (
    <div class="modal palette" onMouseDown={(e) => e.stopPropagation()}>
      <div class="pal-head">
        <Icon name={mode === "open" ? "hash" : "search"} cls="ico" />
        <input
          placeholder={mode === "open" ? t("输入 ID、前缀或名称") : t("搜索页面、输入命令或粘贴 ID")}
          value={query}
          ref={(el) => { if (el && document.activeElement !== el) el.focus(); }}
          onInput={(e) => { setQuery((e.target as HTMLInputElement).value); setSelIdx(0); }}
          onKeyDown={(e) => {
            if (imeGhost(e)) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setSelIdx(Math.min(sel + 1, rows.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSelIdx(Math.max(sel - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); if (rows[sel]) pick(rows[sel]); }
          }}
        />
        {query ? (
          <button class="clear" title={t("清空")} onMouseDown={(e) => e.preventDefault()} onClick={() => { setQuery(""); setSelIdx(0); }}>
            <Icon name="x" cls="ico sm" />
          </button>
        ) : (
          <Kbd combo={{ key: "Escape" }} />
        )}
        <button class="pal-close" title={t("关闭")} onClick={closeModal}>
          <Icon name="x" cls="ico sm" />
        </button>
      </div>
      <div ref={listRef} class="pal-list">
        {sections.map((s) => (
          <div key={s.key} class="pal-sec">
            {s.label && <MenuLabel>{s.label}</MenuLabel>}
            {s.rows.map(renderRow)}
          </div>
        ))}
        {notFound && <div class="pal-empty">{t("未找到 {ref}，可能未同步或已删除", { ref })}</div>}
        {empty && !notFound && q && <div class="pal-empty">{t("没有匹配的页面或命令")}</div>}
        {empty && !q && <div class="pal-empty">{t("暂无可用命令")}</div>}
      </div>
      <div class="pal-foot">
        <span class="keys">
          <kbd class="kbd"><span class="key sym">↑</span><span class="key sym">↓</span></kbd> {t("选择")}
          <kbd class="kbd"><span class="key sym">↵</span></kbd> {t("打开")}
          <kbd class="kbd"><span class="key">Esc</span></kbd> {t("关闭")}
        </span>
        <span class="hint">{t("可粘贴 ID 或链接")}</span>
      </div>
    </div>
  );
}
