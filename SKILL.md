---
name: metahub-cli
description: >-
  Use the metahub CLI (`mh` / `metahub`) as an AI agent's durable local knowledge
  base — typed tables (Notion-style rows/columns) for structured data and Markdown
  documents for long-form knowledge, with a Read/Edit/Write-style editing interface.
  Use this skill whenever you need to store, recall, search, or incrementally edit
  the agent's working memory, or run the metahub sync server / WebUI / hosted sites.
---

# metahub CLI

metahub gives an AI agent a durable, syncable working memory stored locally under
`~/.metahub/` (Bun + SQLite). Two kinds of data live side by side:

- **Databases (tables)** — typed rows/columns, like Notion. For tasks, ledgers,
  contacts, anything structured.
- **Documents** — Markdown, for notes, specs, long-form knowledge. Edited
  incrementally via a `Read / Edit / Write`-style interface.

The binary is installed as both `mh` and `metahub`. This skill uses `mh`.

## When to use this skill

- The agent needs to **remember** something across turns/sessions → write a
  document or a record.
- The agent needs to **recall** prior knowledge → `mh search` / `mh get`.
- The agent needs to **revise** stored knowledge surgically → `mh doc read` then
  `mh doc edit --old/--new` (never blind-overwrite).
- You need a **GUI / REST API / OpenAPI docs / agent-hosted site** over the data →
  `mh --server`.

## The two rules that matter most for an agent

### 1. You almost always get JSON — parse it

Output adapts to the audience. When stdout is **not** a TTY (i.e. you, an agent,
running in a subprocess/pipe), every command prints **single-line JSON**. A human
at a terminal gets tables/Markdown instead. So as an agent you can rely on JSON
without any flag — but be explicit when in doubt:

- `--json` — force JSON (machine output).
- `--pretty` — force human output (tables / rendered Markdown).

Errors print `{"error": "..."}` to stdout and exit **non-zero**. Always check the
exit code; a non-zero exit with an `error` field is a real failure, not a no-op.

### 2. Refer to anything by id, unique prefix, or name

Every entity (database, property, record, document) has an id like
`db_tasks-k3f9c1`, `doc_-a1b2c3`, `rec_-...`. You never need to paste a full id —
pass a **full id, a unique id prefix, or the entity's name/title**. If a ref is
ambiguous, the CLI fails and lists the candidates; narrow it and retry. Records
resolve by id/prefix only (they have no name).

## Setup

```bash
mh init          # create ~/.metahub (idempotent; safe to run again)
mh doctor        # read-only health check (run if anything looks off)
```

## Databases & properties (structured data)

```bash
# Create a table → returns {"id":"db_tasks-...","name":"Tasks",...}
mh db create "Tasks"
mh db list
mh db get tasks                       # by name/prefix
mh db delete tasks

# "Current db": record/prop/doc default to it, so you can omit the db arg
mh use tasks                          # set current db
mh use                                # show current db
mh use --clear                        # unset

# Properties = columns. Types: text | number | checkbox | select |
# multi_select | date | relation | url. --db defaults to the current db.
mh prop add Title  --type text
mh prop add Status --type select --options "todo,doing,done"
mh prop add Owner  --type relation --target contacts   # relation → another db
mh prop list
mh prop update Status --options "todo,doing,done,blocked"
mh prop remove Owner
```

## Records (rows)

`--data` takes a JSON object of `{column: value}`. Updates are **partial** (only
the keys you pass change).

```bash
mh record create --data '{"Title":"Write spec","Status":"todo"}'   # → prints the new id
mh record list                                   # current db; JSON has {database,count,records}
mh record list tasks --filter '{"Status":"todo"}' --sort created --desc --limit 20
mh record get <ref>
mh record update <ref> --data '{"Status":"doing"}'
mh record delete <ref>
```

## Documents (long-form knowledge) — the agent editing workflow

This mirrors `Read / Edit / Write`. **Read before you edit.**

```bash
# Create. --body accepts an inline string, @file, or @- (stdin). --parent nests docs.
mh doc create --title "Architecture" --body @arch.md
mh doc create --title "Notes" --body "first paragraph"

mh doc list                          # parent/child tree (pass --db to filter)
mh doc get <ref>                     # full row

# READ before editing: returns body + a version token + line/byte counts
mh doc read <ref>

# EDIT: anchored find-and-replace, sends only the delta.
#   --old must match EXACTLY ONCE (else it errors) unless --replace-all.
#   --if-match <version> rejects the edit if the doc changed since you read it.
mh doc edit <ref> --old "old text" --new "new text"
mh doc edit <ref> --old "TODO" --new "DONE" --replace-all
mh doc edit <ref> --old "..." --new "..." --if-match <version-from-read>

# WRITE more: add blocks at the tail or head
mh doc append  <ref> --body "a new paragraph"
mh doc prepend <ref> --body "## Summary"

# Whole-document replace / retitle / reparent (use sparingly vs. edit)
mh doc update <ref> --title "New title" --body @new.md
mh doc update <ref> --parent ""        # "" moves to top level

mh doc delete <ref>
```

