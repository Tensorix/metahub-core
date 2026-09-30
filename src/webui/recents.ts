// Recently opened docs/databases for the palette's empty state (device-local).
import type { View } from "./view.ts";

export interface RecentRef {
  kind: "doc" | "db";
  id: string;
}

const KEY = "mh.recent";
const CAP = 8;

interface Store {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

function store(): Store | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function listRecents(s: Store | null = store()): RecentRef[] {
  if (!s) return [];
  try {
    const raw = JSON.parse(s.getItem(KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((r): r is RecentRef => !!r && (r.kind === "doc" || r.kind === "db") && typeof r.id === "string")
      .slice(0, CAP);
  } catch {
    return [];
  }
}

export function recordRecent(v: View, s: Store | null = store()): void {
  if (!s) return;
  if (v.kind !== "doc" && v.kind !== "db") return;
  const next: RecentRef = { kind: v.kind, id: v.id };
  const rest = listRecents(s).filter((r) => r.id !== next.id);
  try {
    s.setItem(KEY, JSON.stringify([next, ...rest].slice(0, CAP)));
  } catch {
    /* private mode */
  }
}
