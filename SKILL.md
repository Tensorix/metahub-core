---
name: mh
description: >-
  Store, recall, search, and edit the agent's durable working memory via the metahub
  CLI (`mh`) — Notion-style typed tables for structured data and Markdown documents
  for long-form knowledge, with a Read/Edit/Write editing flow. Also runs the metahub
  sync server, WebUI, and hosted sites.
argument-hint: "[task — e.g. log today's progress to the Notes doc]"
allowed-tools: Bash(mh:*), Bash(metahub:*)
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

Errors print `{"error": "...", "code": "..."}` to stdout and exit **non-zero**.
Dispatch on the `code` field or the exit code — never on the message text (it
may be reworded). Always check the exit code; a non-zero exit with an `error`
field is a real failure, not a no-op.

| `code` | exit | meaning | what to do |
|---|---|---|---|
| `invalid_input` | 2 | bad arguments / refused as stated | fix the command, don't retry as-is |
| `not_found` | 3 | referenced entity doesn't exist | check the ref; don't retry |
| `ambiguous` | 4 | ref matched several entities (candidates listed) | narrow the ref and retry |
| `stale` / `conflict` | 5 | doc changed since your `--if-match` read / name taken | re-read, then retry |
| `auth` | 6 | missing or invalid token | supply `--token`, then retry |
| `network` | 7 | peer unreachable or replied non-OK | retryable with backoff |
| — | 1 | uncategorized failure | read the message |
| — | 98 | server port already in use | pick another `--port` |

The same `code` values appear in REST error bodies (`/api/*`), mapped to HTTP
status (404/409/401/...), so HTTP and CLI clients dispatch on one taxonomy.

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
mh init --claude # install this guide as a Claude Code /mh skill (~/.claude); --codex for Codex $mh (~/.codex)
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

Column names are not unique. If an add/rename makes a name collide, the command
still succeeds but prints a stderr warning with the conflicting property ids —
switch to ids for that column from then on.

## Records (rows)

`--data` takes a JSON object of `{column: value}`. Updates are **partial** (only
the keys you pass change). Keys may be column names or property ids; when two
columns share a name, name-keyed access fails with `code:"ambiguous"` (exit 4) —
use the property ids from `mh prop list`. Reads return `values` (name-keyed)
plus `cells` (keyed by property id; the lossless source under duplicate names).

```bash
mh record create --data '{"Title":"Write spec","Status":"todo"}'   # → prints the new id
mh record list                                   # current db; JSON has {database,count,records}
mh record list tasks --filter '{"Status":"todo"}' --sort created --desc --limit 20
#   --sort <field> orders ascending; add --desc for descending. (Internally the
#   pair is encoded as "-<field>"; you never need to write that form yourself.)
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

# EDIT (batch): apply several pairs in ONE atomic call — prefer this for many
#   scattered deltas. One --if-match check, one revision, no re-read between edits.
#   Pairs fold in order (a later "old" can match an earlier "new"); if ANY pair's
#   anchor is missing/ambiguous the whole batch aborts and the doc is untouched.
mh doc edit <ref> --if-match <version> --edits @- <<'JSON'
[{"old":"(draft)","new":""},
 {"old":"status: todo","new":"status: done"},
 {"old":"FIXME","new":"FIXED","replaceAll":true}]
JSON
# Keep anchors in prose. Don't let --old/--new (or a batch pair) cut into the
# interior of a table, code fence, or media block, or the block won't round-trip.

# WRITE more: add blocks at the tail or head
mh doc append  <ref> --body "a new paragraph"
mh doc prepend <ref> --body "## Summary"

# Whole-document replace / retitle / reparent (use sparingly vs. edit)
mh doc update <ref> --title "New title" --body @new.md
mh doc update <ref> --parent ""        # "" moves to top level

mh doc delete <ref>
```

Required agent loop for revising a document (treat `--if-match` as mandatory —
without it a concurrent edit from another session/the WebUI is silently
clobbered):
1. `mh doc read <ref>` → capture `body` and `version`.
2. Compute the minimal `--old`/`--new` pair(s) (unique anchor text). Revising
   several spots at once? Collect them into one `--edits` batch instead of
   editing serially — the version bumps on the whole doc after any edit, so
   serial `--if-match` edits force a re-read between each.
3. `mh doc edit <ref> --old ... --new ... --if-match <version>` (or `--edits`).
4. On exit 5 (`stale`), re-read and retry from step 1.

## Media & attachments (images / video / audio / files)

Binary media lives as content-addressed **blobs**; a document body only carries a
`/blob/<hash>` reference (the bytes move on demand and sync separately). Ingest a
local file, then embed the URL it prints into a doc body.

```bash
mh blob add ./diagram.png          # store bytes → prints {hash,size,content_type,url,kind,markdown}
mh blob add ./clip.mp4 --name Demo # video/audio are stored the same way
mh blob get <hash> --out copy.png  # resolve bytes back to a file (local cache → peers → bucket)
mh blob get <hash> > copy.png      # …or raw bytes to stdout (pipe-friendly)
```

Embed the printed `markdown` (or build it yourself) as its **own line/block** in a
document body — the WebUI renders it as a media block:
- image/video/audio → `![name](/blob/<hash>.<ext>)` (kind is inferred from the extension)
- any other file → `[name](/blob/<hash>.<ext> "<bytes>")` (a download card)

A blob is kept from garbage collection only once a live document references its
`/blob/<hash>` — embed it promptly (an unreferenced blob is an orphan that
`mh compact` / `mh cache gc` may remove).

## History & rollback (docs, records, columns)

