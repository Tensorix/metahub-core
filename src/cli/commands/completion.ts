import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import { resolveCandidates, type PublicKind } from "../../core/resolve.ts";
import { getCurrentDatabase } from "../../core/context.ts";
import { fail, guard } from "../output.ts";

const PUBLIC = new Set<PublicKind>(["db", "prop", "rec", "doc"]);

// Hidden helper that completion scripts call. Prints one candidate id per line,
// scoped to the current database for rec/doc/prop so only relevant refs show.
export const complete = defineCommand({
  meta: { name: "__complete", description: "(internal) shell-completion candidates" },
  args: {
    kind: { type: "positional", required: true, description: "db|prop|rec|doc|any" },
    partial: { type: "positional", required: false, description: "Prefix typed so far" },
  },
  run: guard((args) => {
    const db = openMetahub();
    const kind = args.kind === "any" ? undefined : (args.kind as PublicKind);
    if (kind && !PUBLIC.has(kind)) return;
    // Scope only records/properties to the current database (they always belong
    // to one); documents may be standalone or cross-database, so list all.
    const scoped = kind === "rec" || kind === "prop";
    const cands = resolveCandidates(db, args.partial ?? "", {
      kind,
      databaseId: scoped ? getCurrentDatabase(db)?.id : undefined,
    });
    for (const c of cands) console.log(c.id);
  }),
});

// Maps `mh <sub> <subsub>` to the kind to complete; shared by all three shells.
// NOTE: shell `${...}` is escaped as `\${...}` so JS template interpolation
// leaves it intact (String.raw would NOT — it still interpolates `${}`).
const BASH = `_mh_complete() {
  local cur sub subsub kind=""
  cur="\${COMP_WORDS[COMP_CWORD]}"
  sub="\${COMP_WORDS[1]}"
  subsub="\${COMP_WORDS[2]}"
  case "$sub" in
    get) kind=any ;;
    use) kind=db ;;
    db) case "$subsub" in get|delete) kind=db ;; esac ;;
    record) case "$subsub" in get|update|delete) kind=rec ;; esac ;;
    doc) case "$subsub" in get|read|update|edit|append|prepend|delete) kind=doc ;; esac ;;
    prop) case "$subsub" in update|remove) kind=prop ;; esac ;;
  esac
  [ -z "$kind" ] && return
  COMPREPLY=( $(compgen -W "$(mh __complete "$kind" "$cur" 2>/dev/null)" -- "$cur") )
}
complete -F _mh_complete mh`;

const ZSH = `_mh() {
  local sub=$words[2] subsub=$words[3] kind=""
  case "$sub" in
    get) kind=any ;;
    use) kind=db ;;
    db) case "$subsub" in get|delete) kind=db ;; esac ;;
    record) case "$subsub" in get|update|delete) kind=rec ;; esac ;;
    doc) case "$subsub" in get|read|update|edit|append|prepend|delete) kind=doc ;; esac ;;
    prop) case "$subsub" in update|remove) kind=prop ;; esac ;;
  esac
  [[ -z "$kind" ]] && return
  local -a ids
  ids=(\${(f)"$(mh __complete $kind \${words[CURRENT]} 2>/dev/null)"})
  compadd -- $ids
}
compdef _mh mh`;

const FISH = `function __mh_complete
  set -l tokens (commandline -opc)
  set -l sub $tokens[2]
  set -l subsub $tokens[3]
  set -l kind ""
  switch "$sub"
    case get; set kind any
    case use; set kind db
    case db; switch "$subsub"; case get delete; set kind db; end
    case record; switch "$subsub"; case get update delete; set kind rec; end
    case doc; switch "$subsub"; case get read update edit append prepend delete; set kind doc; end
    case prop; switch "$subsub"; case update remove; set kind prop; end
  end
  test -n "$kind"; and mh __complete $kind (commandline -ct) 2>/dev/null
end
complete -c mh -f -a '(__mh_complete)'`;

const SCRIPTS: Record<string, string> = { bash: BASH, zsh: ZSH, fish: FISH };

export default defineCommand({
  meta: {
    name: "completion",
    description: "Print a shell completion script: eval \"$(mh completion zsh)\"",
  },
  args: { shell: { type: "positional", required: true, description: "bash|zsh|fish" } },
  run: guard((args) => {
    const script = SCRIPTS[args.shell];
    if (!script) fail(`unknown shell: ${args.shell} (expected bash|zsh|fish)`);
    console.log(script);
  }),
});
