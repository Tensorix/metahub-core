import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import {
  getEdgeConfig,
  setEdgeConfig,
  setEdgeDeployProgress,
  getEdgeDeployProgress,
} from "./edge-config.ts";

function db(): Database {
  const d = new Database(":memory:");
  runSchema(d);
  return d;
}

describe("Edge configuration secret handling", () => {
  test("persists resource ids but never accepts a Cloudflare API token", () => {
    const d = db();
    setEdgeConfig(d, {
      endpoint: "https://edge.example",
      token: "drt_owner",
      cf: { accountId: "a", workerName: "w", d1Id: "d" },
    });
    expect(getEdgeConfig(d)?.cf).toEqual({ accountId: "a", workerName: "w", d1Id: "d" });
    expect(
      (
        d.query("SELECT value FROM meta WHERE key='edge_config'").get() as { value: string }
      ).value,
    ).not.toContain("apiToken");
    expect(() =>
      setEdgeConfig(d, {
        endpoint: "https://edge.example",
        token: "drt_owner",
        cf: {
          accountId: "a",
          workerName: "w",
          d1Id: "d",
          apiToken: "secret",
        } as never,
      }),
    ).toThrow("must not be persisted");
  });

  test("migrates a legacy persisted API token away on read", () => {
    const d = db();
    d.query("INSERT INTO meta (key,value) VALUES ('edge_config',?)").run(
      JSON.stringify({
        endpoint: "https://edge.example",
        token: "drt_owner",
        cf: { accountId: "a", workerName: "w", d1Id: "d", apiToken: "legacy-secret" },
      }),
    );
    expect(getEdgeConfig(d)?.cf).toEqual({ accountId: "a", workerName: "w", d1Id: "d" });
    const raw = (
      d.query("SELECT value FROM meta WHERE key='edge_config'").get() as { value: string }
    ).value;
    expect(raw).not.toContain("legacy-secret");
    expect(raw).not.toContain("apiToken");
  });

  test("keeps resumable progress without credentials", () => {
    const d = db();
    setEdgeDeployProgress(d, {
      accountId: "a",
      workerName: "metahub-edge-x",
      d1Name: "metahub-edge-x-db",
      d1Id: "uuid",
      step: "uploading_worker",
      updatedAt: 1,
    });
    expect(getEdgeDeployProgress(d)?.d1Id).toBe("uuid");
    expect(JSON.stringify(getEdgeDeployProgress(d))).not.toContain("token");
  });
});
