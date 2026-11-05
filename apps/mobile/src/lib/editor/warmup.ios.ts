import { requireOptionalNativeModule } from "expo-modules-core";
import { editorHTML } from "./editor-bundle";

export const nativeEditorModule = requireOptionalNativeModule<{
  sessionProtocol?: number;
  invalidate?(workspace: string, instance: string): Promise<void>;
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
  if (nativeEditorModule?.sessionProtocol !== 2) return;
  // Warm only an absent runtime. An attached or already idle page is reusable.
  const work = configured ? configured.then(() => nativeEditorModule.warm()) : prepareEditorSurface();
  void work.catch(() => {});
}

export function invalidateEditorRuntime(workspace: string, instance: string) { void nativeEditorModule?.invalidate?.(workspace, instance).catch(() => {}); }

export const reusesEditorRuntime = nativeEditorModule?.sessionProtocol === 2;
