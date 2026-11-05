import type { ReplicaService } from "../../../../../src/core/replica/service";
import {
  getSite,
  resolveSiteFileRow,
} from "../../../../../src/core/sites-core";
import { mapApiRequest } from "../../../../../src/webui/data/api-map";
import { errorBody } from "../../../../../src/core/sync/http-status";
import { MhError } from "../../../../../src/core/errors";

export interface LocalReply {
  status: number;
  mime: string;
  text?: string;
  base64?: string;
  file?: string;
}
const allowed = new Set([
  "listDatabases",
  "listProperties",
  "search",
  "listRecords",
  "getRecord",
  "createRecord",
  "updateRecord",
  "deleteRecord",
  "listDocuments",
  "getDocument",
  "createDocument",
  "updateDocument",
  "deleteDocument",
]);
const json = (status: number, value: unknown): LocalReply => ({
  status,
  mime: "application/json",
  text: JSON.stringify(value ?? null),
});

export function serveLocalSite(
  service: ReplicaService,
  siteId: string,
  method: string,
  target: string,
  body: string,
  sdk: string,
  cachedFile: (hash: string) => string | null,
): LocalReply {
  try {
    const site = getSite(service.db, siteId);
    if (!site) throw new MhError("not_found", "站点已删除");
    const mount = "/sites/" + encodeURIComponent(site.name) + "/";
    if (
      !target.startsWith("/") ||
      target.startsWith("//") ||
      target.includes("\\")
    )
      throw new MhError("invalid_input", "invalid path");
    const url = new URL(target, "http://localhost");
    const path = url.pathname;
    const sub = path.startsWith(mount) ? path.slice(mount.length) : null;
    if (path.startsWith("/api/") || sub?.startsWith("api/")) {
      const data = body ? JSON.parse(body) : null;
      if (data !== null && (typeof data !== "object" || Array.isArray(data)))
        throw new MhError("invalid_input", "expected object");
      const call = mapApiRequest(
        method,
        sub === null ? path : "/" + sub,
        url.searchParams,
        data,
      );
      if (!call || !allowed.has(call.op))
        throw new MhError("not_found", "此接口不在本机站点开放范围内");
      return json(200, service.dispatchRpc(call.op, call.args));
    }
    if (method !== "GET" && method !== "HEAD")
      return json(405, { error: "method not allowed" });
    if (path === "/metahub-sdk.js")
      return { status: 200, mime: "application/javascript", text: sdk };
    if (sub === "mh-manifest.json" || path === "/mh-manifest.json")
      return json(200, {
        v: 1,
        mode: "live",
        runtimeEndpoint: "/",
        policyRevision: 0,
      });
    if (sub === null && path.startsWith("/sites/"))
      throw new MhError("not_found", "站点不存在");
    const filePath = decodeURIComponent(sub ?? path.slice(1));
    const result = resolveSiteFileRow(service.db, siteId, filePath, {
      spa: !!site.spa,
    });
    if (!result || result.row.content == null)
      throw new MhError("not_found", "站点文件尚未同步");
    const { content, encoding, content_type } = result.row;
    const reply = { status: result.status, mime: content_type };
    if (encoding === "utf8") return { ...reply, text: content };
    if (encoding === "base64") return { ...reply, base64: content };
    const file = cachedFile(content);
    if (!file) throw new MhError("not_found", filePath + " 尚未下载");
    return { ...reply, file };
  } catch (error) {
    const failure = errorBody(error);
    return json(failure.status, failure.body);
  }
}
