import { requireNativeViewManager } from "expo-modules-core";
import { forwardRef, useEffect, useState, type Ref } from "react";
import type { ViewProps } from "react-native";
import { DefaultEditorSurface, type EditorSurfaceHandle, type EditorSurfaceProps } from "./DefaultEditorSurface";
import { nativeEditorModule, prepareEditorSurface } from "../lib/editor/warmup.ios";

const NativeSurface = nativeEditorModule && requireNativeViewManager<ViewProps & {
  ref?: Ref<EditorSurfaceHandle>;
  bootstrap: string;
  onMessage(event: { nativeEvent: { data: string } }): void;
  onFailure(event: { nativeEvent: { message: string } }): void;
}>("MetahubEditor");
export const EditorSurface = forwardRef<EditorSurfaceHandle, EditorSurfaceProps>(
  function EditorSurface(props, ref) {
    const [prepared, setPrepared] = useState(false);
    const [fallback, setFallback] = useState(false);
    useEffect(() => {
      if (!nativeEditorModule) return;
      let current = true;
      void prepareEditorSurface().then(() => { if (current) setPrepared(true); }, () => { if (current) setFallback(true); });
      return () => { current = false; };
    }, []);
    if (!NativeSurface || fallback) return <DefaultEditorSurface ref={ref} {...props} />;
    if (!prepared) return null;
    return <NativeSurface ref={ref} bootstrap={props.bootstrap} style={{ flex: 1 }}
      onMessage={event => props.onMessage(event.nativeEvent.data)}
      onFailure={event => props.onFailure(event.nativeEvent.message)}
    />;
  },
);
