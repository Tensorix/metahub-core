// Browser-only initializer. Kept in JS so the server library does not import
// DOM globals into its TypeScript environment. The function is serialized for SSR.
/** @param {{copied: string, failed: string, record: string}} labels */
export function mountShareTable(labels) {
  const table = document.querySelector("table.share-table");
  const peek = document.querySelector(".share-text-peek");
  if (!table || !peek || typeof peek.showModal !== "function")
    return;
  const heading = peek.querySelector("h2");
  const record = peek.querySelector(".share-text-record");
  const body = peek.querySelector(".share-text-body");
  const feedback = peek.querySelector(".share-text-feedback");
  let restore = null;
  let selected = null;
  const select = (cell) => {
    selected?.classList.remove("is-selected");
    selected = cell;
    cell.classList.add("is-selected");
  };
  const measure = (value) => {
    const button = value.parentElement.querySelector(".share-cell-expand");
    button.hidden = !(value.scrollHeight > value.clientHeight + 1 || value.scrollWidth > value.clientWidth + 1);
  };
  table.dataset.ready = "";
  const values = Array.from(table.querySelectorAll(".share-cell-value"));
  const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver((entries) => {
    for (const entry of entries)
      measure(entry.target);
  }) : null;
  for (const value of values) {
    measure(value);
    observer?.observe(value);
    value.addEventListener("input", () => measure(value));
    value.addEventListener("blur", () => requestAnimationFrame(() => measure(value)));
  }
  document.fonts?.ready.then(() => values.forEach(measure));
  table.addEventListener("click", (event) => {
    const target = event.target;
    const cell = target.closest("td");
    if (!cell)
      return;
    select(cell);
    const button = target.closest(".share-cell-expand");
    if (!button)
      return;
    const column = Array.from(cell.parentElement.children).indexOf(cell);
    heading.textContent = table.querySelectorAll("thead th")[column].textContent;
    record.textContent = cell.parentElement.querySelector(".share-cell-value")?.textContent || labels.record;
    body.textContent = cell.querySelector(".share-cell-value").textContent;
    feedback.textContent = "";
    restore = button;
    peek.showModal();
    body.scrollTop = 0;
  });
  peek.querySelector(".share-text-close").addEventListener("click", () => peek.close());
  peek.addEventListener("click", (event) => {
    const rect = peek.getBoundingClientRect();
    if (event.target === peek && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom))
      peek.close();
  });
  peek.addEventListener("close", () => restore?.focus({ preventScroll: true }));
  peek.querySelector(".share-text-copy").addEventListener("click", async () => {
    const text = body.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      feedback.textContent = labels.copied;
    } catch {
      const input = document.createElement("textarea");
      input.value = text;
      input.readOnly = true;
      input.style.cssText = "position:fixed;opacity:0;top:0;left:0";
      peek.append(input);
      input.select();
      try {
        feedback.textContent = document.execCommand("copy") ? labels.copied : labels.failed;
      } catch {
        feedback.textContent = labels.failed;
      }
      input.remove();
      peek.querySelector(".share-text-copy").focus();
    }
  });
}
