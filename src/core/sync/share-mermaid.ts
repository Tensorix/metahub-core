import { render } from "pele";
import { escapeHtml } from "./html-escape.ts";
import type { Locale } from "./locale.ts";
import { pm } from "./page-messages.ts";

let diagramNumber = 0;

/** A self-contained reading view. Only Pele's SVG is trusted as markup. The
 * original code remains available for inspection and the rich clipboard. */
export function renderMermaid(source: string, locale: Locale, maxWidth?: number): string {
  const code = `<pre><code class="language-mermaid">${escapeHtml(source)}</code></pre>`;
  if (!source.trim()) {
    return `<figure class="mh-mermaid mh-mermaid-empty"><figcaption>${pm(locale, "空的 Mermaid 图表")}</figcaption>${code}</figure>`;
  }
  try {
    const { svg } = render(source, {
      idPrefix: `mh-read-${++diagramNumber}`,
      links: false,
      images: false,
      maxWidth,
      // Preserve a legible natural scale. Wide diagrams scroll inside their block.
      responsive: false,
    });
    return `<figure class="mh-mermaid"><div class="mh-mermaid-diagram">${svg}</div><details><summary>${pm(locale, "Mermaid 源码")}</summary>${code}</details></figure>`;
  } catch {
    return `<figure class="mh-mermaid"><figcaption>${pm(locale, "无法渲染 Mermaid 图表")}</figcaption>${code}</figure>`;
  }
}
