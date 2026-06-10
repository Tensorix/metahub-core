// Pretty startup panel for `mh --server`. Pure presentation — lives in the CLI
// layer, never in core. The pretty callback in index.ts calls this; the JSON /
// non-TTY path is handled upstream by print()/wantJson(), so this only ever
// renders for a human terminal (or `--pretty`).

import type { Scope } from "./netaddr.ts";

export type AuthMode = "managed" | "static" | "disabled";

/** One reachable base URL, tagged with its network scope. */
export interface Endpoint {
  scope: Scope;
  url: string;
}

export interface BannerInfo {
  version: string;
  host: string;
  port: number;
  /** Base URLs the server answers on. One entry → rendered as a plain "WebUI". */
  endpoints: Endpoint[];
  docsUrl: string;
  authMode: AuthMode;
  token: string | null;
  /** Expiry epoch ms; Infinity for a static token, null when auth is off. */
  exp: number | null;
  node: string;
  autoSync: boolean;
  syncIntervalMs: number;
  /** Force colour on/off. Defaults to TTY + NO_COLOR detection. */
  color?: boolean;
}

const ANSI = /\x1b\[[0-9;]*m/g;

function supportsColor(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

/** Visible width of a string, ignoring ANSI colour escapes. */
function visibleWidth(s: string): number {
  return s.replace(ANSI, "").length;
}

// ── colour palette (no-op when colour is disabled) ────────────────────────
const CODES = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
} as const;

type Paint = (s: string) => string;

function makePalette(on: boolean): Record<keyof typeof CODES, Paint> {
  const wrap = (code: string): Paint => (s) => (on ? `${code}${s}${CODES.reset}` : s);
  return {
    reset: (s) => s,
    dim: wrap(CODES.dim),
    bold: wrap(CODES.bold),
    green: wrap(CODES.green),
    cyan: wrap(CODES.cyan),
    yellow: wrap(CODES.yellow),
    magenta: wrap(CODES.magenta),
    red: wrap(CODES.red),
  };
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "expires in 26 days · Jun 30" / "never expires" / "expired". */
export function humanizeExpiry(exp: number | null, now = Date.now()): string {
  if (exp == null) return "";
  if (!Number.isFinite(exp)) return "never expires";
  const ms = exp - now;
  if (ms <= 0) return "expired";
  const d = new Date(exp);
  const date = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  const mins = Math.round(ms / 60_000);
  let rel: string;
  if (mins < 60) rel = `${mins}m`;
  else if (mins < 60 * 24) rel = `${Math.round(mins / 60)}h`;
  else rel = `${Math.round(mins / (60 * 24))} days`;
  return `expires in ${rel} · ${date}`;
}

/** "every 30s" / "every 5m" / "auto-sync off". */
export function formatSync(autoSync: boolean, ms: number): string {
  if (!autoSync || ms <= 0) return "auto-sync off";
  const secs = Math.round(ms / 1000);
  const human =
    secs % 3600 === 0 ? `${secs / 3600}h` : secs % 60 === 0 ? `${secs / 60}m` : `${secs}s`;
  return `every ${human}`;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost" || host === "::";
}

/** Render the rounded startup panel. Returns a multi-line string (no trailing newline). */
export function renderStartupBanner(info: BannerInfo): string {
  const on = info.color ?? supportsColor();
  const c = makePalette(on);

  const LABEL_W = 7; // "WebUI", "Docs", "Token", "Node", "Auth"
  const label = (t: string) => c.dim(t.padEnd(LABEL_W));

  // Each entry: [plain-for-width, painted-for-display]. We size the box from the
  // plain text, then substitute the painted version (same visible width).
  const rows: Array<[string, string]> = [];
  const push = (plain: string, painted: string) => rows.push([plain, painted]);

  // status
  push(
    `● listening   ${info.host}:${info.port}`,
    `${c.green("●")} ${c.dim("listening")}   ${c.bold(`${info.host}:${info.port}`)}`,
  );
  if (!isLoopback(info.host)) {
    push("⚠ reachable on your network", c.yellow("⚠ reachable on your network"));
  }
  push("", ""); // spacer

  // links — a single endpoint stays the familiar "WebUI <url>"; multiple are
  // labelled by scope (Local / LAN / Public) so the user knows which reaches them.
  const SCOPE_LABEL: Record<Scope, string> = { loopback: "Local", lan: "LAN", public: "Public" };
  if (info.endpoints.length <= 1) {
    const url = info.endpoints[0]?.url ?? info.docsUrl.replace(/\/docs$/, "");
    push(`${"WebUI".padEnd(LABEL_W)}${url}`, `${label("WebUI")}${c.cyan(url)}`);
  } else {
    for (const ep of info.endpoints) {
      const name = SCOPE_LABEL[ep.scope];
      const paint = ep.scope === "public" ? c.yellow(name.padEnd(LABEL_W)) : c.dim(name.padEnd(LABEL_W));
      push(`${name.padEnd(LABEL_W)}${ep.url}`, `${paint}${c.cyan(ep.url)}`);
    }
  }
  push(
    `${"Docs".padEnd(LABEL_W)}${info.docsUrl}`,
    `${label("Docs")}${c.cyan(info.docsUrl)}`,
  );

  // auth
  if (info.authMode === "disabled" || !info.token) {
    push(
      `${"Auth".padEnd(LABEL_W)}disabled (--debug)`,
      `${label("Auth")}${c.red("disabled")} ${c.dim("(--debug)")}`,
    );
  } else {
    push(
      `${"Token".padEnd(LABEL_W)}${info.token}`,
      `${label("Token")}${c.yellow(info.token)}`,
    );
    const exp = humanizeExpiry(info.exp);
    if (exp) push(`${" ".repeat(LABEL_W)}${exp}`, `${" ".repeat(LABEL_W)}${c.dim(exp)}`);
  }

  // node + sync
  const sync = formatSync(info.autoSync, info.syncIntervalMs); // "every 30s" | "auto-sync off"
  const syncLabel = info.autoSync && info.syncIntervalMs > 0 ? `sync ${sync}` : sync;
  push(
    `${"Node".padEnd(LABEL_W)}${info.node}   ·   ${syncLabel}`,
    `${label("Node")}${info.node}   ${c.dim("·")}   ${c.dim(syncLabel)}`,
  );

  // ── box geometry ─────────────────────────────────────────────────────────
  const PAD = 2; // inner left/right padding
  const title = "metahub";
  const ver = `v${info.version}`;
  const footer = "Ctrl-C to stop";

  const contentW = Math.max(
    ...rows.map(([plain]) => plain.length),
    // top border:  ╭─ metahub ─ … ─ vX ─╮  →  needs title + ver + decorations
    title.length + ver.length + 6,
    footer.length + 4,
  );
  const innerW = contentW + PAD * 2;
  const totalW = innerW + 2; // including the two side borders

  // Build a border line "<corner><leftSeg><dashes…><rightSeg><corner>" whose
  // total visible width is exactly totalW. A blank label collapses to a single
  // dash (no stray padding). `left`/`right` may carry ANSI.
  const border = (lc: string, left: string, right: string, rc: string): string => {
    const leftSeg = left ? `─ ${left} ` : "─";
    const rightSeg = right ? ` ${right} ─` : "─";
    const dashes = totalW - 2 - visibleWidth(leftSeg) - visibleWidth(rightSeg);
    return `${lc}${leftSeg}${"─".repeat(Math.max(0, dashes))}${rightSeg}${rc}`;
  };

  const top = border("╭", c.bold(c.magenta(title)), c.dim(ver), "╮");
  const bottom = border("╰", c.dim(footer), "", "╯");

  const body = rows.map(([plain, painted]) => {
    const fill = innerW - PAD * 2 - plain.length;
    return `│${" ".repeat(PAD)}${painted}${" ".repeat(Math.max(0, fill) + PAD)}│`;
  });

  return [top, ...body, bottom].join("\n");
}

// keep visibleWidth referenced (used by tests via re-export)
export { visibleWidth };
