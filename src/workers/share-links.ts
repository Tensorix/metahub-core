import {
  linkId,
  tokenHash,
  SHARE_LINK_ID,
  SHARE_LINK_TOKEN,
  SHARE_LINK_MAX_BODY,
  validDescriptor,
  type ShareLinkDescriptor,
} from "../core/sync/share-link.ts";

// Small injectable D1 surface; the same SQL is exercised with bun:sqlite.
export interface ShareLinkSql {
  first<T>(sql: string, ...args: unknown[]): Promise<T | null>;
  run(sql: string, ...args: unknown[]): Promise<void>;
}
interface Row {
  descriptor: string;
  owner_hash: string;
  version: number;
  revoked: number;
  expires_at: number;
}

export function createShareLinksHandler(sql: ShareLinkSql, now = Date.now) {
  return async (req: Request): Promise<Response> => {
    const headers = {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, PUT, DELETE, OPTIONS",
      "access-control-allow-headers":
        "Content-Type, Authorization, If-Match, If-None-Match",
      "access-control-expose-headers": "ETag",
    };
    const json = (body: unknown, status = 200, extra = {}) =>
      Response.json(body, { status, headers: { ...headers, ...extra } });
    const fail = (status: number, error: string) => json({ error }, status);
    if (req.method === "OPTIONS")
      return new Response(null, { status: 204, headers });
    if (req.method === "GET" && new URL(req.url).pathname === "/api/links")
      return json({ service: "metahub-share-links", v: 1 });
    const match = /^\/api\/links\/([A-Za-z0-9_-]{22})$/.exec(
      new URL(req.url).pathname,
    );
    if (!match || !SHARE_LINK_ID.test(match[1]!)) return fail(404, "not_found");
    const id = match[1]!;
    if (!["GET", "PUT", "DELETE"].includes(req.method))
      return fail(405, "method_not_allowed");
    try {
      if (req.method === "GET") {
        const row = await sql.first<Row>(
          "SELECT * FROM share_links WHERE id = ?",
          id,
        );
        if (!row) return fail(404, "not_found");
        const ownerToken =
          req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        const owner =
          SHARE_LINK_TOKEN.test(ownerToken) &&
          (await tokenHash(ownerToken)) === row.owner_hash;
        if (row.revoked || (!owner && row.expires_at <= now()))
          return fail(410, "expired_or_revoked");
        return json(JSON.parse(row.descriptor), 200, {
          ETag: `"${row.version}"`,
        });
      }
      const token =
        req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (!SHARE_LINK_TOKEN.test(token) || (await linkId(token)) !== id)
        return fail(401, "unauthorized");
      const ownerHash = await tokenHash(token);
      const row = await sql.first<Row>(
        "SELECT * FROM share_links WHERE id = ?",
        id,
      );
      if (row && row.owner_hash !== ownerHash) return fail(401, "unauthorized");
      if (req.method === "DELETE") {
        // Keep a tombstone so an in-flight update cannot resurrect a revoked link.
        await sql.run(
          "INSERT INTO share_links (id, owner_hash, descriptor, expires_at, revoked) VALUES (?, ?, '{}', ?, 1) ON CONFLICT(id) DO UPDATE SET revoked = 1, descriptor = '{}', version = version + 1 WHERE owner_hash = excluded.owner_hash",
          id,
          ownerHash,
          now() + 604800_000,
        );
        return json({ ok: true });
      }
      if (row?.revoked) return fail(410, "revoked");
      if (
        !(req.headers.get("content-type") ?? "").startsWith("application/json")
      )
        return fail(415, "json_required");
      // Bound the streaming body too: Content-Length is not trustworthy.
      const reader = req.body?.getReader();
      if (!reader) return fail(400, "invalid_body");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > SHARE_LINK_MAX_BODY) {
          await reader.cancel();
          return fail(413, "body_too_large");
        }
        chunks.push(chunk.value);
      }
      let descriptor: ShareLinkDescriptor;
      try {
        descriptor = JSON.parse(await new Blob(chunks as BlobPart[]).text());
      } catch {
        return fail(400, "invalid_body");
      }
      if (
        !validDescriptor(descriptor) ||
        descriptor.expiresAt <= now() ||
        descriptor.expiresAt > now() + 604800_000
      )
        return fail(400, "invalid_descriptor");
      if (row) {
        // Cloudflare compression may weaken the ETag. It still identifies the
        // same database revision, independent of the response encoding.
        if (req.headers.get("if-match")?.replace(/^W\//, "") !== `"${row.version}"`)
          return fail(409, "version_conflict");
        const updated = await sql.first<{ version: number }>(
          "UPDATE share_links SET descriptor = ?, expires_at = ?, version = version + 1 WHERE id = ? AND owner_hash = ? AND version = ? AND revoked = 0 RETURNING version",
          JSON.stringify(descriptor),
          descriptor.expiresAt,
          id,
          ownerHash,
          row.version,
        );
        if (!updated) return fail(409, "version_conflict");
        return json({ ok: true }, 200, { ETag: `"${updated.version}"` });
      }
      if (req.headers.get("if-none-match") !== "*")
        return fail(409, "version_conflict");
      // Public registration is deliberately bounded; no shared secret in clients.
      const hour = Math.floor(now() / 3600_000);
      const day = Math.floor(now() / 86400_000);
      const ip = req.headers.get("cf-connecting-ip") ?? "local";
      for (const [scope, limit] of [
        [`ip:${await tokenHash(ip)}:${hour}`, 60],
        [`day:${day}`, 1000],
      ] as const) {
        const count = await sql.first<{ hits: number }>(
          "INSERT INTO share_link_limits (scope, hits, expires_at) VALUES (?, 1, ?) ON CONFLICT(scope) DO UPDATE SET hits = hits + 1 WHERE hits < ? RETURNING hits",
          scope,
          now() + 2 * 86400_000,
          limit,
        );
        if (!count) return fail(429, "registration_limit");
      }
      const inserted = await sql.first<{ version: number }>(
        "INSERT INTO share_links (id, owner_hash, descriptor, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING version",
        id,
        ownerHash,
        JSON.stringify(descriptor),
        descriptor.expiresAt,
      );
      if (!inserted) return fail(409, "version_conflict");
      // Bounded housekeeping on registration; no cron or per-read writes needed.
      await sql.run(
        "DELETE FROM share_link_limits WHERE scope IN (SELECT scope FROM share_link_limits WHERE expires_at < ? LIMIT 100)",
        now(),
      );
      await sql.run(
        "DELETE FROM share_links WHERE id IN (SELECT id FROM share_links WHERE expires_at < ? LIMIT 100)",
        now() - 30 * 86400_000,
      );
      return json({ ok: true }, 201, { ETag: '"1"' });
    } catch {
      // Never include database errors, URLs, or credentials in responses/logs.
      return fail(503, "temporarily_unavailable");
    }
  };
}
