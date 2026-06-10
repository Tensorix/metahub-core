export * from "./core/index.js";
// WebUI server pieces (asset handler, data API routes, bundle injection).
// Exported from the package root — not from core — so embedders (desktop
// sidecar) can wire them into startServer's `ui` option; core stays UI-free.
export * from "./webui/server/assets.js";
export { webuiRoutes } from "./webui/server/routes.js";
