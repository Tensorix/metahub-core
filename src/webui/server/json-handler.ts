import { errorResponse, type Route, type RouteCtx } from "../../core/sync/routes.ts";

/** Consistent JSON/error envelope for WebUI routes. */
export function jsonHandler(
  fn: (req: Request, ctx: RouteCtx) => unknown,
): Route["handler"] {
  return async (req, ctx) => {
    try {
      return Response.json((await fn(req, ctx)) ?? null);
    } catch (e) {
      return errorResponse(e);
    }
  };
}
