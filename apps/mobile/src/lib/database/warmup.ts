export function warmDatabaseSurface(): Promise<void> {
  return Promise.resolve();
}
export function invalidateDatabaseRuntime(
  _workspace: string,
  _instance: string,
) {}
export const reusesDatabaseRuntime = false;

export async function databaseRuntimeDiagnostics() {
  return null;
}
