import { renderUsage, type CommandDef } from "citty";

/**
 * Rich, AI-oriented help. citty's default usage only lists commands + flags;
 * an agent driving this CLI also needs the concepts (db/prop/rec/doc), the ref
 * system, the @file/@-/JSON I/O conventions, and copy-pasteable recipes. We
 * print that on `mh --help` (root) and append per-command EXAMPLES elsewhere.
 */

const ROOT_GUIDE = `metahub — local knowledge base for AI agents
Notion-like typed databases (tables + rows) and markdown documents, stored in
~/.metahub via SQLite, CRDT-mergeable across machines.

USAGE
  mh <command> [subcommand] [args] [--flags]
  metahub <command> ...            # 'mh' and 'metahub' are the same binary
  mh <command> --help              # detailed help + examples for any command

CONCEPTS
  database (db)    A typed table. Owns properties and records.
  property (prop)  A column with a type (text|number|...). Belongs to a db.
  record (rec)     A row of cells. Write a flat { column: value } map; reads
                   wrap them as { id, database_id, values: { column: value } }
                   — field values live under "values", keyed by property name.
  document (doc)   A markdown doc, stored as ordered blocks (block-level CRDT).
  site (site)      A named set of files (HTML/CSS/JS) served at /sites/<name>/.
  Every id is "<kind>_<slug>-<rand>", e.g. db_tasks-k3f9c1, rec_fix-login-7j02an.
  The kind prefix makes ids self-describing; the random suffix is collision-safe.

REFERENCES  (how to name an entity — anywhere an id/ref is accepted)
  Resolved in this order, so you rarely paste a full id:
    full id        db_tasks-k3f9c1     always works, across databases
    unique prefix  fix-log             git-short-SHA style; bare slug ok
    name / title   "Tasks"             db name / doc title / prop name, case-insensitive
  Ambiguous refs fail and list candidates. Relation values resolve the same way.

CURRENT DATABASE
  'mh use <db>' sets a default db; then record/prop/doc commands may omit the
  database argument (--db / <database>). 'mh use' shows it, 'mh use --clear' unsets.

INPUT  (every text/JSON value accepts these)
  literal     --data '{"Title":"x"}'      a plain string
  @file       --body @notes.md            read the file
  @-          --data @-                   read stdin

OUTPUT
  TTY (human)        → tables / markdown
  piped / non-TTY    → JSON (this is what an agent gets)
  Force with --json or --pretty regardless of TTY.

COMMANDS
  setup
    init                              Create ~/.metahub (SQLite db + cache dir)
    init --claude                     Install the /mh skill into ~/.claude (Claude Code)
    init --codex                      Install the $mh skill into ~/.codex (Codex)
  databases
    db create <name> [--icon]         Create a database (table)
    db list | get <ref> | delete <ref>
    use [<db>] [--clear]              Set / show / clear the current database
  schema
    prop add <name> --type <t> [--db <ref>] [--options a,b] [--target <db>]
    prop list [<db>] | update <ref> | remove <ref>
                                      Types: text number checkbox select
                                      multi_select date relation url
  records
    record create [<db>] --data <json>
    record list [<db>] [--filter <json>] [--sort <field>] [--desc] [--limit N]
    record get <ref> | update <ref> --data <json> | delete <ref>
  documents
    doc create --title <t> [--body <md>] [--db <ref>] [--parent <ref>]
    doc list [--db <ref>]               Indented parent/child tree
    doc get <ref> | delete <ref>
    doc update <ref> [--title <t>] [--body <md>] [--parent <ref>]
                                      --parent "" moves the doc to top level
    doc read <ref>                    Body + version token (read before edit)
    doc edit <ref> --old <txt> --new <txt> [--replace-all] [--if-match <ver>]
    doc append <ref> --body <md>      Add block(s) at end (also: prepend)
  lookup & editing
    get <ref>                         Resolve any ref, auto-detect its kind
    search <query> [--limit N]        Full-text over documents + records
    edit <ref> [--vscode]             Open in $EDITOR (interactive, for humans)
  static sites  (host agent-authored HTML/CSS/JS, served by --server at /sites/<name>/)
    site create <name> [--title] [--public]  Create a site (a named set of files)
    site update <site> [--visibility public|private] [--spa|--no-spa] [--title]
    site scaffold <dir> [--force]     Write a starter index.html (SDK import + working example)
    site put <site> <path> --from <file> | --content <txt|@file|@->
    site publish <site> <dir>         Upload a directory (alias: upload; --create to create; --prune mirrors deletes)
    site list | files <site>
    site grant <site> <db>:<ops>      Anonymous data access for a PUBLIC site's api/ (ops: read,create,update; --revoke <db>; --clear)
    site grants <site>                Show a site's public data grants
    site rm <site> <path> | delete <site>
  server auth  (token persisted in ~/.metahub; rotates on expiry or 'token refresh')
    token show                        Print the current server token + expiry
    token refresh                     Rotate now (old token swappable during grace)
  sync & backup
    sync <url>                        Push/pull one round against a sync server
    sync <src> <dst>                  Export/import a doc(→md) or table(→csv) file
    --server [--port N] [--host H] [--debug] [--token T]
                                      Run as a server: /sync + WebUI + /api/* +
                                      /docs + sites at /sites/<name>/. Outside
                                      --debug a token guards every request. The
                                      token persists in ~/.metahub (30d TTL,
                                      rotates on expiry; old token swappable for
                                      7d via /auth/token). --token / METAHUB_TOKEN
                                      pins a fixed token instead. Both windows are
                                      env-tunable (METAHUB_TOKEN_TTL / _GRACE).
    snapshot <out.mhpack>             Package all data into a portable file
    restore <pack> [--reset --force]  Restore (merge by default)
  edge  (optional: your own Cloudflare Worker+D1 as the always-on surface —
         sealed write-inbox for public sites, and Durable Object rooms hosting shares)
    edge deploy --account-id <id> --api-token <token> --yes
                                      Create/continue a dedicated Worker + D1 deployment.
                                      Names default from this node; API token is never saved.
    edge status | pull | rotate [--purge-retired]
    edge connect --endpoint <url> --token <t>   Use a non-Cloudflare inbox host
    share create <site> --grant <db>:<ops> [--password] --room
                                      Host a share on an always-on room (revoke destroys it)
  shell
    completion <bash|zsh|fish>        Print a completion script

EXAMPLE  (end-to-end)
  mh init
  mh db create "Tasks"                          # -> db_tasks-k3f9c1
  mh use tasks                                  # scope record/prop to it
  mh prop add Title  --type text
  mh prop add Status --type select --options "todo,doing,done"
  mh record create --data '{"Title":"Write spec","Status":"todo"}'
  mh record update write-spec --data '{"Status":"doing"}'   # ref by prefix
  mh search "spec"

AI WORKFLOW  (edit a doc without clobbering concurrent changes)
  mh doc read <ref>                                   # note the version token
  mh doc edit <ref> --old "old text" --new "new text" --if-match <version>
  mh doc append <ref> --body "a new paragraph"

SITE DATA  (read a table from a hosted page — field values nest under "values")
  // a page served at /sites/<name>/ reads this library same-origin:
  const rs = await fetch('/api/records?db=tasks').then(r => r.json());
  // rs.records: [{ id, database_id, values: { Title, Status } }]
  rs.records.forEach(r => render(r.values.Title, r.values.Status));
  // NOTE: writes take a flat { column: value } map; reads wrap cells in .values
  // or the typed SDK:  import { api } from "/metahub-sdk.js"; await api.listRecords('tasks')
  // full REST reference: GET /docs.json (OpenAPI)

Run 'mh <command> --help' for arguments and examples of a specific command.`;