Recommended agent loop for revising a document:
1. `mh doc read <ref>` → capture `body` and `version`.
2. Compute a minimal `--old`/`--new` pair (unique anchor text).
3. `mh doc edit <ref> --old ... --new ... --if-match <version>`.
4. On a version conflict, re-read and retry.

## Search and universal lookup

```bash
mh search "architecture"             # full-text over documents AND records
mh search "spec" --limit 10          # JSON: {query, hits:[{type,id,snippet}]}
mh get <ref>                         # type-agnostic: resolves db/prop/record/doc and prints it
```

`mh get` is the quickest way to dereference an unknown id/name when you don't know
its kind. `mh search` is how you recall knowledge you don't have the id for.

## Input conventions (`@`) — applies to --body, --data, --old, --new, --config, --filter

- `@file.md` → read the value from that file.
- `@-` → read the value from stdin (pipe large/multiline content this way).
- anything else → used as a literal string.

This lets you pass large bodies or JSON without shell-escaping:

```bash
cat draft.md | mh doc create --title "Draft" --body @-
mh record create --data @row.json
```

## Output / effect evidence (don't trust silence)

Success is reported as **concrete evidence of the effect**, not a generic
`{"ok":true}` wrapper: creates return the new `id`; `doc edit/append/prepend`
return `{id, replaced}` (how many blocks/occurrences changed); reads return a
`version`. A command that changed nothing says so loudly (e.g. `--old` not found →
non-zero exit + `error`). Verify by reading the evidence field, not by assuming.

## Health & repair

```bash
mh doctor                # read-only: lists integrity issues (orphan refs, dup paths, doc cycles, name clashes)
mh repair --dry-run      # preview the deterministic auto-fixes (same as doctor)
mh repair                # apply them (idempotent; changes replicate over the oplog)
```

## Server, WebUI, REST API, hosted sites

```bash
mh --server                          # http://localhost:7777/ : WebUI + /api/* REST + /docs (OpenAPI)
mh --server --port 8080 --host 127.0.0.1
mh --server --debug                  # disable auth (local dev only)
```

The server binds `127.0.0.1` by default; `--host 0.0.0.0` exposes it, and the
token travels as plaintext Bearer — only do that on a trusted network/TLS.

- `mh token [show|refresh]` — show/rotate the persisted server auth token.
- `mh site create|put|publish|list|files|rm|delete` — host static HTML/CSS/JS an
  agent generates; served at `/sites/<name>/`, and those pages call `/api/*`
  same-origin to read your data (a local mini-backend for agent-built UIs).

## Sync across machines / files

```bash
# Peer sync: one round of CRDT push/pull. Documents merge at paragraph level.
mh sync http://other-host:7777                 # prompts for a token if the server is protected
mh sync http://other-host:7777 --token <tok>   # non-interactive

# File sync: export/import a single entity. Direction is inferred from which side
# is an in-repo entity. document ↔ Markdown, table ↔ CSV.
mh sync <doc-ref> ./out.md                      # export a doc to Markdown
mh sync ./data.csv <db-ref>                     # import a CSV into a table

# Persistent multi-device pairing (sync both ways on a timer, no repeated `mh sync`):
mh config peer code                             # device A: print a one-time pairing code
mh config peer add <code>                       # device B: pair using it
mh config                                       # interactive wizard for host/port/sync-interval/auto-sync
```

## Gotchas for agents

- **Read before edit.** `doc edit --old` fails if the anchor isn't found or isn't
  unique — read first, pick a unique anchor, and prefer `--if-match` to avoid
  clobbering concurrent changes.
- **Don't assume a no-op succeeded.** Check the exit code and the effect field
  (`id`, `replaced`, `deleted`, `version`).
- **`use` is stateful.** `record`/`prop`/`doc create` target the current db when
  you omit the db arg. Pass the db explicitly in scripts to avoid surprises.
- **Ambiguous refs fail loudly** with candidates — narrow the prefix/name.
- **JSON by default** when piped; add `--pretty` only when a human will read it.