Every field write is kept in an append-only oplog, so full edit history is
queryable and any past state can be restored. **Revert is a forward write** —
it lands as a new revision (nothing is rewritten), replicates over sync, and is
itself revertible. `history` rows carry a `version` token: pass it to `--to`
(revert) or `--at` (point-in-time read).

```bash
mh doc history <ref>                       # revisions, newest first: {version, at, node_id, kind, ...}
mh doc get <ref> --at <version>            # title/body as of that version
mh doc revert <ref> --to <version>         # restore title+body (add --if-match <v> like doc edit)
mh record history <ref>                    # field-level revisions; --field <name> shows one cell's trail
mh record revert <ref> --to <version>      # restore cells; resurrects a deleted record
mh prop history <ref>                      # column definition changes (type/options/rename/remove)
mh prop revert <ref> --to <version>        # schema rollback: restores the column AND the cells its
                                           #   type-change/removal cleared; user edits made since are kept
mh db activity [<ref>] [--limit N]         # table activity feed: every record's revisions merged newest
                                           #   first, each with old→new cell values + record-title snapshot
                                           #   (deleted records show their last title)
```

Notes for agents:
- `kind` distinguishes `user` edits from `repair`/`revert` revisions.
- Deleted docs/records/columns are reachable by **full id** (history/revert
  still work; revert resurrects them).
- Reverting to a deleted state is refused (`invalid_input`) — use `delete`.
- Errors follow the standard codes: unknown version → `not_found` (exit 3),
  `--if-match` mismatch → `stale` (exit 5).

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
mh compact --dry-run     # how much oplog history a 90-day retention window would prune
mh compact --keep 90     # prune it + GC unreferenced blobs + VACUUM. Local-only (never syncs).
                         #   History older than the window collapses to a baseline: revert
                         #   beyond it is no longer possible. --keep 0 keeps head state only.
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
- `mh site ...` — host static HTML/CSS/JS an agent generates, served at
  `/sites/<name>/` (a local mini-backend for agent-built UIs):

  ```bash
  mh site scaffold ./app                  # starter page (SDK import + working example)
  mh site publish myapp ./app --create    # first publish creates the site
  mh site publish myapp ./app --prune     # re-publish; --prune deletes remote files gone locally
  ```

  Pages read/write hub data same-origin: plain `fetch('/api/records?db=tasks')`
  just works (the injected runtime attaches the auth token), or use the typed
  SDK — `import { api } from "/metahub-sdk.js"` (listRecords / createRecord /
  updateRecord / listDocuments / getDocument / updateDocument / search, …).
  The full REST surface self-describes at `GET /docs.json` (OpenAPI).
- `mh share create <ref> [--permission view|edit] [--password ..] [--expires 7d]` —
  publish a doc/database/site as a public link (`/share/<slug>`, view = read-only
  SSR, edit = server-only, accepts guest writes). `mh share list|link|revoke|renew`.
- `mh edge status|pull` (tools) + `mh config edge deploy|connect|rotate-keys` (setup) —
  optional write-inbox on your own Cloudflare Worker + D1: public sites with a
  `create` grant collect anonymous form submissions asynchronously (sealed to your
  key at the edge — the host only ever sees ciphertext; ingested on the next sync
  round, ~1 min).

## Sync across machines / files

Daily tools stay top-level; anything that changes long-lived state lives under
`mh config <server|device|backup|edge>` (older `config peer/grant/set` spellings
still work as hidden aliases).

```bash
# Sync now: one round against every configured device + bucket.
mh sync
mh status                                      # where the data lives, how fresh each copy is

# One-shot against a specific server (also saves its token for next time):
mh sync http://other-host:7777 --token <tok>

# File sync: export/import a single entity. Direction is inferred from which side
# is an in-repo entity. document ↔ Markdown, table ↔ CSV.
mh sync <doc-ref> ./out.md                      # export a doc to Markdown
mh sync ./data.csv <db-ref>                     # import a CSV into a table

# Configuration (persistent): pair devices / attach a cloud backup bucket.
mh config device code                           # device A: print a one-time pairing code
mh config device add --url http://A-host:7777 --code <code>   # device B: pair with A
mh config backup connect --endpoint <s3-url> --bucket <name> --access-key … --secret-key …
mh config backup connect --enroll <code>        # join a bucket via an enroll code / QR
mh config backup rotate                         # lost device: new keys / passphrase
mh config                                       # interactive wizard (server/device/backup/edge)
```

## Running non-interactively (agents, CI, pipes)

When stdin/stdout are not a TTY, the CLI never blocks waiting for input: a
missing required value fails fast with `{"error":"missing --<flag>", "code":
"invalid_input"}`. But **on a TTY (including PTY-based harnesses) two commands
will prompt interactively** — always pass their flags explicitly:

- `mh config ...` — run with full flags (e.g. `mh config device add --url ... --code ...`);
  bare `mh config` on a TTY opens an arrow-key wizard.
- `mh sync <url>` — pass `--token <tok>`; without it a 401 on a TTY prompts for
  the token.

## Gotchas for agents

- **Read before edit, and always send `--if-match`.** `doc edit --old` fails if
  the anchor isn't found (`invalid_input`) or isn't unique (`ambiguous`); without
  `--if-match` a concurrent change is silently clobbered.
- **Don't assume a no-op succeeded.** Check the exit code and the effect field
  (`id`, `replaced`, `deleted`, `version`).
- **`use` is stateful.** `record`/`prop`/`doc create` target the current db when
  you omit the db arg. Pass the db explicitly in scripts to avoid surprises.
- **Ambiguous refs fail loudly** with candidates (exit 4) — narrow the prefix/name.
- **JSON by default** when piped; add `--pretty` only when a human will read it.