/**
 * Per-command examples, keyed by command path ("record create", "search", ...).
 * Appended under an EXAMPLES heading after citty's generated usage.
 */
const EXAMPLES: Record<string, string[]> = {
  init: [
    "mh init",
    "mh init --claude   # install the /mh skill into ~/.claude (Claude Code)",
    "mh init --codex    # install the $mh skill into ~/.codex (Codex)",
    "METAHUB_HOME=/tmp/mh mh init   # use an alternate home",
  ],
  "db create": ['mh db create "Tasks"', 'mh db create "Notes" --icon 📓'],
  "db get": ["mh db get tasks", "mh db get db_tasks-k3f9c1"],
  use: ["mh use tasks", "mh use            # show current", "mh use --clear"],
  get: ["mh get tasks", "mh get fix-log    # unique prefix, any kind"],
  "prop add": [
    "mh prop add Title --type text",
    'mh prop add Status --type select --options "todo,doing,done"',
    "mh prop add Owner --type relation --target people",
  ],
  "record create": [
    `mh record create --data '{"Title":"Write spec","Status":"todo"}'`,
    "mh record create tasks --data @row.json   # explicit db + file input",
    `echo '{"Title":"x"}' | mh record create --data @-`,
  ],
  "record list": [
    "mh record list",
    `mh record list --filter '{"Status":"todo"}' --sort created --desc --limit 20`,
  ],
  "record update": [`mh record update write-spec --data '{"Status":"doing"}'`],
  "doc create": [
    'mh doc create --title "Architecture" --body @arch.md',
    'mh doc create --title "Sub page" --parent architecture',
  ],
  "doc update": [
    'mh doc update sub-page --parent architecture   # nest under another doc',
    'mh doc update sub-page --parent ""             # move back to top level',
  ],
  "doc read": ["mh doc read architecture    # returns body + version token"],
  "doc edit": [
    'mh doc edit architecture --old "draft" --new "final"',
    'mh doc edit architecture --old "TODO" --new "done" --replace-all --if-match <version>',
  ],
  "doc append": ['mh doc append architecture --body "## New section\\n..."'],
  search: ['mh search "architecture"', 'mh search "spec" --limit 5'],
  "site create": ['mh site create blog --title "My Blog"'],
  "site put": [
    "mh site put blog index.html --from ./index.html",
    "echo '<h1>hi</h1>' | mh site put blog index.html --content @-",
  ],
  "site scaffold": [
    "mh site scaffold ./app                 # starter index.html, then: mh site publish myapp ./app --create",
    "mh site scaffold ./app --force         # overwrite an existing index.html",
  ],
  "site publish": [
    "mh site publish blog ./dist --create   # first publish creates the site",
    "mh site publish blog ./dist            # re-publish (the site must exist)",
    "mh site publish blog ./dist --prune    # mirror: also delete remote files gone locally",
  ],
  "site files": ["mh site files blog"],
  "site grant": [
    "mh site grant blog guestbook:read,create   # anonymous visitors read + add rows",
    "mh site grant blog guestbook:create --turnstile <sitekey> --turnstile-secret <secret>",
    "mh site grant blog guestbook:create --password hunter2   # submissions need the password",
    "mh site grant blog guestbook --revoke",
    "mh site grant blog --clear",
  ],
  token: ["mh token            # show current token", "mh token show", "mh token refresh"],
  sync: [
    "mh sync http://localhost:7777        # peer push/pull",
    "mh sync architecture arch.md         # export doc → markdown",
    "mh sync tasks tasks.csv              # export table → CSV",
    "mh sync arch.md architecture         # import markdown → doc",
    "mh sync tasks.csv tasks              # import CSV → table",
  ],
  "edge deploy": [
    "mh edge deploy --account-id <id> --api-token <token> --yes",
    "mh edge deploy --api-token <token> --yes  # upgrade using stored resource names",
  ],
  "edge status": ["mh edge status", "mh edge status --json"],
  "edge pull": ["mh edge pull        # one manual inbox round (auto-sync pulls every ~60s)"],
  "edge rotate": [
    "mh edge rotate",
    "mh edge rotate --purge-retired          # after in-flight envelopes have drained",
  ],
  "edge connect": ["mh edge connect --endpoint https://inbox.example.com --token drt_..."],
  snapshot: ["mh snapshot backup.mhpack"],
  restore: ["mh restore backup.mhpack", "mh restore backup.mhpack --reset --force"],
  completion: ['eval "$(mh completion zsh)"', "mh completion bash >> ~/.bashrc"],
};

