import {
  parseShareFragment,
  validDescriptor,
} from "../../core/sync/share-link.ts";

export async function loadShareLink(
  url: URL,
  fetcher: typeof fetch = fetch,
): Promise<{ m?: string; k?: string; s?: string }> {
  const fragment = parseShareFragment(url.hash);
  if (fragment.m) return fragment; // Old links never need the API.
  const match = /^\/s\/([A-Za-z0-9_-]{22})\/?$/.exec(url.pathname);
  if (!match) return fragment;
  const response = await fetcher(`${url.origin}/api/links/${match[1]}`, {
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("share_unavailable");
  const descriptor: unknown = await response.json();
  if (!validDescriptor(descriptor) || descriptor.expiresAt <= Date.now())
    throw new Error("share_unavailable");
  return { m: descriptor.manifestUrl, k: fragment.k, s: descriptor.salt };
}
