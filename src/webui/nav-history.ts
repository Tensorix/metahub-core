// Page back/forward state for the desktop topbar buttons. The actions are
// plain history.back()/forward() — the router's hashchange listener in app.tsx
// already handles traversals, so navigate() stays the single push-side writer.
//
// canGoBack/canGoForward come from the Chromium Navigation API: unlike a
// hand-rolled history.state index, it counts every entry source correctly —
// pushState in navigate(), replaceState (peek deep links), and the direct
// `location.hash = …` writers (settings/share-modal/cm6 doclinks), whose new
// entries *clone* the previous entry's classic state and would fool any
// state-stamping scheme. The buttons only render when window.metahubDesktop
// exists, i.e. under Electron's Chromium (≥ 102), so the API is always there;
// plain browsers fall back to {false, false} and render nothing anyway.
import { useEffect, useState } from "preact/hooks";

// window.navigation isn't in lib.dom yet — keep a minimal local shape instead
// of a global augment.
interface NavigationLite {
  canGoBack: boolean;
  canGoForward: boolean;
  addEventListener(type: "currententrychange", cb: () => void): void;
  removeEventListener(type: "currententrychange", cb: () => void): void;
}

const nav = (): NavigationLite | undefined =>
  typeof window === "undefined" ? undefined : (window as any).navigation;

const read = () => {
  const n = nav();
  return { canGoBack: !!n?.canGoBack, canGoForward: !!n?.canGoForward };
};

export function useHistoryNav(): { canGoBack: boolean; canGoForward: boolean } {
  const [state, setState] = useState(read);
  useEffect(() => {
    const n = nav();
    if (!n) return;
    const on = () => setState(read());
    n.addEventListener("currententrychange", on);
    return () => n.removeEventListener("currententrychange", on);
  }, []);
  return state;
}

export const goBack = () => history.back();
export const goForward = () => history.forward();