function metaName(cmd?: CommandDef): string | undefined {
  const meta = cmd?.meta;
  return meta && typeof meta === "object" && "name" in meta ? (meta.name as string) : undefined;
}

/** Build the EXAMPLES lookup key from a command and its immediate parent. */
function exampleKey(cmd: CommandDef, parent?: CommandDef): string | undefined {
  const name = metaName(cmd);
  if (!name) return undefined;
  const parentName = metaName(parent);
  // The root command is "metahub"; a real group parent (e.g. "record") prefixes.
  return parentName && parentName !== "metahub" ? `${parentName} ${name}` : name;
}

/**
 * Drop-in replacement for citty's `showUsage`, passed to `runMain`.
 * Root (`mh --help`) prints the full guide; subcommands get citty's usage plus
 * any registered examples.
 */
export async function showUsage(cmd: CommandDef, parent?: CommandDef): Promise<void> {
  // Root command has no parent — show the comprehensive guide.
  if (!parent) {
    console.log(ROOT_GUIDE);
    return;
  }
  let usage = await renderUsage(cmd, parent);
  const key = exampleKey(cmd, parent);
  const examples = key ? EXAMPLES[key] : undefined;
  if (examples?.length) {
    usage += "\n\nEXAMPLES\n\n" + examples.map((e) => "  " + e).join("\n");
  }
  console.log(usage + "\n");
}
