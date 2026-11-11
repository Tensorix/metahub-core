import { databaseBenchmarkBaseline } from "../diagnostics/database-mode";
import { requireOptionalNativeModule } from "expo-modules-core";
import { databaseHTML } from "./bundle";
export const nativeDatabaseModule = requireOptionalNativeModule<{
  sessionProtocol?: number;
  prepare(html: string): Promise<void>;
  warm(): Promise<void>;
  diagnostics(): Promise<{
    created: number;
    destroyed: number;
    active: number;
    idle: number;
  }>;
  invalidate(workspace: string, instance: string): Promise<void>;
}>("MetahubDatabase");
let prepared: Promise<void> | undefined;
export function prepareDatabaseSurface() {
  if (!nativeDatabaseModule)
    return Promise.reject(new Error("原生数据表宿主不可用"));
  return (prepared ??= nativeDatabaseModule
    .prepare(databaseHTML.replace("__METAHUB_BOOTSTRAP__", "null"))
    .catch((e) => {
      prepared = undefined;
      throw e;
    }));
}
export async function warmDatabaseSurface() {
  if (databaseBenchmarkBaseline || nativeDatabaseModule?.sessionProtocol !== 2)
    return;
  await prepareDatabaseSurface();
  await nativeDatabaseModule.warm();
}
export function invalidateDatabaseRuntime(workspace: string, instance: string) {
  void nativeDatabaseModule?.invalidate(workspace, instance).catch(() => {});
}
export const reusesDatabaseRuntime =
  !databaseBenchmarkBaseline && nativeDatabaseModule?.sessionProtocol === 2;

export async function databaseRuntimeDiagnostics() {
  return nativeDatabaseModule?.diagnostics();
}
