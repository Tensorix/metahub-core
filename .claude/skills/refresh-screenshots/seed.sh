#!/usr/bin/env bash
# Seed a throwaway metahub with deterministic mock data for README screenshots.
#
#   METAHUB_HOME=/tmp/mockhub bash .claude/skills/refresh-screenshots/seed.sh
#
# Requires METAHUB_HOME to point at a throwaway dir (NEVER the real ~/.metahub).
# Prints the login URL (with token) on the last line for the screenshot driver.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CONTENT="$SCRIPT_DIR/content"

# --- safety: refuse to touch the real hub -----------------------------------
: "${METAHUB_HOME:?Set METAHUB_HOME to a throwaway dir (never ~/.metahub) before running}"
case "${METAHUB_HOME%/}" in
  "${HOME%/}/.metahub") echo "Refusing: METAHUB_HOME is the real hub" >&2; exit 1 ;;
esac
export METAHUB_HOME
rm -rf "$METAHUB_HOME"; mkdir -p "$METAHUB_HOME"

mh() { bun run "$REPO_ROOT/src/cli/index.ts" "$@"; }
mh init >/dev/null

# --- Roadmap table (exercises every property type) --------------------------
mh db create "Roadmap" >/dev/null
mh use roadmap >/dev/null
mh prop add Title    --type text >/dev/null
mh prop add Status   --type select --options "Backlog,In progress,In review,Shipped" >/dev/null
mh prop add Priority --type select --options "P0,P1,P2" >/dev/null
mh prop add Owner    --type text >/dev/null
mh prop add Area     --type multi_select --options "core,webui,sync,desktop,docs" >/dev/null
mh prop add Effort   --type number >/dev/null
mh prop add Due      --type date >/dev/null
mh prop add Done     --type checkbox >/dev/null
r() { mh record create --data "$1" >/dev/null; }
r '{"Title":"Block-level document CRDT","Status":"Shipped","Priority":"P0","Owner":"Noah","Area":["core","sync"],"Effort":8,"Due":"2026-05-12","Done":true}'
r '{"Title":"CodeMirror inline-mark editor","Status":"Shipped","Priority":"P0","Owner":"Noah","Area":["webui"],"Effort":13,"Due":"2026-06-30","Done":true}'
r '{"Title":"Offline PWA replica (SQLite-in-OPFS)","Status":"In review","Priority":"P0","Owner":"Mira","Area":["webui","sync"],"Effort":13,"Due":"2026-07-22","Done":false}'
r '{"Title":"Agent-hosted static sites","Status":"In progress","Priority":"P1","Owner":"Noah","Area":["webui","core"],"Effort":5,"Due":"2026-07-28","Done":false}'
r '{"Title":"S3 object-storage sync backend","Status":"In progress","Priority":"P1","Owner":"Kai","Area":["sync"],"Effort":8,"Due":"2026-08-04","Done":false}'
r '{"Title":"Desktop auto-update from Releases","Status":"Backlog","Priority":"P2","Owner":"Mira","Area":["desktop"],"Effort":5,"Due":"2026-08-18","Done":false}'
r '{"Title":"Full-text search ranking pass","Status":"Backlog","Priority":"P2","Owner":"Kai","Area":["core"],"Effort":3,"Due":"2026-08-25","Done":false}'
r '{"Title":"OpenAPI docs polish","Status":"Backlog","Priority":"P2","Owner":"Noah","Area":["docs","webui"],"Effort":2,"Due":"2026-09-01","Done":false}'

# --- Reading list table -----------------------------------------------------
mh db create "Reading list" >/dev/null
mh use "reading list" >/dev/null
mh prop add Title  --type text >/dev/null
mh prop add Author --type text >/dev/null
mh prop add Topic  --type select --options "CRDT,Local-first,Databases,AI agents,Systems" >/dev/null
mh prop add Rating --type select --options "★,★★,★★★,★★★★,★★★★★" >/dev/null
mh prop add Link   --type url >/dev/null
mh prop add Read   --type checkbox >/dev/null
b() { mh record create --data "$1" >/dev/null; }
b '{"Title":"Local-first software","Author":"Kleppmann et al.","Topic":"Local-first","Rating":"★★★★★","Link":"https://www.inkandswitch.com/local-first/","Read":true}'
b '{"Title":"A comprehensive study of CRDTs","Author":"Shapiro et al.","Topic":"CRDT","Rating":"★★★★","Link":"https://hal.inria.fr/inria-00555588","Read":true}'
b '{"Title":"Designing Data-Intensive Applications","Author":"Martin Kleppmann","Topic":"Databases","Rating":"★★★★★","Link":"https://dataintensive.net/","Read":false}'
b '{"Title":"Building agents with the Claude SDK","Author":"Anthropic","Topic":"AI agents","Rating":"★★★★","Link":"https://docs.anthropic.com/","Read":false}'
b '{"Title":"SQLite over the network","Author":"Ben Johnson","Topic":"Systems","Rating":"★★★","Link":"https://litestream.io/","Read":true}'

# --- Documents (bodies have NO leading H1 — the page title supplies it) ------
mh doc create --title "Architecture overview"     --body @"$CONTENT/arch.md"  >/dev/null
mh doc create --title "Sync protocol notes"       --body @"$CONTENT/sync.md"  >/dev/null
mh doc create --title "Weekly sync — 2026-07-13"   --body @"$CONTENT/notes.md" >/dev/null

# --- Emit the login URL for the screenshot driver (last line = URL) ---------
PORT="${MH_PORT:-7799}"
TOKEN="$(mh token show | grep -o '"token":"[^"]*"' | cut -d'"' -f4)"
echo "SEED_OK home=$METAHUB_HOME"
echo "http://localhost:${PORT}/?token=${TOKEN}"
