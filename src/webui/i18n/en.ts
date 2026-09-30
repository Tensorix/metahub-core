import type { Msg } from "./en/util.ts";
import { base } from "./en/base.ts";
import { shell } from "./en/shell.ts";
import { editor } from "./en/editor.ts";
import { tables } from "./en/tables.ts";
import { settings } from "./en/settings.ts";
import { backup } from "./en/backup.ts";
import { sites } from "./en/sites.ts";
import { sharing } from "./en/sharing.ts";

export const en = { ...base, ...shell, ...editor, ...tables, ...settings, ...backup, ...sites, ...sharing } satisfies Record<string, Msg>;
