import { imeGhost } from "./keys.ts";

export const IS_MAC =
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad/i.test(
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
      navigator.platform,
  );

export const IS_DESKTOP_APP = typeof window !== "undefined" && !!window.metahubDesktop;

export interface Combo {
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  key: string;
}

export type ShortcutGroup = "nav" | "create" | "editor" | "quicknote";

export interface Shortcut {
  id: string;
  label: string;
  group: ShortcutGroup;
  keys: Combo | { mac: Combo; other: Combo };
  desktopOnly?: boolean;
}

export const SHORTCUT_GROUPS: { key: ShortcutGroup; label: string }[] = [
  { key: "nav", label: "导航" },
  { key: "create", label: "新建" },
  { key: "editor", label: "编辑器" },
  { key: "quicknote", label: "快速笔记" },
];

export const SHORTCUTS: Shortcut[] = [
  { id: "back", label: "后退", group: "nav", keys: { mac: { mod: true, key: "[" }, other: { alt: true, key: "ArrowLeft" } } },
  { id: "forward", label: "前进", group: "nav", keys: { mac: { mod: true, key: "]" }, other: { alt: true, key: "ArrowRight" } } },
  { id: "search", label: "搜索", group: "nav", keys: { mod: true, key: "k" } },
  { id: "sidebar", label: "折叠 / 展开侧栏", group: "nav", keys: { mod: true, key: "\\" } },
  { id: "tabDocs", label: "侧栏：文档", group: "nav", keys: { mod: true, key: "1" }, desktopOnly: true },
  { id: "tabDb", label: "侧栏：数据表", group: "nav", keys: { mod: true, key: "2" }, desktopOnly: true },
  { id: "tabSites", label: "侧栏：站点", group: "nav", keys: { mod: true, key: "3" }, desktopOnly: true },
  { id: "settings", label: "打开设置", group: "nav", keys: { mod: true, key: "," } },
  { id: "closeMenu", label: "关闭菜单 / 弹窗", group: "nav", keys: { key: "Escape" } },
  { id: "newDoc", label: "新建文档", group: "create", keys: { mod: true, key: "n" }, desktopOnly: true },
  { id: "newDb", label: "新建数据库", group: "create", keys: { mod: true, shift: true, key: "n" }, desktopOnly: true },
  { id: "save", label: "保存到同步桶", group: "editor", keys: { mod: true, key: "s" } },
  { id: "toggleSource", label: "块 / 代码方式切换", group: "editor", keys: { mod: true, key: "/" } },
  { id: "find", label: "文内查找", group: "editor", keys: { mod: true, key: "f" } },
  { id: "duplicateBlock", label: "复制当前块", group: "editor", keys: { mod: true, key: "d" } },
  { id: "indent", label: "列表缩进", group: "editor", keys: { key: "Tab" } },
  { id: "outdent", label: "列表反缩进", group: "editor", keys: { shift: true, key: "Tab" } },
  { id: "qnNew", label: "新建笔记", group: "quicknote", keys: { mod: true, key: "n" }, desktopOnly: true },
  { id: "qnPrev", label: "上一条笔记", group: "quicknote", keys: { mod: true, key: "[" }, desktopOnly: true },
  { id: "qnNext", label: "下一条笔记", group: "quicknote", keys: { mod: true, key: "]" }, desktopOnly: true },
  { id: "qnOpenMain", label: "在主窗口中打开", group: "quicknote", keys: { mod: true, shift: true, key: "o" }, desktopOnly: true },
  { id: "qnHide", label: "隐藏小窗", group: "quicknote", keys: { key: "Escape" }, desktopOnly: true },
];

const BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]));

export function comboOf(id: string): Combo {
  const s = BY_ID.get(id);
  if (!s) throw new Error(`unknown shortcut: ${id}`);
  return "mac" in s.keys ? (IS_MAC ? s.keys.mac : s.keys.other) : s.keys;
}

export function mod(e: KeyboardEvent): boolean {
  return IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

export function matchCombo(e: KeyboardEvent, c: Combo): boolean {
  if (e.defaultPrevented || imeGhost(e)) return false;
  if (!!c.mod !== mod(e)) return false;
  if (!c.mod && (e.metaKey || e.ctrlKey)) return false;
  if (!!c.shift !== e.shiftKey || !!c.alt !== e.altKey) return false;
  return e.key.toLowerCase() === c.key.toLowerCase();
}

export function pressed(e: KeyboardEvent, id: string): boolean {
  return matchCombo(e, comboOf(id));
}

const KEY_GLYPH: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Escape: "Esc",
  Tab: "Tab",
};

export function comboKeys(c: Combo): string[] {
  const k = KEY_GLYPH[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key);
  const mods = IS_MAC
    ? [c.mod ? "⌘" : "", c.alt ? "⌥" : "", c.shift ? "⇧" : ""]
    : [c.mod ? "Ctrl" : "", c.alt ? "Alt" : "", c.shift ? "Shift" : ""];
  return [...mods.filter(Boolean), k];
}

export function comboLabel(c: Combo): string {
  return comboKeys(c).join(IS_MAC ? "" : " ");
}

export function kbd(id: string): string {
  return comboLabel(comboOf(id));
}

export function isSymKey(k: string): boolean {
  return k.length === 1 && !/[a-z0-9]/i.test(k);
}

export function shortcutAvailable(id: string): boolean {
  const s = BY_ID.get(id);
  return !!s && (!s.desktopOnly || IS_DESKTOP_APP);
}

export interface TipAttrs {
  "data-tip": string;
  "data-tip-kbd"?: string;
  "aria-label": string;
}

export function tip(label: string, id?: string): TipAttrs {
  const k = id && shortcutAvailable(id) ? id : undefined;
  return { "data-tip": label, ...(k ? { "data-tip-kbd": k } : {}), "aria-label": label };
}
