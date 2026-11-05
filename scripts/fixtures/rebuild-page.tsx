/** @jsxImportSource preact */
// Isolated browser acceptance host. The panel, bus and database worker are production modules.
import { render } from "preact";
import { registerDocumentEditor } from "../../src/webui/document-lifecycle.ts";
import { LocalRecovery } from "../../src/webui/settings/local-recovery.tsx";
import { UiHost } from "../../src/webui/ui.tsx";
import { startReplica, call } from "../../src/webui/data/replica.ts";
import {
  spoolPut,
  spoolGet,
  blobHash32,
} from "../../src/webui/data/blob-store.ts";

startReplica();
const config = {
  endpoint: location.origin,
  region: "test",
  bucket: "synthetic",
  prefix: "fixture",
  accessKeyId: "test",
  secretAccessKey: "test",
  encrypt: false,
  publish: false,
};
const url = `s3://${location.host}/synthetic/fixture`;
let dirty = false;
let unregister: (() => void) | undefined;
Object.assign(window, {
  acceptance: {
    call,
    refuseSave(value: boolean) {
      dirty = value;
      if (dirty) {
        unregister = registerDocumentEditor({
          id:"fixture-editor", dirty:() => dirty,
          flush:async () => ({ ok:false,error:"编辑器拒绝保存" }),
          snapshot:() => ({ title:"fixture",body:"unflushed",version:null,error:"" }),
        });
      } else { unregister?.(); }
    },
    async seed() {
      const doc = await call<{ id: string }>("createDocument", {
        title: "offline",
        body: "pending local text",
      });
      await call("addStorageReplica", config, "");
      return doc.id;
    },
    async spool(bad: boolean) {
      const bytes = new TextEncoder().encode(
        bad ? "bad bytes" : "pending bytes",
      ).buffer;
      const hash = await blobHash32(
        new TextEncoder().encode("pending bytes").buffer,
      );
      await spoolPut(hash, bytes, "application/octet-stream");
      return hash;
    },
    spoolGet,
  },
});
render(
  <>
    <LocalRecovery
      desktop={false}
      buckets={[{ url, bucket: "synthetic", enabled: true }]}
    />
    <UiHost />
  </>,
  document.getElementById("app")!,
);
