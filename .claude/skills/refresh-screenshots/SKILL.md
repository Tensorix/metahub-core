---
name: refresh-screenshots
description: >-
  Refresh the README WebUI screenshots (docs/assets/webui.png and
  docs/assets/webui-table.png) from a fresh build using deterministic mock data.
  Use on every release, or whenever the WebUI's look changes, to keep the README
  hero images current. Seeds a throwaway hub, starts the real server, drives the
  WebUI with Playwright, and writes the PNGs — it never touches the real ~/.metahub.
argument-hint: "(no args — regenerates both README screenshots)"
allowed-tools: Bash, Read, Edit, mcp__playwright__browser_navigate, mcp__playwright__browser_resize, mcp__playwright__browser_type, mcp__playwright__browser_click, mcp__playwright__browser_snapshot, mcp__playwright__browser_take_screenshot
---

# Refresh README screenshots

Regenerates the two WebUI screenshots the README embeds, using deterministic mock
data so successive runs look consistent. Run it from the repo root.

**Outputs**
- `docs/assets/webui.png` — document-editing view (the hero, under the intro paragraph)
- `docs/assets/webui-table.png` — typed-table view (in the "WebUI, API…" section)

Skill assets (edit these to change what the screenshots show):
- `seed.sh` — creates the mock hub (Roadmap + Reading list tables, 3 docs)
- `content/{arch,sync,notes}.md` — document bodies (no leading `# H1`; the page title supplies it)

## Steps

### 1. Seed a throwaway hub + get the login URL

Pick a scratch dir for `METAHUB_HOME` (NEVER `~/.metahub` — the script refuses).
`MH_PORT` must match the port you serve on in step 2 (default 7799).

```bash
export METAHUB_HOME="$(mktemp -d)/mockhub" MH_PORT=7799
bash .claude/skills/refresh-screenshots/seed.sh
```

The **last line printed is the login URL** — `http://localhost:7799/?token=<TOKEN>`.
Grab the `<TOKEN>` from it; you need it in step 3.

### 2. Start the real server (background)

```bash
bun run src/cli/index.ts --server --port 7799 --no-auto-sync
```

Run it in the background. `METAHUB_HOME` must still be exported. Wait until the log
prints `{"server":"listening",...}` (curl `/` returns 401 = up, just needs the token).

### 3. Drive the WebUI with Playwright

Gotchas learned the hard way:
- The WebUI chrome is **Chinese** (hardcoded, no i18n toggle) — expected, screenshot as-is.
- `/?token=…` in the URL is **not** auto-accepted (a console error swallows it). You must
  paste the token into the unlock form manually.
- Take shots at **1440×900, `scale: "device"`**.

1. `browser_resize` → 1440 × 900.
2. `browser_navigate` → `http://localhost:7799/?token=<TOKEN>`.
3. A "输入访问令牌" (enter access token) screen appears. `browser_snapshot`, then
   `browser_type` the `<TOKEN>` into the "粘贴访问令牌或登录链接" textbox and
   `browser_click` the **"解锁并进入"** button. You're now in.
4. **Doc shot (hero):** click the **Architecture overview** doc in the sidebar, then
   `browser_take_screenshot` → `filename: webui.png`, `type: png`, `scale: device`.
5. **Table shot:** click the **数据表** tab, click the **Roadmap** database, then
   `browser_take_screenshot` → `filename: webui-table.png`, `type: png`, `scale: device`.

`browser_take_screenshot` writes to the repo root (`./webui.png`, `./webui-table.png`).

### 4. Place the files and sanity-check the README

```bash
mkdir -p docs/assets
mv webui.png docs/assets/webui.png
mv webui-table.png docs/assets/webui-table.png
```

Read each PNG back to confirm it looks right (correct view, no half-loaded state,
no leftover token screen). The README already references both paths:
- `./docs/assets/webui.png` under the intro paragraph
- `./docs/assets/webui-table.png` in the "WebUI, API, and agent-hosted sites" section

If either `<img>` is missing (e.g. someone reset the README), re-add it.

### 5. Clean up

```bash
lsof -ti:7799 | xargs kill 2>/dev/null   # stop the server
rm -rf .playwright-mcp                    # Playwright scratch, must not be committed
rm -rf "$METAHUB_HOME"                     # throwaway hub
```

Only `README.md` and the two files under `docs/assets/` should change. Hand the diff
to the user with a one-line commit message; do not commit automatically.
