/** @jsxImportSource preact */
// Preact host for the single-document CM6 editor. Owns one EditorView whose doc is
// the raw Markdown body; exposes a small imperative handle (getDoc / setDoc / focus
// / setSource) so the surrounding DocView keeps its existing save chain and remote-
// merge seam. The view is created once on mount and torn down on unmount — there is
// no per-render churn (callbacks are read through refs).

import { useEffect, useRef } from "preact/hooks";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { baseExtensions, richCompartment, richLayer, sourceLayer } from "./editor-view";
import { slashMenu } from "./chrome/slash-menu";
import { uploadPaste, pickAndUpload } from "./chrome/upload-paste";
import { uploadField, stripStaleUploadLines } from "./chrome/upload-field";
import { copyRich } from "./chrome/copy-rich";
import { previewAnchorField } from "./chrome/preview-anchor";
import { minimalReplace } from "./min-diff";
import { healLegacyMarkdown } from "../../core/md/heal";
import { formatBar } from "./chrome/format-bar";
import { docToc } from "./chrome/toc";
import { wordCount } from "./chrome/word-count";
import { blockGutter } from "./chrome/gutter";
import { find } from "./chrome/find";
import { voidDeps } from "./voids/void-field";
import type { Block, BlockType } from "../blocks";

export interface CmHandle {
  /** Current document as Markdown (identity save: this is what gets persisted). */
  getDoc(): string;
  /** Replace the document, preserving the caret via a minimal prefix/suffix diff
   *  (remote-merge seam). No-op if unchanged. */
  setDoc(md: string): void;
  focus(): void;
  /** Toggle source mode (drops the WYSIWYG decoration + structure layer). */
  setSource(on: boolean): void;
  readonly view: EditorView | null;
}

export interface CmDocBodyProps {
  initialDoc: string;
  onChange?: () => void;
  onReady?: (h: CmHandle) => void;
  onExitTop?: () => void;
  onError?: (message: string) => void;
  /** Open the image preview (desktop native window / in-page lightbox — owned
   *  by the host DocView). Reaches the image widgets via the voidDeps facet. */
  onPreviewImage?: (block: Block) => void;
  source?: boolean;
}

const acceptFor = (type: BlockType): string =>
  type === "image" ? "image/*" : type === "video" ? "video/*" : type === "audio" ? "audio/*" : "*/*";

// Boundary healing (idempotent; applies on load and on every remote setDoc):
// stripStaleUploadLines drops the old upload pipeline's literal placeholder
// lines, healLegacyMarkdown (core/md/heal — the same repair blocksFromBody and
// the share renderer apply) restores pre-strict-grammar forms: empty todos
// `- [ ]` → `- [ ] `, and bare-`>` quote gaps → `> `.
const norm = (s: string) => healLegacyMarkdown(stripStaleUploadLines(s.replace(/\r\n?/g, "\n")));

/** Replace the whole doc with a minimal single-range change so CM maps the caret
 *  through it (positions outside the changed middle are preserved). */
function replaceDoc(view: EditorView, next: string) {
  const change = minimalReplace(view.state.doc.toString(), next);
  if (change) view.dispatch({ changes: change });
}

export function CmDocBody(props: CmDocBodyProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(props.onChange);
  const onExitTopRef = useRef(props.onExitTop);
  const onErrorRef = useRef(props.onError);
  const onPreviewImageRef = useRef(props.onPreviewImage);
  onChangeRef.current = props.onChange;
  onExitTopRef.current = props.onExitTop;
  onErrorRef.current = props.onError;
  onPreviewImageRef.current = props.onPreviewImage;

  useEffect(() => {
    const parent = hostRef.current;
    if (!parent) return;

    const opts = { onExitTop: () => onExitTopRef.current?.() };
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: norm(props.initialDoc),
        extensions: [
          ...baseExtensions(opts),
          // Chrome (always on; reads the always-on docModelField so it survives
          // source mode). The slash menu's upload types open a native file picker.
          docToc(),
          wordCount(),
          blockGutter(),
          formatBar(),
          find(),
          slashMenu({
            onUpload: (type, v, pos) => pickAndUpload(v, pos, acceptFor(type), (m) => onErrorRef.current?.(m)),
          }),
          uploadPaste({ onError: (m) => onErrorRef.current?.(m) }),
          copyRich(), // text/html flavor via the shared share renderer
          uploadField, // always on (outside richCompartment): pending uploads must survive source mode
          previewAnchorField, // which image void the preview window has open (annotation routing)
          voidDeps.of({ onPreviewImage: (b) => onPreviewImageRef.current?.(b) }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current?.();
          }),
        ],
      }),
    });
    viewRef.current = view;
    if (props.source) view.dispatch({ effects: richCompartment.reconfigure(sourceLayer()) });

    const handle: CmHandle = {
      // In-widget edits (table cells, code lang) commit synchronously, so the doc
      // is always current — no flush pass needed before a snapshot.
      getDoc: () => view.state.doc.toString(),
      setDoc: (md) => replaceDoc(view, norm(md)),
      focus: () => view.focus(),
      setSource: (on) =>
        view.dispatch({ effects: richCompartment.reconfigure(on ? sourceLayer() : richLayer(opts)) }),
      get view() {
        return view;
      },
    };
    props.onReady?.(handle);

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Mount once; doc/source changes flow through the imperative handle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={hostRef} class="cm-doc-body" />;
}
