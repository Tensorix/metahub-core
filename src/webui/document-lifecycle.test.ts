import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";
import type { DocumentSaveResult } from "./document-save";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

test("an abandoned draft claimant leaves the unsaved draft recoverable", async () => {
  const { registerDocumentEditor, claimDocumentDraft } = await import("./document-lifecycle");
  let finish!: (result: DocumentSaveResult) => void;
  const pending = new Promise<DocumentSaveResult>((resolve) => { finish = resolve; });
  const draft = { title: "Unsaved title", body: "Unsaved body", version: "v1", error: "conflict" };
  const detach = registerDocumentEditor({
    id: "draft-test", dirty: () => true, flush: () => pending, snapshot: () => draft,
  });
  detach();
  const abandoned = claimDocumentDraft("draft-test");
  finish({ ok: false, error: "conflict" });
  expect((await abandoned)?.body).toBe(draft.body);
  // The receiving editor navigated away before accepting ownership.
  const recovered = await claimDocumentDraft("draft-test");
  expect(recovered?.title).toBe(draft.title);
  expect(recovered?.body).toBe(draft.body);
  recovered!.accept();
  expect(await claimDocumentDraft("draft-test")).toBeNull();
});
