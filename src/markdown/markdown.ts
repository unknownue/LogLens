/**
 * Markdown → HTML 渲染管线（**纯函数，不碰 DOM、不碰 Tauri**，因此可在 Node 里单测）。
 *
 * 拆成纯模块的原因有两个：
 * 1. 这里最容易出错的不是「渲染」而是「改写」—— 相对链接/图片的路径解析、标题锚点、
 *    代码块高亮、公式边界，都能用 `node --test` 直接断言 HTML 片段，比开浏览器点进点出
 *    可靠得多（见 `tools/verify-markdown.test.mjs`）；
 * 2. 清洗（DOMPurify）在无 DOM 的 Node 里根本不可用（`isSupported === false`），
 *    所以它被抽成**可注入的一步**：浏览器传 `DOMPurify.sanitize`，单测传桩函数。
 *
 * 页面（`src/views/MarkdownView.tsx`）只负责「拿到 HTML → 塞进容器 → 处理交互」。
 */

import hljs from "highlight.js/lib/common";
import { Marked } from "marked";

import { collectFootnotes, footnoteExtension, renderFootnoteSection, type FootnoteState } from "./footnotes.ts";
import { mathExtension } from "./math.ts";
import { baseName, hashOf, isMarkdownPath, isSchemeHref, resolveRelativePath } from "./paths.ts";

/** 大纲里的一条标题。 */
export interface MdHeading {
  /** 渲染到 `<h*>` 上的 id（供大纲跳转与 `#锚点` 链接使用）。 */
  id: string;
  /** 1–6。 */
  depth: number;
  /** 标题纯文本（已去标签）。 */
  text: string;
}

/** 渲染入参。 */
export interface MdRenderOptions {
  /**
   * HTML 清洗器：**必须注入**。浏览器侧传 `src/markdown/sanitize.ts` 的实现，
   * 单测传透传桩 —— 让「清洗是否生效」由浏览器 E2E 负责，而不是在 Node 里假装验过。
   */
  sanitize: (html: string) => string;
  /** 文档路径：相对链接与图片按它所在目录解析（缺省时相对路径保持原样）。 */
  docPath?: string;
}

/** 渲染结果。 */
export interface MdRenderResult {
  /** 已清洗、可直接 innerHTML 的 HTML。 */
  html: string;
  /** 大纲（按文档顺序）。 */
  outline: MdHeading[];
  /** 源码行数（右上角「总行数」位显示；与文本视图的语义一致）。 */
  lines: number;
  /** 实际渲染出来的脚注条数（0 = 没有脚注区）。 */
  footnotes: number;
}

// ==================== 转义 ====================

/** HTML 文本转义（自备一份：marked 不导出 escape，且这里只关心 5 个字符）。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 属性值转义（与文本转义同规则；单独命名是为了让调用点意图明确）。 */
const escapeAttr = escapeHtml;

// ==================== 标题 id（slug） ====================

/**
 * 标题文本 → 锚点 id。
 *
 * 保留中日韩字符（中文标题直接用汉字作 id 更可读），空格转 `-`，丢掉 Markdown/HTML
 * 里的标点；纯标点标题退化成 `section`（由 {@link uniqueId} 保证唯一）。
 */
export function slugifyHeading(text: string): string {
  const cleaned = text
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[*_~]/g, "")
    .replace(/<[^>]*>/g, "")
    // 脚注引用：`# 概览[^n]` 的 id 应该是 `概览`，带上 id 会得到 `概览n` 这种谁也对不上的锚点
    .replace(/\[\^[^\]]+\]/g, "")
    .trim()
    .toLowerCase()
    // 先删标点、再把空白折成 `-`：反过来会把刚插入的连字符一起删掉
    // （`-` 落在 `!-/` 这个 ASCII 标点区间里）。
    .replace(/[!-/:-@[-`{-~。，、；：？！「」『』（）《》【】…—]/g, "")
    .replace(/[\s\u3000]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "section";
}

/** 同名标题追加 `-2` / `-3`，保证 id 唯一（否则大纲跳转会指错位置）。 */
function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  used.add(id);
  return id;
}

// ==================== 大纲提取 ====================

/**
 * 从**最终 HTML**（已清洗）里提取大纲。
 *
 * 为什么从 HTML 提而不是从 token 提：标题 id 由渲染器生成，从 HTML 反读能保证
 * 「大纲里的 id」与「页面上真实的 id」永远一致 —— 从 token 提就要自己维护
 * 「token 顺序 == 渲染顺序」这个隐式约定（列表/引用里的标题很容易打破它）。
 */
export function extractOutline(html: string): MdHeading[] {
  const outline: MdHeading[] = [];
  const headingRe = /<h([1-6])\s+id="([^"]*)"[^>]*>([\s\S]*?)<\/h\1>/g;
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(html)) !== null) {
    const text = match[3]
      // 标题里的「复制锚点」符号不属于标题文本
      .replace(/<a class="md-anchor"[\s\S]*?<\/a>/g, "")
      // 脚注角标同理：`# 概览[^n]` 的大纲条目应是「概览」，不是「概览1」
      .replace(/<sup class="md-footnote-ref">[\s\S]*?<\/sup>/g, "")
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
    outline.push({ id: match[2], depth: Number(match[1]), text });
  }
  return outline;
}

// ==================== 图片占位 ====================

/** 图片文件扩展名白名单（决定「点开图片」是交给系统还是忽略）。 */
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif"]);

/** 是否为可识别的图片路径。 */
export function isImagePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXT.has(ext);
}

