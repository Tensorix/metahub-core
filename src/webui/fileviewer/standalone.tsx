/** @jsxImportSource preact */
// Disk-loaded entry for the desktop file-editor window (.txt/.md "open with").
// Built by apps/desktop/scripts/build-file-editor.ts and loaded via
// win.loadFile — NOT served by the sidecar — so the window opens instantly,
// before the server process is even up. Bundles only the editor subtree;
// server-dependent features (导入到 MetaHub, [[doclink]] titles, 格式化) attach
// lazily via setApiBase once the sidecar reports healthy over the preload
// bridge, and degrade gracefully until then.
import { render } from "preact";
import { setApiBase } from "../api.ts";
import { allDocTitles } from "../doc-titles.ts";
import { FileEditorWindow } from "./file-editor.tsx";

document.body.classList.add("desktop", "file-window");
if (window.metahubDesktop?.platform === "darwin") document.body.classList.add("desktop-mac");

void window.metahubDesktop?.server?.origin().then((o) => {
  if (!o) return;
  setApiBase(o);
  // Kick the [[doclink]] title map now that the API is reachable — chips
  // rendered before attach resolve their titles via onDocTitleChange.
  allDocTitles();
});

render(<FileEditorWindow />, document.getElementById("app")!);
