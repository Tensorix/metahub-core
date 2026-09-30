// Command registry for the ⌘⇧P palette; owners register/unregister their actions.
import { t } from "./i18n/t.ts";

export type CommandGroup = "nav" | "create" | "doc";

export interface Command {
  id: string;
  label: string;
  /** English name (tIn("en", key)) — matched alongside `label`, shown as a hint in other locales. */
  en: string;
  group: CommandGroup;
  icon?: string;
  /** shortcuts.ts id, shown as a key-cap badge. */
  shortcut?: string;
  /** Position within the group (lower first; default 50). */
  order?: number;
  run: () => void;
}

export const COMMAND_GROUPS: { key: CommandGroup; label: string }[] = [
  { key: "doc", label: t("当前文档") },
  { key: "nav", label: t("导航") },
  { key: "create", label: t("新建") },
];

const registry = new Map<string, Command>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

export function registerCommands(cmds: Command[]): () => void {
  for (const c of cmds) registry.set(c.id, c);
  notify();
  return () => {
    for (const c of cmds) if (registry.get(c.id) === c) registry.delete(c.id);
    notify();
  };
}

const ORDER = new Map(COMMAND_GROUPS.map((g, i) => [g.key, i]));

export function listCommands(): Command[] {
  return [...registry.values()].sort(
    (a, b) =>
      (ORDER.get(a.group) ?? 99) - (ORDER.get(b.group) ?? 99) || (a.order ?? 50) - (b.order ?? 50),
  );
}

export function onCommandsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const initials = (s: string) =>
  s
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => w[0]!)
    .join("")
    .toLowerCase();

/** Case-insensitive substring on the localized label or the English name, or the English initials (`os` → Open settings). */
export function commandMatches(c: Pick<Command, "label" | "en">, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return c.label.toLowerCase().includes(q) || c.en.toLowerCase().includes(q) || initials(c.en).startsWith(q);
}
