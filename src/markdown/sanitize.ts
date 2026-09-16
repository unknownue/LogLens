/**
 * HTML 清洗（浏览器侧）—— 渲染管线里 `sanitize` 一步的真实实现。
 *
 * 为什么必须有它：这个视图渲染的是**别人写的文件**。WebView 里的一次 XSS 不只是
 * 「页面被改了」—— 它同时握有 `window.__TAURI_INTERNALS__`（可以调后端命令、
 * 读写文件）。CSP 已经挡住了外链脚本与内联脚本，但事件属性、`javascript:` URL、
 * CSS 注入这类口子要靠白名单清洗，不能靠 CSP。
 *
 * 单独成文件（而不是写在 `markdown.ts` 里）的原因是 DOMPurify 依赖真实 DOM：
 * 管线本身要保持「Node 可单测」，所以它把清洗当成注入的一步。
 */

import DOMPurify from "dompurify";

/**
 * 会被整段丢弃的标签。
 *
 * - `style` / `link` / `meta` / `base`：一条 `body { display: none }` 就能让整个应用
 *   变成白屏 —— 这是「显示别人的文档」不该拥有的能力；
 * - `iframe` / `frame` / `object` / `embed`：嵌入外部内容与本地文件的入口；
 * - `form`：文档里的表单在本应用里没有任何用途，却能被用来构造诱导性界面。
 */
const FORBIDDEN_TAGS = [
  "style",
  "link",
  "meta",
  "base",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "form",
];

/** 会被整条丢弃的属性（`srcset` 是绕过 `src` 白名单的经典旁路）。 */
const FORBIDDEN_ATTRS = ["srcset", "formaction", "ping", "autofocus"];

/**
 * 额外放行的标签：KaTeX 输出的 MathML 里那层 `<semantics><annotation>`。
 *
 * DOMPurify 的 MathML 白名单只有 `math/mrow/mi/…` 这些**排版**标签，没有
 * `semantics` / `annotation`。默认行为是「删标签、留文本」，于是：
 *   - 「复制公式」拿不到 LaTeX 源码（本来可以从 annotation 里取）；
 *   - 读屏软件的 LaTeX 注解回退没了。
 * 视觉上完全不受影响（那层本来就被 `.katex-mathml` 裁成 1px），所以很容易被漏掉 —— 
 * 这是查「公式复制不出来」时才发现的。
 */
const ADDED_TAGS = ["semantics", "annotation"];

/** 随 {@link ADDED_TAGS} 一起放行的属性（`annotation` 用 encoding 标明内容是 TeX 源码）。 */
const ADDED_ATTRS = ["encoding"];

/**
 * 清洗一段 Markdown 渲染出来的 HTML。
 *
 * 白名单策略是「按用途开档」：html（正文）+ svg（KaTeX 的伸缩括号/根号用内联 SVG）
 * + mathMl（KaTeX 的 MathML 部分，负责无障碍与「复制公式」）。
 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, mathMl: true },
    ADD_TAGS: ADDED_TAGS,
    ADD_ATTR: ADDED_ATTRS,
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: FORBIDDEN_ATTRS,
    // `data-md-*` 是本视图的交互契约（链接分流 / 图片占位），必须保留。
    ALLOW_DATA_ATTR: true,
  });
}
