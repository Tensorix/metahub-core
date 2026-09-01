// The app's top-level navigation state: which pane fills the content area.
// Owned by app.tsx (single navigate() writer, mirrored to the location hash);
// lives in its own module so the sidebar can consume `view`/`navigate` without
// importing app.tsx back (which would be circular).

// Database view tabs, in the same order as table.tsx's VIEW_TABS (index = tab
// number). Appears in the hash as `#/db/<id>?view=board` — a one-shot request
// consumed by DatabaseView, not a mirror of the current tab.
export const DB_TABS = ["table", "board", "calendar", "timeline"] as const;
export type DbTab = (typeof DB_TABS)[number];

export type View =
  | { kind: "empty" }
  | { kind: "db"; id: string; rec?: string; tab?: DbTab } // rec = record peek deep link
  | { kind: "doc"; id: string }
  | { kind: "search"; q: string }
  | { kind: "settings"; sec?: string }
  | { kind: "sites" }
  | { kind: "site"; name: string; tab?: "config" } // a site's visit page / config page
  | { kind: "shares" };

export type Navigate = (v: View, opts?: { replace?: boolean }) => void;

// --- hash routing ------------------------------------------------------------
// Views are mirrored to "#/" routes so browser history (and a phone's hardware
// back) navigates the app, deep links survive a refresh, and doc/db URLs are
// shareable. The desktop Quick Notes window owns the bare "#quick" hash; it
// never matches a "#/" route and parses to the empty view in a plain browser.

export function viewToHash(v: View): string {
  switch (v.kind) {
    case "db": {
      const path = v.rec
        ? `#/db/${encodeURIComponent(v.id)}/${encodeURIComponent(v.rec)}`
        : `#/db/${encodeURIComponent(v.id)}`;
      return v.tab ? `${path}?view=${v.tab}` : path;
    }
    case "doc": return `#/doc/${encodeURIComponent(v.id)}`;
    case "search": return `#/search?q=${encodeURIComponent(v.q)}`;
    case "settings": return v.sec ? `#/settings?sec=${encodeURIComponent(v.sec)}` : "#/settings";
    case "sites": return "#/sites";
    case "site": {
      const path = `#/site/${encodeURIComponent(v.name)}`;
      // ?view=config is a durable mirrored mode (settings?sec= style), NOT a
      // one-shot request like the db ?view= — both modes are shareable URLs.
      return v.tab === "config" ? `${path}?view=config` : path;
    }
    case "shares": return "#/shares";
    case "empty": return "#/";
  }
}

/** A pasted doc/db URL → the `[[id]]` internal reference, or null.
 *  Matches on the hash route only and IGNORES the origin — a link copied on
 *  another device (different host/port, same hub) still converts. The id must
 *  be doclink-shaped (same alphabet the inline grammar accepts) and live under
 *  the segment matching its own prefix. */
export function doclinkFromUrl(text: string): string | null {
  const m = text.trim().match(/^(?:https?:\/\/\S*?)?#\/(doc|db)\/((?:doc|db)_[a-z0-9][a-z0-9-]*)\/?$/);
  if (!m) return null;
  const [, seg, id] = m;
  if (id!.startsWith(`${seg}_`)) return `[[${id}]]`;
  return null;
}

/** Inverse of viewToHash; anything unrecognized (or with malformed escapes) is
 *  the empty view, so a hand-mangled URL degrades to the home screen. */
export function parseHash(h: string): View {
  if (!h.startsWith("#/")) return { kind: "empty" };
  const [path = "", query = ""] = h.slice(2).split("?", 2);
  const [kind, id = "", rec = ""] = path.split("/", 3);
  try {
    if (kind === "db" && id) {
      const v: Extract<View, { kind: "db" }> = rec
        ? { kind: "db", id: decodeURIComponent(id), rec: decodeURIComponent(rec) }
        : { kind: "db", id: decodeURIComponent(id) };
      const tab = new URLSearchParams(query).get("view");
      if (tab && (DB_TABS as readonly string[]).includes(tab)) v.tab = tab as DbTab;
      return v;
    }
    if (kind === "doc" && id) return { kind: "doc", id: decodeURIComponent(id) };
    if (kind === "search") {
      const q = new URLSearchParams(query).get("q");
      if (q) return { kind: "search", q };
    }
    if (kind === "settings") {
      const sec = new URLSearchParams(query).get("sec");
      return sec ? { kind: "settings", sec } : { kind: "settings" };
    }
    if (kind === "sites") return { kind: "sites" };
    if (kind === "site" && id) {
      const name = decodeURIComponent(id);
      const tab = new URLSearchParams(query).get("view");
      return tab === "config" ? { kind: "site", name, tab: "config" } : { kind: "site", name };
    }
    if (kind === "shares") return { kind: "shares" };
  } catch {
    // malformed percent-escape — treat as unrecognized
  }
  return { kind: "empty" };
}
