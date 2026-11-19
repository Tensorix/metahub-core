import type { DatabaseToolbarAction, DatabaseToolbarFrame, DatabaseToolbarSettings } from "../../shared/views/database-source";

// Keep the native controls aligned with the WebView's layout and editor anchors.
export function observeGlassToolbar(bar: HTMLElement, show: (frame: DatabaseToolbarFrame | null) => Promise<void>,
  readSettings: () => DatabaseToolbarSettings) {
  let raf = 0;
  let previous: string | undefined;
  let version = 0;
  const measure = () => {
    raf = 0;
    const rect = bar.getBoundingClientRect();
    const buttons = Array.from(bar.querySelectorAll<HTMLButtonElement>("button[data-action]"));
    const filterOpen = buttons[0]?.getAttribute("aria-expanded") === "true";
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const menuAbove = hit?.matches(".menu-layer") && hit.querySelector(".toolbar-menu:not(.filter-menu)");
    const visible = rect.width > 0 && buttons.length > 0 && !filterOpen &&
      (menuAbove || (!bar.closest("[inert]") && (bar.contains(hit) || hit === bar.parentElement)));
    const frame: DatabaseToolbarFrame | null = visible ? {
      left: rect.left, bottom: innerHeight - rect.bottom, width: rect.width, height: rect.height,
      ...readSettings(), coveredByMenu: !!menuAbove,
      actions: buttons.map(button => {
        const bounds = button.getBoundingClientRect();
        return {
          action: button.dataset.action as DatabaseToolbarAction, width: bounds.width,
          label: button.querySelector(".filter-label, .tool-label")?.textContent ?? "",
          count: button.querySelector(".tb-n")?.textContent ?? "", active: button.classList.contains("on") || button.getAttribute("aria-expanded") === "true",
        };
      }),
    } : null;
    const key = JSON.stringify(frame);
    if (key === previous) return;
    previous = key;
    const revision = ++version;
    if (!frame) bar.classList.remove("native-glass");
    void show(frame).then(() => {
      if (revision === version) bar.classList.toggle("native-glass", !!frame);
    }).catch(() => {
      if (revision === version) {
        previous = undefined;
        bar.classList.remove("native-glass");
      }
    });
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
  const mutations = new MutationObserver(schedule);
  mutations.observe(bar, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "aria-expanded"] });
  for (let el = bar.parentElement; el; el = el.parentElement)
    mutations.observe(el, { childList: true, attributes: true, attributeFilter: ["inert"] });
  const resize = new ResizeObserver(schedule);
  resize.observe(bar);
  bar.addEventListener("toolbar-settings", schedule);
  window.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
  schedule();
  return () => {
    version++;
    cancelAnimationFrame(raf);
    mutations.disconnect();
    resize.disconnect();
    bar.removeEventListener("toolbar-settings", schedule);
    window.removeEventListener("resize", schedule);
    window.visualViewport?.removeEventListener("resize", schedule);
    bar.classList.remove("native-glass");
    void show(null).catch(() => {});
  };
}
