// Lazy loader for the format provider bundles. The specifier is a runtime
// variable, so Bun.build leaves the dynamic import() as-is in webui.js — the
// browser resolves the route against the page origin and the server serves the
// separately-built bundle (see manifest.ts for who else consumes the routes).
// The promise (not the module) is cached so concurrent first clicks share one
// fetch; a rejected load is evicted so a transient offline failure can retry.

import type { ProviderEngine } from "./lang-map.ts";
import { fmtProvider } from "./manifest.ts";
import { apiUrl } from "../api.ts";

/** Every provider bundle exports this shape. */
export interface FmtModule {
  format(code: string, lang: string, cursor: number): Promise<{ text: string; cursor: number }>;
}

const inflight = new Map<string, Promise<FmtModule>>();

export function loadProvider(id: ProviderEngine): Promise<FmtModule> {
  let p = inflight.get(id);
  if (!p) {
    const route = fmtProvider(id)?.js;
    if (!route) return Promise.reject(new Error(`unknown format provider: ${id}`));
    // apiUrl: identity on HTTP surfaces; on the desktop's file:// file-editor
    // window it resolves the route against the sidecar origin once attached.
    p = (import(apiUrl(route)) as Promise<FmtModule>).catch((e) => {
      inflight.delete(id);
      throw new Error(`格式化组件加载失败(离线?):${(e as Error)?.message ?? e}`);
    });
    inflight.set(id, p);
  }
  return p;
}
