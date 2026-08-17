// Click contract of the `[[doc_x]]` internal reference (see cm6/inline.ts).
//
// The collapsed pill is a CM widget: if its ignoreEvent() returns true, CM's
// eventBelongsToEditor() drops the event before ANY domEventHandler runs, so
// the pill silently swallows clicks (no navigation, no caret) — that was the
// shipped bug this file guards. The navigation itself lives in openDocLink(),
// tested here directly against plain DOM (no EditorView, no layout).
//
// inline.ts pulls in Preact (toast) and reads `location`, so register happy-dom
// for this file (same pattern as void-field.test.ts / markdown.dom.test.ts).
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

import { afterAll, beforeEach, test, expect } from "bun:test";
import { DocLinkWidget, openDocLink } from "./inline";
import { primeDocTitles } from "../doc-titles.ts";
import type { Db, DocSummary } from "../api";

afterAll(() => GlobalRegistrator.unregister());

// Prime the title map so docLinkTitle() answers synchronously and never kicks
// a network refresh: "doc_a-1"/"db_t-1" exist, anything else reads as missing.
primeDocTitles(
  [{ id: "doc_a-1", title: "笔记" }] as unknown as DocSummary[],
  [{ id: "db_t-1", name: "任务" }] as unknown as Db[],
);

function pill(attrs: Record<string, string>): HTMLElement {
  const el = document.createElement("span");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

beforeEach(() => {
  location.hash = "#/";
});

test("the collapsed pill must not ignore events, or its clicks never reach linkClicks", () => {
  expect(new DocLinkWidget("doc_a-1", "笔记", false).ignoreEvent()).toBe(false);
});

test("clicking a collapsed pill navigates to the doc", () => {
  expect(openDocLink(pill({ "data-doclink": "doc_a-1" }), false)).toBe(true);
  expect(location.hash).toBe("#/doc/doc_a-1");
});

test("a db_ target routes to the database view", () => {
  expect(openDocLink(pill({ "data-doclink": "db_t-1" }), false)).toBe(true);
  expect(location.hash).toBe("#/db/db_t-1");
});

test("a missing target toasts instead of navigating", () => {
  expect(openDocLink(pill({ "data-doclink": "doc_gone-9" }), false)).toBe(true);
  expect(location.hash).toBe("#/");
  // The flag set by the decoration builder short-circuits the same way.
  expect(openDocLink(pill({ "data-doclink": "doc_a-1", "data-doclink-missing": "1" }), false)).toBe(true);
  expect(location.hash).toBe("#/");
});

test("revealed source: plain click places the caret, Mod-click navigates", () => {
  const revealed = pill({ "data-doclink": "doc_a-1", "data-md-revealed": "1" });
  expect(openDocLink(revealed, false)).toBe(false);
  expect(location.hash).toBe("#/");
  expect(openDocLink(revealed, true)).toBe(true);
  expect(location.hash).toBe("#/doc/doc_a-1");
});
