/** Explicit synthetic diagnostic builds only. Never reads user workspaces. */
import { File, Paths } from "expo-file-system";
import { createDiagnosticReportExporter } from "./report-export-policy";
const url = "http://127.0.0.1:8992";
const headers = {
  authorization: "Bearer native-network-stress-local-only",
  "content-type": "application/json",
};
async function request(path: string, body?: unknown) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url + path, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error("Diagnostic report HTTP " + response.status);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}
export function createNativeDiagnosticReportExporter(startedAt: number) {
  return createDiagnosticReportExporter({
    runStartedAt: startedAt,
    async verifyFixture() {
      const marker = await request("/fixture");
      if (
        marker.fixture !== "metahub-isolated-native-network-v1" ||
        marker.isolated !== true
      )
        throw new Error("Not the isolated report fixture");
    },
    async readReport(kind) {
      const file = new File(
        Paths.document,
        kind === "network"
          ? "native-network-stress.json"
          : "native-performance.json",
      );
      return file.exists ? JSON.parse(await file.text()) : undefined;
    },
    async post(kind, report) {
      await request("/fixture/reports", { kind, report });
    },
  });
}
