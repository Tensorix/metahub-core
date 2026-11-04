import type { DbDriver } from "../../../../../src/core/driver.ts";
import {
  listSites,
  isSitePublic,
  getFileRow,
} from "../../../../../src/core/sites-core.ts";
import { listSiteChannelRows } from "../../../../../src/core/site-channel-store.ts";
export function safeSiteUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
/** Use explicitly published public channels only; never forward workspace credentials. */
export function mobileSites(db: DbDriver, serverUrl?: string) {
  const channels = listSiteChannelRows(db);
  return listSites(db).map((site) => {
    const channel = channels.find(
      (c) =>
        c.site_id === site.id &&
        c.audience === "public" &&
        c.desired_state === "active" &&
        safeSiteUrl(c.canonical_url),
    );
    const origin = serverUrl && safeSiteUrl(serverUrl);
    const url = channel
      ? safeSiteUrl(channel.canonical_url)
      : origin && isSitePublic(site)
        ? new URL(`/sites/${encodeURIComponent(site.name)}/`, origin).href
        : null;
    const favicon = getFileRow(db, site.id, "favicon.png");
    const iconUri =
      favicon?.encoding === "base64" &&
      favicon.content &&
      favicon.content.length < 200_000 &&
      /^image\/png(?:;|$)/.test(favicon.content_type)
        ? `data:image/png;base64,${favicon.content}`
        : undefined;
    return {
      iconUri,
      id: site.id,
      title: site.title || site.name,
      name: site.name,
      url,
    };
  });
}
export type MobileSite = ReturnType<typeof mobileSites>[number];
