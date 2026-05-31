import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import {
  loadOrRotate,
  rotate,
  DEFAULT_TTL_MS,
  DEFAULT_GRACE_MS,
} from "../../core/sync/token.ts";
import { print, guard } from "../output.ts";

const iso = (ms: number) => new Date(ms).toISOString();

// A single command with an optional `action` positional (not subCommands):
// citty runs a parent command's `run` *in addition to* a matched subcommand,
// which would double-execute `mh token show`. This keeps one run, defaulting
// to `show`.
export default defineCommand({
  meta: {
    name: "token",
    description: "Show or rotate the server auth token (persisted in ~/.metahub; rotates on expiry)",
  },
  args: {
    action: {
      type: "positional",
      required: false,
      description: "show (default) | refresh",
    },
  },
  run: guard((args) => {
    const db = openMetahub();
    const action = args.action ?? "show";

    if (action === "refresh") {
      const s = rotate(db, DEFAULT_TTL_MS, DEFAULT_GRACE_MS);
      print(
        {
          token: s.token,
          exp: s.exp,
          expires: iso(s.exp),
          prev_swappable_until: s.prevExp ? iso(s.prevExp) : null,
        },
        () =>
          `token:   ${s.token}\nexpires: ${iso(s.exp)}` +
          (s.prevExp ? `\nold token still swappable until ${iso(s.prevExp)}` : ""),
      );
      return;
    }

    if (action === "show") {
      const s = loadOrRotate(db, DEFAULT_TTL_MS, DEFAULT_GRACE_MS);
      print(
        { token: s.token, exp: s.exp, expires: iso(s.exp) },
        () => `token:   ${s.token}\nexpires: ${iso(s.exp)}`,
      );
      return;
    }

    throw new Error(`unknown action '${action}' (use: show | refresh)`);
  }),
});
