# metahub

**Give your AI a local knowledge base.**

English · [简体中文](./README.zh-CN.md)

metahub is a local-first knowledge base CLI built on Bun + SQLite. It gives an AI agent a durable, syncable working memory: Notion-style **typed tables** for structured data, **Markdown documents** for long-form knowledge, and a `Read / Edit / Write`-style editing interface. Everything lives on your own machine under `~/.metahub/` — offline on one machine, and consistent across many.

> Requires [Bun](https://bun.sh). Use `bunx`, a global `mh` install, or a standalone binary.

## Why metahub

- **Built for AI read/write** — `doc read` returns the body plus a version token; `doc edit --old/--new` does an anchored find-and-replace that sends only the delta. Refer to anything by id prefix or name — no pasting full ids.
- **Structured and unstructured in one place** — typed tables (rows, columns, 8 property types) for tasks, ledgers, contacts; Markdown documents for notes and specs.
- **Local-first and syncable** — your data sits on your own disk and works offline; multiple machines merge cleanly, and edits to different paragraphs don't clobber each other.
- **GUI and API included** — `mh --server` starts a browser WebUI (browse, inline-edit, full-text search), a `/api/*` REST interface, and auto-generated OpenAPI docs.

<!-- TODO screenshots: docs/assets/webui.png (WebUI), docs/assets/desktop.png (desktop app) -->
> Want to see the UI? Install the [desktop app](#install) or run `mh --server` and open `http://localhost:7777/`.

## Quick start

```bash
bunx @tensorix/metahub init                          # create ~/.metahub
mh db create "Tasks"                                 # create a table → returns an id like db_tasks-k3f9c1
mh use tasks                                         # set the "current db"; record/prop commands target it
mh prop add Title  --type text
mh prop add Status --type select --options "todo,doing,done"
mh record create --data '{"Title":"Write spec","Status":"todo"}'
mh doc create --title "Architecture" --body @arch.md  # @file / @- / inline string
mh search "architecture"                             # full-text over documents + records
```

Refer to entities by **full id, unique prefix, or name** — ambiguity is reported with candidates.

**Incremental editing for AI** (mirrors `Read / Edit / Write`):

```bash
mh doc read <ref>                                    # read body + version (read before editing)
mh doc edit <ref> --old "old text" --new "new text"  # anchored replace; delta only
mh doc append <ref> --body "a new paragraph"         # prepend also exists
```

Output adapts to the audience: a terminal (human) gets tables / Markdown, a pipe or subprocess (AI) gets **JSON**. Force it with `--json` / `--pretty`.

## Install

| Form | Install | For |
| --- | --- | --- |
| **Desktop app** (GUI) | `brew install --cask tensorix/tap/metahub-app` | A graphical, Notion-like experience |
| **CLI** | `brew install tensorix/tap/metahub-cli`, or `npm i -g @tensorix/metahub`, or `bunx @tensorix/metahub <cmd>` | AI agents and the command line |
| **Library** (Bun) | `bun add @tensorix/metahub` | Calling metahub from your own Bun program |
| **Standalone binary** | download for your platform, `chmod +x`, run | No runtime to install |

```ts
// As a library: every core capability is exported from the package root
import { openMetahub, createDatabase, createRecord, search } from "@tensorix/metahub";
```

Platforms: `darwin-arm64` / `darwin-x64` / `linux-x64` / `linux-arm64` / `windows-x64`. Library API: see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Sync across machines

Run a server on one machine and sync from another. Documents merge at the paragraph level, so concurrent edits to different parts of the same document combine cleanly.

```bash
# machine A: start the sync server (it is itself a metahub node)
mh --server --port 7777

# machine B: push/pull one round
mh sync http://a-host:7777
```

Pair two devices once and they sync both ways on a timer — no need to run `mh sync` each time. The same `sync` command also moves a single document or table to/from a local file (document ↔ Markdown, table ↔ CSV). See the [system-design docs](./docs/system-design/) for how it works.

## WebUI, API, and agent-hosted sites

`mh --server` serves a browser **WebUI** at `/` (browse and inline-edit tables, block-level WYSIWYG document editing, full-text search). The same server also exposes:

- `/api/*` — REST endpoints over your tables and documents.
- `/docs` — auto-generated OpenAPI documentation.
- `/sites/<name>/` — `mh site publish` hosts the HTML/CSS/JS an agent generates; pages call `/api/*` same-origin to read your data (a local mini-Supabase).

Requests are guarded by a single token (persisted in `~/.metahub`). The server binds `127.0.0.1` by default; only `--host 0.0.0.0` exposes it, and credentials travel as plaintext Bearer — put it behind a trusted network or TLS. Details in the [system-design docs](./docs/system-design/).

## Command reference

<details>
<summary>Full command table</summary>

| Command | Description |
| --- | --- |
| `mh init` | Create `~/.metahub` |
| `mh db create\|list\|get\|delete` | Manage databases (tables) |
| `mh use [<db>] [--clear]` | Set/show the "current db" (record/prop default to it) |
| `mh get <ref>` | Universal lookup: resolve by id/prefix/name, auto-detect type |
| `mh prop add\|list\|update\|remove` | Manage properties (columns); `add` takes `--db` (defaults to current db) |
| `mh record create\|list\|get\|update\|delete` | Manage records (rows) |
| `mh doc create\|list\|get\|update\|delete` | Manage Markdown documents |
| `mh doc read <id>` | Read body + version token (AI reads before editing) |
| `mh doc edit <id> --old --new` | Anchored find-and-replace (`--replace-all` / `--if-match`) |
| `mh doc append\|prepend <id> --body` | Append a block at the document head/tail |
| `mh edit <id>` | Edit a document/record interactively in `$EDITOR` (for humans) |
| `mh search <query>` | Full-text search (documents + records) |
| `mh doctor` | Read-only health check: list integrity issues (orphan refs/cells, duplicate paths, doc cycles, name clashes) |
| `mh repair [--dry-run]` | Deterministic, idempotent repair of auto-fixable issues (changes replicate via oplog); `--dry-run` previews (same as doctor) |
| `mh site create\|put\|publish\|list\|files\|rm\|delete` | Host static sites (HTML/CSS/JS) an agent generates, served by `--server` at `/sites/<name>/` |
| `mh token [show\|refresh]` | Show/rotate the persisted server auth token (stored in `~/.metahub`, rotates at 30-day expiry by default) |
| `mh completion <bash\|zsh\|fish>` | Print a completion script: `eval "$(mh completion zsh)"` |
| `mh sync <url>` | Sync one round with a server (CRDT push/pull); uses a stored credential when `/sync` is protected, otherwise prompts for a token in an interactive terminal and remembers it (`--token` for non-interactive) |
| `mh sync <src> <dst>` | Move a single document/table to/from a file: document ↔ Markdown, table ↔ CSV; direction inferred from which side is an in-repo entity |
| `mh config` | Configure the server and sync devices: no args opens an interactive wizard, `--flag` sets directly (`--host/--port/--sync-interval/--auto-sync`) |
| `mh config peer code\|add\|list\|sync\|enable\|disable\|rm` | Multi-device pairing and management: generate a one-time code / pair / list / sync now / enable-disable / remove (also revokes the credential issued to the peer) |
| `mh config grant list\|revoke` | List/revoke inbound sync credentials this machine issued (`revoke --token` accepts an exact value or prefix) |
| `mh --server [--port] [--host] [--debug] [--token] [--sync-interval] [--no-auto-sync]` | Start the server: `/sync` (master token or pairing credential) + WebUI at `/` + `/api/*` REST + `/docs` (OpenAPI) + static sites `/sites/<name>/` + token exchange `/auth/token` + pairing `/api/pair`; a built-in timer auto-syncs paired peers |

</details>

## Documentation

- [System design](./docs/system-design/) — architecture, data model, capabilities, usage flows.
- [Contributing](./CONTRIBUTING.md) — local development, build, release, project layout, library API.
- [Desktop app](./apps/desktop/README.md) — Electron shell + Bun sidecar.

## License

[AGPL-3.0-only](./LICENSE).
