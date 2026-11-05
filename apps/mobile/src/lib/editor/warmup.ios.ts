import { requireOptionalNativeModule } from "expo-modules-core";
import { editorHTML } from "./editor-bundle";

export const nativeEditorModule = requireOptionalNativeModule<{
  prepare(html: string): Promise<void>;
  warm(): Promise<void>;
}>("MetahubEditor");

let configured: Promise<void> | undefined;
export function prepareEditorSurface() {
  if (!nativeEditorModule) return Promise.reject(new Error("iOS 编辑器模块不可用"));
  return configured ??= nativeEditorModule.prepare(editorHTML.replace("__METAHUB_BOOTSTRAP__", "null")).catch(error => {
    configured = undefined;
    throw error;
  });
}

export function warmEditorSurface() {
  if (!nativeEditorModule) return;
  // prepare creates the first idle page. Later visits to the tabs replace it
  // only if it has been claimed or evicted.
  const work = configured ? configured.then(() => nativeEditorModule.warm()) : prepareEditorSurface();
  void work.catch(() => {});
}
