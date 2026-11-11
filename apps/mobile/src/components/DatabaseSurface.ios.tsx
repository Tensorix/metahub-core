import { databaseBenchmarkBaseline } from "@/lib/diagnostics/database-mode";
import { requireNativeViewManager } from "expo-modules-core";
import { forwardRef, useEffect, useState, type Ref } from "react";
import type { ViewProps } from "react-native";
import {
  DefaultDatabaseSurface,
  type DatabaseSurfaceHandle,
  type DatabaseSurfaceProps,
} from "./DefaultDatabaseSurface";
import {
  nativeDatabaseModule,
  prepareDatabaseSurface,
} from "@/lib/database/warmup.ios";
const Surface =
  !databaseBenchmarkBaseline &&
  nativeDatabaseModule?.sessionProtocol === 2 &&
  requireNativeViewManager<
    ViewProps & {
      ref?: Ref<DatabaseSurfaceHandle>;
      bootstrap: string;
      onMessage(event: { nativeEvent: { data: string } }): void;
      onFailure(event: { nativeEvent: { message: string } }): void;
    }
  >("MetahubDatabase");
export const DatabaseSurface = forwardRef<
  DatabaseSurfaceHandle,
  DatabaseSurfaceProps
>(function DatabaseSurface(props, ref) {
  const [ready, setReady] = useState(false),
    [fallback, setFallback] = useState(false);
  useEffect(() => {
    let live = true;
    if (Surface)
      void prepareDatabaseSurface().then(
        () => {
          if (live) setReady(true);
        },
        () => {
          if (live) setFallback(true);
        },
      );
    return () => {
      live = false;
    };
  }, []);
  if (!Surface || fallback)
    return <DefaultDatabaseSurface ref={ref} {...props} />;
  if (!ready) return null;
  return (
    <Surface
      ref={ref}
      bootstrap={props.bootstrap}
      style={{ flex: 1 }}
      onMessage={(e) => props.onMessage(e.nativeEvent.data)}
      onFailure={(e) => props.onFailure(e.nativeEvent.message)}
    />
  );
});
