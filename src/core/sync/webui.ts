import { fileURLToPath } from "node:url";

// Serves the browser WebUI at `/`. This module is imported lazily from
// server.ts (only when a browser actually hits `/` or `/webui.js`), so neither
// it nor the Preact bundle ever enters the CLI's startup import graph — zero
// cost to `mh <command>`.

/** The HTML shell. The Preact app is delivered separately as /webui.js. CSS is
 *  inlined here to avoid a third asset route and keep it out of the JS bundle. */
const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Metahub</title>
<style>
  :root {
    --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --line: #d0d7de;
    --accent: #0969da; --accent-bg: #ddf4ff; --sidebar: #f6f8fa; --danger: #cf222e;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117; --fg: #e6edf3; --muted: #8b949e; --line: #30363d;
      --accent: #4493f8; --accent-bg: #11243e; --sidebar: #161b22; --danger: #f85149;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: var(--fg); background: var(--bg);
  }
  #app { display: flex; height: 100vh; }
  .sidebar {
    width: 260px; flex: none; background: var(--sidebar); border-right: 1px solid var(--line);
    overflow-y: auto; padding: 12px;
  }
  .sidebar h1 { font-size: 15px; margin: 4px 6px 12px; }
  .sidebar .group { margin-bottom: 18px; }
  .sidebar .group-head {
    display: flex; align-items: center; justify-content: space-between;
    font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
    color: var(--muted); margin: 0 6px 6px;
  }
  .nav-item {
    display: block; width: 100%; text-align: left; padding: 5px 8px; border: 0;
    border-radius: 6px; background: none; color: var(--fg); cursor: pointer;
    font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .nav-item:hover { background: rgba(127,127,127,.12); }
  .nav-item.active { background: var(--accent-bg); color: var(--accent); }
  .main { flex: 1; overflow: auto; padding: 20px 24px; }
  .topbar { display: flex; gap: 10px; align-items: center; margin-bottom: 16px; }
  .topbar input.search { flex: 1; max-width: 420px; }
  input, select, textarea, button {
    font: inherit; color: inherit; background: var(--bg);
    border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px;
  }
  button { cursor: pointer; }
  button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  button.icon { padding: 2px 7px; }
  button.link { border: 0; background: none; color: var(--accent); padding: 2px; }
  .muted { color: var(--muted); }
  table { border-collapse: collapse; width: 100%; }
  th, td {
    border: 1px solid var(--line); padding: 0; text-align: left; vertical-align: top;
    max-width: 360px;
  }
  th { background: var(--sidebar); padding: 6px 8px; font-weight: 600; white-space: nowrap; }
  td .cell { padding: 6px 8px; min-height: 30px; cursor: text; white-space: pre-wrap; word-break: break-word; }
  td input, td select, td textarea { width: 100%; border: 0; border-radius: 0; padding: 6px 8px; }
  td.actions { width: 1%; }
  .chip {
    display: inline-block; background: rgba(127,127,127,.16); border-radius: 10px;
    padding: 0 7px; margin: 1px 2px; font-size: 12px;
  }
  .doc-editor { display: flex; gap: 20px; align-items: flex-start; }
  .doc-editor > div { flex: 1; min-width: 0; }
  .doc-editor textarea { width: 100%; min-height: 60vh; font-family: ui-monospace, monospace; }
  .doc-editor input.title { width: 100%; font-size: 18px; margin-bottom: 10px; }
  .preview { border: 1px solid var(--line); border-radius: 6px; padding: 12px 16px; min-height: 60vh; overflow: auto; }
  .preview h1,.preview h2,.preview h3 { margin: .6em 0 .3em; }
  .preview pre { background: var(--sidebar); padding: 10px; border-radius: 6px; overflow: auto; }
  .preview code { background: var(--sidebar); padding: 1px 5px; border-radius: 4px; }
  .row-actions { display: flex; gap: 8px; margin: 12px 0; flex-wrap: wrap; }
  .hit { padding: 8px; border: 1px solid var(--line); border-radius: 6px; margin-bottom: 6px; cursor: pointer; }
  .hit:hover { border-color: var(--accent); }
  .error { color: var(--danger); margin: 8px 0; }
  h2.title { margin: 0 0 14px; }
</style>
</head>
<body>
<div id="app"></div>
<script type="module" src="/webui.js"></script>
</body>
</html>`;

let cachedJs: string | null = null;

/** Resolve the app bundle: prefer a prebuilt dist/webui.js next to the running
 *  file; in dev (running from source) build it on first request and cache. */
async function getJs(): Promise<string> {
  if (cachedJs != null) return cachedJs;

  const prebuilt = Bun.file(fileURLToPath(new URL("./webui.js", import.meta.url)));
  if (await prebuilt.exists()) {
    cachedJs = await prebuilt.text();
    return cachedJs;
  }

  const entry = fileURLToPath(new URL("../../webui/app.tsx", import.meta.url));
  const res = await Bun.build({ entrypoints: [entry], target: "browser", minify: true });
  if (!res.success) throw new AggregateError(res.logs, "webui build failed");
  cachedJs = await res.outputs[0]!.text();
  return cachedJs;
}

/** Handle WebUI asset requests. Returns null for anything else so the caller
 *  can fall through to the API routes. */
export async function serveWebui(req: Request): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const { pathname } = new URL(req.url);

  if (pathname === "/") {
    return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (pathname === "/webui.js") {
    try {
      return new Response(await getJs(), {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    } catch (e) {
      return new Response(`webui build failed: ${e}`, { status: 500 });
    }
  }
  return null;
}
