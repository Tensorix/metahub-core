/** @jsxImportSource preact */
// ⌘⇧P palette: registered commands + entities resolved via /api/resolve. `open` mode = 「按 ID 打开…」.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, type LookupHit } from "./api.ts";
import { Icon } from "./icons.tsx";
import { MenuItem, MenuLabel, closeModal, openModal } from "./ui.tsx";
import { COMMAND_GROUPS, listCommands, onCommandsChange, type Command } from "./commands.ts";
import type { Navigate } from "./view.ts";
import { shortcutAvailable } from "./shortcuts.ts";

export type PaletteMode = "commands" | "open";

export interface PaletteCtx {
  navigate: Navigate;
  /** Database display name for a hit's owning db (undefined while nav loads). */
  dbName: (id: string) => string | undefined;
}

/** Input → resolver ref: hash link (deepest id), `[[id|text]]`, or the text itself. */
export function refFromInput(text: string): string {
  const t = text.trim();
  const url = t.match(/#\/(?:doc|db)\/((?:doc|db)_[a-z0-9][a-z0-9-]*)(?:\/(rec_[a-z0-9][a-z0-9-]*))?/);
  if (url) return url[2] ?? url[1]!;
  const link = t.match(/^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/);
  if (link) return link[1]!.trim();
  return t;
}

const looksLikeId = (ref: string) => /^(doc|db|rec)_/.test(ref);

export function openHit(hit: LookupHit, navigate: Navigate): void {
  if (hit.kind === "doc") navigate({ kind: "doc", id: hit.id });
  else if (hit.kind === "db") navigate({ kind: "db", id: hit.id });
  else if (hit.database_id) navigate({ kind: "db", id: hit.database_id, rec: hit.id });
}

const HIT_ICON: Record<LookupHit["kind"], string> = { doc: "doc", db: "database", rec: "table" };
const HIT_NOUN: Record<LookupHit["kind"], string> = { doc: "文档", db: "数据库", rec: "记录" };

type Row = { key: string; cmd: Command } | { key: string; hit: LookupHit };

export function openPalette(mode: PaletteMode, ctx: PaletteCtx): void {
  openModal(<Palette mode={mode} ctx={ctx} />);
}

function Palette({ mode, ctx }: { mode: PaletteMode; ctx: PaletteCtx }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<LookupHit[]>([]);
  const [resolvedFor, setResolvedFor] = useState("");
  const [selIdx, setSelIdx] = useState(0);
  const [, bump] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useEffect(() => onCommandsChange(() => bump((n) => n + 1)), []);

  const ref = refFromInput(query);
  useEffect(() => {
    if (!ref) {
      seq.current++;
      setHits([]);
      setResolvedFor("");
      return;
    }
    const my = ++seq.current;
    const t = setTimeout(() => {
      api.resolve(ref, 20)
        .then((rows) => {
          if (my !== seq.current) return;
          setHits(rows);
          setResolvedFor(ref);
        })
        .catch(() => {
          if (my !== seq.current) return;
          setHits([]);
          setResolvedFor(ref);
        });
    }, 120);
    return () => clearTimeout(t);
  }, [ref]);

  const q = query.trim().toLowerCase();
  const cmds =
    mode === "open" ? [] : q ? listCommands().filter((c) => c.label.toLowerCase().includes(q)) : listCommands();
  const hitRows: Row[] = hits.map((h) => ({ key: "h:" + h.id, hit: h }));
  const cmdRows: Row[] = cmds.map((c) => ({ key: "c:" + c.id, cmd: c }));
  const idFirst = looksLikeId(ref);
  const rows: Row[] = idFirst ? [...hitRows, ...cmdRows] : [...cmdRows, ...hitRows];
  const sel = Math.min(selIdx, Math.max(0, rows.length - 1));

  useEffect(() => {
    listRef.current?.querySelector(".item.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel, rows.length]);

  const pick = (r: Row) => {
    closeModal();
    if ("cmd" in r) r.cmd.run();
    else openHit(r.hit, ctx.navigate);
  };

  const settled = resolvedFor === ref;
  const empty = rows.length === 0 && (!ref || settled);
  const notFound = empty && !!ref && looksLikeId(ref);

  const renderRows = (list: Row[], offset: number) =>
    list.map((r, i) => {
      const idx = offset + i;
      if ("cmd" in r) {
        return (
          <MenuItem
            key={r.key}
            icon={r.cmd.icon}
            label={r.cmd.label}
            shortcut={r.cmd.shortcut && shortcutAvailable(r.cmd.shortcut) ? r.cmd.shortcut : undefined}
            sel={idx === sel}
            onHover={() => setSelIdx(idx)}
            onClick={() => pick(r)}
          />
        );
      }
      const h = r.hit;
      const owner = h.database_id ? ctx.dbName(h.database_id) : undefined;
      const where = [HIT_NOUN[h.kind], owner ? `· ${owner}` : "", h.id].filter(Boolean).join(" ");
      return (
        <MenuItem
          key={r.key}
          icon={HIT_ICON[h.kind]}
          label={h.label || (h.kind === "db" ? "未命名数据库" : h.kind === "doc" ? "无标题" : "未命名记录")}
          sublabel={where}
          sel={idx === sel}
          onHover={() => setSelIdx(idx)}
          onClick={() => pick(r)}
        />
      );
    });

  const first = idFirst ? hitRows : cmdRows;
  const second = idFirst ? cmdRows : hitRows;
  const label = (list: Row[]) => (list === hitRows ? "打开" : null);

  const sections: { key: string; label: string | null; list: Row[]; offset: number }[] = [];
  if (first.length) sections.push({ key: "a", label: label(first), list: first, offset: 0 });
  if (second.length) sections.push({ key: "b", label: label(second), list: second, offset: first.length });

  return (
    <div class="modal palette" onMouseDown={(e) => e.stopPropagation()}>
      <div class="selsearch">
        <Icon name={mode === "open" ? "hash" : "search"} cls="ico sm" />
        <input
          placeholder={mode === "open" ? "输入 ID、前缀或名称" : "输入命令、ID 或名称"}
          value={query}
          ref={(el) => { if (el && document.activeElement !== el) el.focus(); }}
          onInput={(e) => { setQuery((e.target as HTMLInputElement).value); setSelIdx(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSelIdx(Math.min(sel + 1, rows.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSelIdx(Math.max(sel - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); if (rows[sel]) pick(rows[sel]); }
          }}
        />
        {query && (
          <button class="clear" title="清空" onMouseDown={(e) => e.preventDefault()} onClick={() => { setQuery(""); setSelIdx(0); }}>
            <Icon name="x" cls="ico sm" />
          </button>
        )}
      </div>
      <div ref={listRef} class="rellist">
        {sections.map((s) => {
          const grouped = s.list === cmdRows && !q;
          if (!grouped) {
            return (
              <div key={s.key}>
                {s.label && <MenuLabel>{s.label}</MenuLabel>}
                {renderRows(s.list, s.offset)}
              </div>
            );
          }
          let off = s.offset;
          return (
            <div key={s.key}>
              {COMMAND_GROUPS.map((g) => {
                const part = s.list.filter((r) => "cmd" in r && r.cmd.group === g.key);
                if (!part.length) return null;
                const start = off;
                off += part.length;
                return (
                  <div key={g.key}>
                    <MenuLabel>{g.label}</MenuLabel>
                    {renderRows(part, start)}
                  </div>
                );
              })}
            </div>
          );
        })}
        {notFound && <MenuLabel>未找到 {ref}，可能未同步或已删除</MenuLabel>}
        {empty && !notFound && <MenuLabel>{ref ? "无匹配" : "暂无可用命令"}</MenuLabel>}
      </div>
    </div>
  );
}
