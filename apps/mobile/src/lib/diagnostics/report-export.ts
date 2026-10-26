/** Explicit synthetic diagnostic builds only. Never reads sessions, credentials or workspace data. */
import { File, Paths } from "expo-file-system";
const url = "http://127.0.0.1:8992";
const headers = { authorization: "Bearer native-network-stress-local-only", "content-type": "application/json" };
async function request(path: string, body?: unknown) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url + path, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
    if (!response.ok) throw new Error("Diagnostic report HTTP " + response.status);
    return await response.json();
  } finally { clearTimeout(timer); }
}
export async function exportDiagnosticReports(startedAt: number, driver: unknown) {
  const marker = await request("/fixture");
  if (marker.fixture !== "metahub-isolated-native-network-v1" || marker.isolated !== true) throw new Error("Not the isolated report fixture");
  await request("/fixture/reports", { kind: "driver", report: driver });
  for (const [kind, name] of [["network", "native-network-stress.json"], ["performance", "native-performance.json"]]) {
    const file = new File(Paths.document, name!);
    if (!file.exists) continue;
    const report = JSON.parse(await file.text());
    if (report.environment?.artifactClass !== "synthetic-native-diagnostics" || Date.parse(report.measurementStartedAt) < startedAt) continue;
    await request("/fixture/reports", { kind, report });
  }
}
