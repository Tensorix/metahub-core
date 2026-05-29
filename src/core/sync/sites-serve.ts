import type { RouteCtx } from "./routes.ts";
import { resolveSite, getFileForServe } from "../sites.ts";

// Serves agent-published sites at /sites/<name>/<path...>. Imported lazily from
// server.ts so it stays off the CLI startup path. Returns null only for paths it
// does not own (so the caller can fall through to 404). HTML responses get the
// auth fetch-shim injected by the caller (server.ts withShim) in non-debug mode.

export async function serveSite(req: Request, ctx: RouteCtx): Promise<Response | null> {
  const url = new URL(req.url);
  const rest = url.pathname.slice("/sites/".length);
  if (rest === "") return null; // /sites/ with no site name

  const slash = rest.indexOf("/");
  const name = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));

  // /sites/<name> → canonical /sites/<name>/ so relative asset URLs resolve.
  if (slash === -1) return Response.redirect(`${url.origin}/sites/${name}/`, 301);

  const filePath = decodeURIComponent(rest.slice(slash + 1));

  let siteId: string;
  try {
    siteId = resolveSite(ctx.db, name).id;
  } catch {
    return new Response("site not found", { status: 404 });
  }

  const file = await getFileForServe(ctx.db, siteId, filePath);
  if (!file) return new Response("not found", { status: 404 });
  return new Response(file.bytes as BodyInit, { headers: { "content-type": file.contentType } });
}