/**
 * 图片容器 HTML：本地图片带一个**没有 src 的 `<img>`**，真实地址由页面用 Tauri 的
 * asset 协议（`convertFileSrc`）填 —— 渲染管线是纯函数、跑不了 Tauri API，
 * 而 asset 协议的 URL 形式（`http://asset.localhost/…`）属于运行环境细节，不该写进这里。
 *
 * 为什么仍然保留图标与路径文字：`<img>` 加载失败时（文件不存在、或路径在文档目录之外
 * 而没拿到 asset scope 授权）页面会把 `data-md-state` 置为 `missing`，
 * CSS 切回「图标 + 路径」的占位样式 —— 比一个破图标有用得多。
 *
 * 远程图片不做真实加载：CSP 的 `img-src` 只放行 `'self' data: asset:`；
 * 放行外网图片等于让「打开一个文档」产生对外的网络请求。
 */
function imagePlaceholder(raw: string, alt: string, docPath: string): string {
  const local = !isSchemeHref(raw);
  const resolved = local ? resolveRelativePath(docPath, raw) : raw;
  const label = alt.trim() || (local ? baseName(resolved) : raw);
  const real = local && isImagePath(resolved);
  const kind = local ? (real ? "file" : "path") : "url";
  const img = real
    ? `<img class="md-image-img" alt="${escapeAttr(label)}" data-md-path="${escapeAttr(resolved)}">`
    : "";
  return (
    `<span class="md-image" data-md-src="${escapeAttr(resolved)}" data-md-kind="${kind}">` +
    img +
    `<span class="md-image-body">` +
    `<span class="md-image-icon" aria-hidden="true">🖼</span>` +
    `<span class="md-image-alt">${escapeHtml(label)}</span>` +
    `<span class="md-image-src">${escapeHtml(resolved)}</span>` +
    `</span>` +
    `</span>`
  );
}

/** 原始 HTML 里的 `<img …>` 也换成同款占位符（否则 CSP 下只会剩下破图标）。 */
function rewriteRawImages(html: string, docPath: string): string {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (!src) {
      return "";
    }
    const alt = /\balt\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
    return imagePlaceholder(src[2] ?? src[3] ?? src[4] ?? "", alt?.[2] ?? alt?.[3] ?? "", docPath);
  });
}

/**
 * 丢掉**文档作者手写**的 HTML 里的 `style` 属性。
 *
 * 为什么要专门做这件事：公式排版完全依赖内联 style（上下标位置、分数线高度都由
 * KaTeX 按公式实例算出），所以样式表里那条 CSP 必须放行内联样式（见
 * `src-tauri/tauri.conf.json` 的 `dangerousDisableAssetCspModification`）。
 * 但放行的不该是「文档作者随便写」的那部分 —— 一个 `style="position:fixed;inset:0"`
 * 就能把整个界面盖住。这里把文档自带的 style 全部删掉，只留渲染器自己产出的那些
 * （KaTeX / 图片占位符），样式面收敛到「公式排版」这一件事上。
 *
 * 只处理原始 HTML token，不碰渲染器输出：KaTeX 的 HTML 不经过这里。
 * 注意正则要求 `style` 前是空白，因此 `data-style=` 这类属性名不会被误伤。
 */
