import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { documentIdFromLink, installDocumentLinks } from "./document-links";
import { createDocumentLinkInbox } from "./document-link-inbox";

describe("desktop document URLs", () => {
  test.each([
    ["mh://doc/doc_meeting-notes-a1b2c3", "doc_meeting-notes-a1b2c3"],
    ["mh://doc/doc_123/", "doc_123"],
    ["MH://doc/doc_123", "doc_123"],
    ["mh://document/open?id=doc_meeting-notes-a1b2c3", "doc_meeting-notes-a1b2c3"],
  ])("parses %s", (url, id) => expect(documentIdFromLink(url)).toBe(id));

  test.each([
    undefined, null, 123, "", "mh://", "mh://doc/", "mh://doc/doc_",
    "mh://doc/db_table-123", "mh://doc/doc_UPPER", "mh://doc/doc_123/extra",
    "mh://doc/doc_123\n", " mh://doc/doc_123", "mh://doc/doc_123 ",
    "mh://doc/doc_123#extra", "mh://doc/doc_123?url=https://evil.example",
    "mh://user@doc/doc_123", "mh://doc:80/doc_123", "mh:///doc/doc_123",
    "mh://doc/a/../doc_123", "mh://doc/%64oc_123", "mh://doc/doc_123%2f..",
    "mh://doc/doc_123%00", "mh://doc/doc_123\\evil", "mh://doc/doc_123\t",
    "mh://document/open?id=doc_123&id=doc_456", "mh://document/open?id=",
    "mh://document/open?id=doc_123&command=delete", "mh://document/open?id=%64oc_123",
    "mh://document/open?id=doc_123#extra", "mh://document/open?id=doc_123\n",
    "mh://file/etc/passwd", "mh://exec/delete", "https://doc/doc_123",
    "file:///doc/doc_123", "javascript:alert(1)", "--url=mh://doc/doc_123",
  ])("ignores malformed or unsupported input %p", (url) => expect(documentIdFromLink(url)).toBeNull());
});

test("macOS URL events are accepted immediately, before app readiness", () => {
  const app = new EventEmitter();
  const opened: string[] = [];
  installDocumentLinks(app, (id) => opened.push(id));
  let prevented = false;
  app.emit("open-url", { preventDefault() { prevented = true; } }, "mh://doc/doc_cold-123");
  expect(prevented).toBe(true);
  expect(opened).toEqual(["doc_cold-123"]);
  app.emit("open-url", { preventDefault() {} }, "mh://exec/delete");
  expect(opened).toHaveLength(1);
});

test("launch and forwarded argv find the latest document regardless of argument position", () => {
  const opened: string[] = [];
  const links = installDocumentLinks(new EventEmitter(), (id) => opened.push(id));
  expect(links.handleArguments(["Metahub.exe", "mh://doc/doc_cold-123", "--original-process-start-time=0"])).toBe(true);
  expect(links.handleArguments(["Metahub.exe", "--flag", "mh://doc/doc_warm-123", "notes.md"])).toBe(true);
  expect(links.handleArguments(["mh://doc/doc_first-123", "mh://doc/doc_latest-123"])).toBe(true);
  expect(links.handleArguments(["Metahub.exe", "notes.md", "mh://exec/delete"])).toBe(false);
  expect(opened).toEqual(["doc_cold-123", "doc_warm-123", "doc_latest-123"]);
});

test("preload retains the latest link until the renderer subscribes, without stale replay", () => {
  const inbox = createDocumentLinkInbox();
  const opened: string[] = [];
  inbox.receive("doc_first-123");
  inbox.receive("doc_latest-123");
  const unsubscribe = inbox.subscribe((id) => opened.push(id));
  expect(opened).toEqual(["doc_latest-123"]);
  inbox.receive("doc_warm-123");
  expect(opened).toEqual(["doc_latest-123", "doc_warm-123"]);
  unsubscribe();
  const remounted: string[] = [];
  const unsubscribeAgain = inbox.subscribe((id) => remounted.push(id));
  expect(remounted).toEqual([]);
  unsubscribeAgain();
  inbox.receive("doc_between-mounts");
  inbox.subscribe((id) => remounted.push(id));
  expect(remounted).toEqual(["doc_between-mounts"]);
});
