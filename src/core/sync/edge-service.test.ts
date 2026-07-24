import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import { getEdgeConfig, getEdgeDeployProgress } from "./edge-config.ts";
import { deployEdge } from "./edge-service.ts";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function db(): Database {
  const d = new Database(":memory:");
  runSchema(d);
  d.query("INSERT INTO meta (key,value) VALUES ('node_id','node-edge-test')").run();
  return d;
}

function json(
  result: unknown,
  status = 200,
  errors?: { message: string }[],
): Response {
  return Response.json(
    { success: status >= 200 && status < 300, result, ...(errors ? { errors } : {}) },
    { status },
  );
}

function cloudflareStub(opts: {
  workerExists?: boolean;
  d1Exists?: boolean;
  failUploadOnce?: boolean;
  loseD1CreateResponseOnce?: boolean;
} = {}) {
  const state = {
    workerExists: opts.workerExists ?? false,
    d1Exists: opts.d1Exists ?? false,
    failUploadOnce: opts.failUploadOnce ?? false,
    loseD1CreateResponseOnce: opts.loseD1CreateResponseOnce ?? false,
    d1Creates: 0,
    uploads: 0,
    workerDeploymentId: null as string | null,
    d1CreatedAt: new Date().toISOString(),
    calls: [] as string[],
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    state.calls.push(`${method} ${url.pathname}`);

    if (method === "GET" && url.pathname.endsWith("/workers/scripts/metahub-edge-test/settings"))
      return state.workerExists
        ? json({
            bindings: state.workerDeploymentId
              ? [{ type: "plain_text", name: "MH_DEPLOYMENT_ID", text: state.workerDeploymentId }]
              : [],
          })
        : json(null, 404);
    if (method === "GET" && url.pathname.endsWith("/d1/database"))
      return json(
        state.d1Exists
          ? [
              {
                uuid: "d1-test-id",
                name: "metahub-edge-test-db",
                created_at: state.d1CreatedAt,
              },
            ]
          : [],
      );
    if (method === "POST" && url.pathname.endsWith("/d1/database")) {
      state.d1Creates++;
      state.d1Exists = true;
      state.d1CreatedAt = new Date().toISOString();
      if (state.loseD1CreateResponseOnce) {
        state.loseD1CreateResponseOnce = false;
        return json({ name: "metahub-edge-test-db" });
      }
      return json({ uuid: "d1-test-id", name: "metahub-edge-test-db" });
    }
    if (method === "GET" && url.pathname.endsWith("/d1/database/d1-test-id"))
      return state.d1Exists ? json({ uuid: "d1-test-id" }) : json(null, 404);
    if (method === "GET" && url.pathname.endsWith("/workers/subdomain"))
      return json({ subdomain: "account-subdomain" });
    if (method === "POST" && url.pathname.endsWith("/d1/database/d1-test-id/query"))
      return json([]);
    if (method === "PUT" && url.pathname.endsWith("/workers/scripts/metahub-edge-test")) {
      state.uploads++;
      if (state.failUploadOnce) {
        state.failUploadOnce = false;
        return json(null, 500, [{ message: "upload interrupted" }]);
      }
      const body = init?.body as FormData;
      const metadata = JSON.parse(await (body.get("metadata") as Blob).text()) as {
        bindings: { name: string; text?: string }[];
      };
      state.workerDeploymentId =
        metadata.bindings.find((x) => x.name === "MH_DEPLOYMENT_ID")?.text ?? null;
      state.workerExists = true;
      return json({});
    }
    if (
      method === "PUT" &&
      url.pathname.endsWith("/workers/scripts/metahub-edge-test/secrets")
    )
      return json({});
    if (
      method === "POST" &&
      url.pathname.endsWith("/workers/scripts/metahub-edge-test/subdomain")
    )
      return json({});
    throw new Error(`unexpected Cloudflare call: ${method} ${url.pathname}`);
  }) as typeof fetch;
  return state;
}

const input = {
  accountId: "account-test",
  apiToken: "cf-secret-must-not-persist",
  workerName: "metahub-edge-test",
  d1Name: "metahub-edge-test-db",
  confirmed: true,
};