function stripInlineStyles(html: string): string {
  return html.replace(/\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

// ==================== 渲染器 ====================

/** 代码块高亮：语言可识别时才着色，否则原样转义（避免高亮器猜错语言把代码染花）。 */
function renderCode(text: string, lang: string | undefined): string {
  const language = (lang ?? "").trim().split(/\s+/)[0];
  const langClass = language ? ` language-${escapeAttr(language)}` : "";
  const body =
    language && hljs.getLanguage(language)
      ? hljs.highlight(text, { language, ignoreIllegals: true }).value
      : escapeHtml(text);
  return `<pre class="md-pre"><code class="hljs${langClass}">${body}</code></pre>`;
}

/**
 * 用给定上下文构造一个 marked 实例。
 *
 * 每次渲染都新建实例（而不是模块级单例）：渲染器需要闭包持有「已用 id 集合」与
 * 「文档路径」，共享实例会在并发/连续渲染之间串状态。构造开销可忽略。
 */
function createMarked(docPath: string, usedIds: Set<string>, footnotes: FootnoteState): Marked {
  const marked = new Marked({ gfm: true, breaks: false });

  marked.use(mathExtension());
  marked.use(footnoteExtension(footnotes));
  marked.use({
    renderer: {
      heading({ tokens, depth, text }) {
        // slug 用 markdown 原文而不是渲染后的 HTML：标题里带公式时，HTML 会是一大段
        // KaTeX 标记，拿它做 id 只会得到不可读的乱码。
        const id = uniqueId(slugifyHeading(text), usedIds);
        const inner = this.parser.parseInline(tokens);
        return (
          `<h${depth} id="${escapeAttr(id)}">${inner}` +
          `<a class="md-anchor" href="#${escapeAttr(id)}" data-md-anchor="${escapeAttr(id)}" aria-label="anchor">¶</a>` +
          `</h${depth}>\n`
        );
      },
      code({ text, lang }) {
        return renderCode(text, lang);
      },
      link({ href, title, tokens }) {
        const label = this.parser.parseInline(tokens);
        const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
        // `#锚点`：交回同一篇文档内滚动
        if (href.startsWith("#")) {
          return `<a href="${escapeAttr(href)}"${titleAttr} data-md-anchor="${escapeAttr(hashOf(href))}">${label}</a>`;
        }
        // 外部 URL：交给系统浏览器（Tauri 里必须拦住，否则整个 WebView 会被导航走）
        if (isSchemeHref(href)) {
          return `<a href="${escapeAttr(href)}"${titleAttr} data-md-external="1">${label}</a>`;
        }
        // 相对路径：解析成绝对路径挂到 data 上，点击时按「.md 进新 tab / 其它交给系统」分流。
        // `other.md#sec` 的锚点单独挂一个 data-md-frag：路径解析会丢掉 fragment，
        // 但跨文档跳到某一节是文档站的基本用法，不能丢。
        const resolved = resolveRelativePath(docPath, href);
        const kind = isMarkdownPath(resolved) ? "doc" : "file";
        const fragment = hashOf(href);
        const fragAttr = fragment ? ` data-md-frag="${escapeAttr(fragment)}"` : "";
        return `<a href="${escapeAttr(href)}"${titleAttr} data-md-path="${escapeAttr(resolved)}" data-md-kind="${kind}"${fragAttr}>${label}</a>`;
      },
      image({ href, text }) {
        return imagePlaceholder(href, text ?? "", docPath);
      },
      // 文档里的原始 HTML 照旧渲染（`<br>`、`<details>` 这类在中文文档里很常见），
      // 只做两件事：把 `<img>` 统一换成占位符、把作者写的内联样式删掉；
      // 真正的安全过滤交给注入的 sanitize。
      html({ text }) {
        return rewriteRawImages(stripInlineStyles(text), docPath);
      },
    },
  });

  return marked;
}

/**
 * 渲染 Markdown 全文。
 *
 * 顺序固定为「预处理（取走脚注定义）→ 解析 → 改写（渲染器内完成）→ 拼上脚注区 → 清洗
 * → 抽大纲」：
 *
 * - 大纲必须建立在**清洗后**的 HTML 上，否则被清洗掉的标题会留在大纲里指向不存在的锚点；
 * - 脚注区与正文拼在一起后**一起过清洗**：脚注区的标签结构确实由本模块产出（属性全部
 *   可控），但它的**正文来自文档作者**（`[^a]: <style>…</style>` 同样是一种注入），
 *   拼在 sanitize 之后等于绕开唯一那道过滤；
 * - 大纲在脚注区之后抽：脚注里的标题（罕见，但合法）一并进大纲，跳转不会落空。
 */
export function renderMarkdown(source: string, options: MdRenderOptions): MdRenderResult {
  const docPath = options.docPath ?? "";
  const footnotes = collectFootnotes(source);
  const state: FootnoteState = {
    byId: new Map(footnotes.used.map((definition) => [definition.id, {
      number: footnotes.numbers.get(definition.id) as number,
      definition,
    }])),
  };
  const marked = createMarked(docPath, new Set<string>(), state);
  const rawHtml = marked.parse(footnotes.source) as string;
  const html = options.sanitize(rawHtml + renderFootnoteSection(state, marked));
  return {
    html,
    outline: extractOutline(html),
    lines: source.length === 0 ? 0 : source.split("\n").length,
    footnotes: footnotes.used.length,
  };
}
