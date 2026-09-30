// Command registry for the ⌘⇧P palette; owners register/unregister their actions.

export type CommandGroup = "nav" | "create" | "doc";

export interface Command {
  id: string;
  label: string;
  group: CommandGroup;
  icon?: string;
  /** shortcuts.ts id, shown as a key-cap badge. */
  shortcut?: string;
  /** Position within the group (lower first; default 50). */
  order?: number;
  run: () => void;
}

export const COMMAND_GROUPS: { key: CommandGroup; label: string }[] = [
  { key: "doc", label: "当前文档" },
  { key: "nav", label: "导航" },
  { key: "create", label: "新建" },
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