describe("Edge deployment service", () => {
  test("creates resources, stores only resource ids, and returns the final URL", async () => {
    const d = db();
    const cf = cloudflareStub();
    const result = await deployEdge(d, input, "export default {fetch(){}}");

    expect(result.endpoint).toBe(
      "https://metahub-edge-test.account-subdomain.workers.dev",
    );
    expect(result.status).toBe("deployed");
    expect(result.d1Id).toBe("d1-test-id");
    expect(cf.d1Creates).toBe(1);
    expect(cf.uploads).toBe(1);
    expect(getEdgeConfig(d)?.cf).toEqual({
      accountId: "account-test",
      workerName: "metahub-edge-test",
      d1Id: "d1-test-id",
      d1Name: "metahub-edge-test-db",
      workersSubdomain: "account-subdomain",
      deploymentId: expect.stringMatching(/^edge_/),
    });
    expect(getEdgeDeployProgress(d)).toBeNull();
    const persisted = JSON.stringify(d.query("SELECT key,value FROM meta").all());
    expect(persisted).not.toContain(input.apiToken);
  });

  test("continues after a partial failure without creating a second D1", async () => {
    const d = db();
    const cf = cloudflareStub({ failUploadOnce: true });
    await expect(deployEdge(d, input, "first")).rejects.toThrow("upload interrupted");
    expect(getEdgeDeployProgress(d)?.step).toBe("uploading_worker");
    expect(getEdgeDeployProgress(d)?.d1Id).toBe("d1-test-id");

    const result = await deployEdge(
      d,
      { ...input, apiToken: "fresh-token-for-resume" },
      "second",
    );
    expect(result.d1Id).toBe("d1-test-id");
    expect(cf.d1Creates).toBe(1);
    expect(cf.uploads).toBe(2);
    expect(getEdgeDeployProgress(d)).toBeNull();
    expect(JSON.stringify(d.query("SELECT key,value FROM meta").all())).not.toContain(
      "fresh-token-for-resume",
    );
  });

  test("recovers a D1 created before its id could be persisted", async () => {
    const d = db();
    const cf = cloudflareStub({ loseD1CreateResponseOnce: true });
    await expect(deployEdge(d, input, "first")).rejects.toThrow(
      "returned no database id",
    );
    expect(getEdgeDeployProgress(d)?.step).toBe("creating_d1");
    expect(getEdgeDeployProgress(d)?.d1Id).toBeUndefined();

    const result = await deployEdge(d, { ...input, apiToken: "resume-token" }, "second");
    expect(result.d1Id).toBe("d1-test-id");
    expect(cf.d1Creates).toBe(1);
  });

  test("refuses to overwrite a same-name Worker it does not own", async () => {
    const d = db();
    const cf = cloudflareStub({ workerExists: true });
    await expect(deployEdge(d, input, "script")).rejects.toThrow(
      "already exists and is not owned",
    );
    expect(cf.d1Creates).toBe(0);
    expect(getEdgeConfig(d)).toBeNull();
  });
});

// ---- R2 sync-bucket provisioning ------------------------------------------------

import { provisionR2Bucket } from "./edge-service.ts";
import { getR2ProvisionProgress, setR2ProvisionProgress } from "./edge-config.ts";

function r2Stub(opts: { exists?: boolean } = {}) {
  const state = { exists: opts.exists ?? false, creates: 0, calls: [] as string[] };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    state.calls.push(`${method} ${url.pathname}`);
    if (method === "GET" && /\/r2\/buckets\/[^/]+$/.test(url.pathname))
      return state.exists ? json({ name: "x" }) : json(null, 404);
    if (method === "POST" && url.pathname.endsWith("/r2/buckets")) {
      state.creates++;
      state.exists = true;
      return json({ name: "x" });
    }
    return json(null, 404);
  }) as typeof fetch;
  return state;
}

describe("provisionR2Bucket", () => {
  const input = { accountId: "acct1", apiToken: "tok", bucketName: "my-bucket", confirmed: true };

  test("creates the bucket and returns endpoint + credentials walk; progress cleared", async () => {
    const d = db();
    const state = r2Stub();
    const r = await provisionR2Bucket(d, input);
    expect(r.status).toBe("created");
    expect(r.bucketName).toBe("my-bucket");
    expect(r.endpoint).toBe("https://acct1.r2.cloudflarestorage.com");
    expect(r.credentialsUrl).toContain("acct1");
    expect(state.creates).toBe(1);
    expect(getR2ProvisionProgress(d)).toBeNull();
  });

  test("foreign same-name bucket → conflict, nothing created", async () => {
    const d = db();
    const state = r2Stub({ exists: true });
    await expect(provisionR2Bucket(d, input)).rejects.toThrow(/already exists/);
    expect(state.creates).toBe(0);
  });

  test("crash resume: our own half-created bucket is adopted, not refused", async () => {
    const d = db();
    setR2ProvisionProgress(d, { accountId: "acct1", bucketName: "my-bucket", startedAt: 1 });
    const state = r2Stub({ exists: true });
    const r = await provisionR2Bucket(d, input);
    expect(r.status).toBe("adopted");
    expect(state.creates).toBe(0);
    expect(getR2ProvisionProgress(d)).toBeNull();
  });

  test("refuses without confirmation and with missing credentials", async () => {
    const d = db();
    r2Stub();
    await expect(provisionR2Bucket(d, { ...input, confirmed: false })).rejects.toThrow(/confirm/);
    await expect(provisionR2Bucket(d, { ...input, apiToken: " " })).rejects.toThrow(/required/);
  });

  test("default bucket name derives from the node id", async () => {
    const d = db();
    r2Stub();
    const r = await provisionR2Bucket(d, { ...input, bucketName: undefined });
    expect(r.bucketName).toMatch(/^metahub-sync-/);
  });
});
