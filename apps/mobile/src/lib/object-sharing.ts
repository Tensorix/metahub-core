import { File } from "expo-file-system";
import * as Crypto from "expo-crypto";
import type { Session } from "./auth/session";
import { setBlobBytesResolver } from "../../../../src/core/blobs-core";
import type { DbDriver } from "../../../../src/core/driver";
import {
  createBucketShare,
  listBucketShares,
  represignBucketShare,
  deleteBucketShareObjects,
} from "../../../../src/core/sync/share-export";
import { bucketShareUrl } from "../../../../src/core/sync/share-short-links";

export interface ObjectShare {
  slug: string;
  url?: string;
  expiresAt: number | null;
  hasPassword: boolean;
}
const owners = new WeakMap<DbDriver, Session>();
setBlobBytesResolver(async (db, hash) => {
  const owner = owners.get(db);
  if (!owner?.isCurrent()) throw new Error("工作区会话已结束");
  await owner.attachments.cache("/blob/" + hash);
  const row = db
    .query("SELECT uri FROM mobile_attachments WHERE hash=?")
    .get(hash) as { uri: string } | null;
  if (!row) throw new Error("附件尚未下载，无法创建完整分享");
  return new File(row.uri).bytes();
});
const viewer = "https://share.mh.tensorix.org";
export function objectSharing(
  session: Session,
  kind: "doc" | "database",
  id: string,
) {
  const current = () => {
    if (!session.isCurrent()) throw new Error("工作区会话已结束");
  };
  const config = session.creds.bucket;
  let requestId = Crypto.randomUUID();
  let requestSignature = "";
  owners.set(session.replica.db, session);
  return {
    snapshot: !!config,
    async list(): Promise<ObjectShare[]> {
      current();
      if (config)
        return (await listBucketShares(config))
          .filter((s) => s.target_id === id && s.kind === kind)
          .map((s) => ({
            slug: s.slug,
            expiresAt: s.presign_exp,
            hasPassword: s.has_password,
          }));
      return session.api.req(
        "GET",
        "/api/shares?target=" + encodeURIComponent(id),
      );
    },
    async create(
      password: string,
      days: number,
      permission: "view" | "edit" = "view",
    ): Promise<ObjectShare> {
      current();
      if (![1, 7].includes(days)) throw new Error("分享有效期不正确");
      if (config && permission !== "view")
        throw new Error("存储桶快照仅支持只读分享");
      const signature = JSON.stringify([password, days, permission]);
      if (signature !== requestSignature) {
        requestId = Crypto.randomUUID();
        requestSignature = signature;
      }
      if (config) {
        const slug = Crypto.randomUUID().replace(/-/g, "");
        const out = await createBucketShare(session.replica.db, {
          slug,
          kind,
          targetId: id,
          config,
          password: password || null,
          expiresSec: days * 86400,
          viewerOrigin: viewer,
        });
        current();
        return {
          slug,
          url: await bucketShareUrl(config, slug, viewer, out),
          expiresAt: out.presignExp,
          hasPassword: !!password,
        };
      }
      await session.syncNow();
      current();
      const status = session.sync.status;
      if (
        status.error ||
        status.pendingPush ||
        status.syncing ||
        !status.connected
      )
        throw new Error(
          status.error || "修改尚未同步到服务器，请同步完成后再分享",
        );
      const result = await session.api.req<ObjectShare>("POST", "/api/share", {
        kind,
        ref: id,
        permission,
        transport: "server",
        password: password || null,
        expiresMs: days * 86400000,
        requestId,
      });
      requestId = Crypto.randomUUID();
      return { ...result, hasPassword: !!password };
    },
    async url(item: ObjectShare): Promise<string> {
      current();
      if (!config && item.expiresAt !== null && item.expiresAt <= Date.now())
        throw new Error("分享已过期，请创建新链接");
      if (item.url && !config) return item.url;
      if (config) {
        const out = await represignBucketShare(config, item.slug);
        current();
        return bucketShareUrl(config, item.slug, viewer, out);
      }
      const result = await session.api.req<{ url: string }>(
        "POST",
        "/api/share/renew?slug=" + encodeURIComponent(item.slug),
      );
      return result.url;
    },
    async revoke(item: ObjectShare) {
      current();
      if (config) {
        await deleteBucketShareObjects(config, item.slug);
        return;
      }
      const result = await session.api.req<{ status: string }>(
        "DELETE",
        "/api/share/managed?slug=" + encodeURIComponent(item.slug),
      );
      if (result.status === "cleanup_pending")
        throw new Error("撤销尚未完成，请重试");
    },
  };
}
