/**
 * 脚注扩展（GFM 的 `[^1]` 写法）—— 渲染管线里唯一**需要两遍扫描**的一步。
 *
 * 为什么不能用现成的：`marked` 18 不带脚注（`marked-footnote` 是第三方插件），
 * 而脚注的编号规则需要「先看全文再决定」，恰好与「一遍流式解析」的直觉相反。
 *
 * 编号按**首次引用顺序**（与 GitHub 一致）：定义写在文档中间、引用散落在各处时，
 * 「定义顺序」会让读者看到 1、3、2 这样跳号的角标；「引用顺序」永远是从上到下 1、2、3。
 * 于是流程固定为三步：
 *
 *   1. `collectFootnotes`：**扫描源码**，取走定义行（正文里不该出现 `[^1]: 正文`），
 *      同时记下每个 id 的首次引用位置（跳过围栏代码块 —— 代码里的 `[^1]` 是字面量）；
 *   2. tokenizer 把 `[^id]` 渲染成角标上标（只有「有定义」的 id 才算，否则留原文：
 *      `[^TODO]` 这种写完忘记加定义的写法不该变成一个死链接）；
 *   3. 渲染结束后把脚注区（`<section class="md-footnotes">`）追加到 HTML 末尾。
 *
 * 与清洗的关系：脚注区的**标签结构**确实由本模块产出（属性全部可控），但**定义正文是
 * 文档作者写的 markdown**（`[^evil]: <style>…</style>` 一样能注入）。所以脚注区必须和正文
 * 拼在一起、**一起过 sanitize** —— 早期版本把它拼在 sanitize 之后，等于绕开唯一那道过滤。
 * 本模块负责的是「插值进属性的 id/标题全部 escapeHtml」这一层。
 *
 * 纯函数（不碰 DOM / Tauri），可在 Node 里直接单测，见 `tools/verify-markdown.test.mjs`。
 */

import type { MarkedExtension, Tokens } from "marked";

import { escapeHtml } from "./markdown.ts";

/**
 * 追加脚注区时只用到 marked 的**行内解析**能力。
 *
 * 这里刻意不 import `Marked` 类型：`markdown.ts` 需要 import 本模块（把扩展装进
 * 渲染器），本模块若再 import 它的类型就成环 —— 运行时没问题，但会绕成一个没有
 * 意义的循环依赖。只声明所需的那一个方法，两侧都干净。
 *
 * 返回值写成联合类型是因为 marked 18 的 `parseInline` 重载在「不知道 `async` 选项」
 * 时给出 `string | Promise<string>`；我们只以同步方式调用，收口在调用点用 `String()`。
 */
export interface InlineParser {
  /** 把一段 Markdown 解析成行内 HTML（不包 `<p>`）。 */
  parseInline(src: string): string | Promise<string>;
}

/** 一条脚注定义。 */
export interface FootnoteDefinition {
  /** 定义 id（`[^1]` 里的 `1`，原样保留大小写）。 */
  id: string;
  /**
   * 定义正文（多行定义按空格拼接成一行）。
   *
   * 为什么折成一行：脚注正文在条目里按**行内**解析（`parser.parseInline`），
   * 折行只是把源码里的换行变成空格；真需要块级结构（列表、代码块）的脚注在
   * 中文技术文档里极少，而支持它要处理「续行缩进规则」，收益不抵复杂度。
   */
  text: string;
  /** 定义所在的源码行号（1-based，仅用于排查）。 */
  line: number;
}

/** 收集结果。 */
export interface FootnoteCollectResult {
  /** 去掉定义行之后的源码。 */
  source: string;
  /** 按**首次引用顺序**排列的定义（未被引用的定义不在其中）。 */
  used: FootnoteDefinition[];
  /** 所有定义（含未被引用的），按定义顺序。 */
  all: FootnoteDefinition[];
  /** 定义 id → 渲染用序号（1-based）。 */
  numbers: Map<string, number>;
}

/** 一条定义行的开始：`[^id]:` 或 `[^id]: …`（最多 3 个前导空格，与 GFM 的块级缩进容忍一致）。 */
const DEFINITION_RE = /^ {0,3}\[\^([^\]\s]+)\]\s*:\s*(.*)$/;

/** 定义续行：至少 2 个空格缩进且非空（GFM 要求与 `[` 对齐，这里放宽到 2 格）。 */
const CONTINUATION_RE = /^ {2,}(\S.*)$/;

/** 围栏代码块的起止行（``` 或 ~~~，可与语言名同行）。 */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** 是否为一条「实义的」定义正文（排除 `[^]`、纯空白这类写法）。 */
function isRealDefinition(text: string): boolean {
  return text.trim().length > 0;
}

/**
 * 扫描源码：取走脚注定义，并算出每个定义的渲染序号。
 *
 * 未被引用的定义会被丢弃（GitHub 同款行为）：它们既不出现在脚注区，也不占编号 ——
 * 否则「删掉正文里的一处引用」会留下一个带编号的孤儿条目。
 */
export function collectFootnotes(source: string): FootnoteCollectResult {
  const lines = source.split("\n");
  const kept: string[] = [];
  const all: FootnoteDefinition[] = [];
  /** 首次引用位置：`出现在第几行` + `行内第几个`。 */
  const firstRef = new Map<string, [number, number]>();
  let inFence = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // 围栏内的内容原样保留（代码里的 `[^1]` 是字面量，不是引用也不是定义）
    const fence = FENCE_RE.exec(line);
    if (fence) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    if (inFence) {
      kept.push(line);
      continue;
    }

    const definition = DEFINITION_RE.exec(line);
    if (definition) {
      const id = definition[1];
      const parts = [definition[2]];
      let end = i;
      // 续行：缩进 ≥ 2 且非空，直到空行或下一个块级元素。
      // 注意从 `i + 1` 开始消费，不含「下一行是新的定义」——那属于下一轮的 DEFINITION_RE。
      while (end + 1 < lines.length) {
        const next = lines[end + 1];
        const cont = CONTINUATION_RE.exec(next);
        if (!cont || DEFINITION_RE.test(next)) {
          break;
        }
        parts.push(cont[1]);
        end += 1;
      }
      const text = parts.join(" ").trim();
      if (isRealDefinition(text) && !all.some((d) => d.id === id)) {
        all.push({ id, text, line: i + 1 });
      }
      i = end;
      continue;
    }

    // 记录本行里出现的引用（按出现顺序）
    for (const [, id] of line.matchAll(/\[\^([^\]\s]+)\]/g)) {
      if (!firstRef.has(id)) {
        firstRef.set(id, [i, line.indexOf(`[^${id}]`)]);
      }
    }
    kept.push(line);
  }

  // 只保留「被引用过」的定义，并按首次引用位置排序
  const used = all
    .filter((d) => firstRef.has(d.id))
    .sort((a, b) => {
      const [al, ac] = firstRef.get(a.id) as [number, number];
      const [bl, bc] = firstRef.get(b.id) as [number, number];
      return al === bl ? ac - bc : al - bl;
    });

  const numbers = new Map<string, number>();
  used.forEach((d, index) => numbers.set(d.id, index + 1));

  return { source: kept.join("\n"), used, all, numbers };
}

/** 脚注引用 token。 */
export interface FootnoteRefToken extends Tokens.Generic {
  type: "footnoteRef";
  /** 定义 id。 */
  id: string;
  /** 显示序号（1-based）。 */
  number: number;
  /** 定义正文纯文本（放进 title，悬停可见）。 */
  title: string;
  /** 原始文本。 */
  raw: string;
}

/** 渲染管线读得懂的脚注集合（tokenizer 与收尾拼接共用同一份）。 */
export interface FootnoteState {
  /** 定义 id → 【序号, 定义】。 */
  byId: Map<string, { number: number; definition: FootnoteDefinition }>;
}

/** 脚注区容器的 class（页面 CSS 与 E2E 都按它定位）。 */
export const FOOTNOTES_CLASS = "md-footnotes";

/** 脚注角标的 id 前缀（`#footnote-1` 这类可直接分享的锚点）。 */
export const FOOTNOTE_ID_PREFIX = "footnote-";

/** 回跳箭头的无障碍文案（编号由 `aria-label` 补出上下文，见 {@link renderFootnoteSection}）。 */
const BACK_LABEL_PREFIX = "返回引用";

/**
 * 构造脚注扩展。
 *
 * 与公式扩展同样的思路（见 `math.ts`）：tokenizer 先于内置规则运行，因此 `[^1]`
 * 不会被当成普通文本或被链接规则吃掉。判定里加了两道闸门 ——
 * 只有 `byId` 里存在、且该 id 至少被引用过一次的定义才会渲染成角标。
 */
export function footnoteExtension(state: FootnoteState): MarkedExtension {
  return {
    extensions: [
      {
        name: "footnoteRef",
        level: "inline",
        // 只为加速：把扫描起点提前到下一个 `[`
        start(src): number {
          return src.indexOf("[");
        },
        tokenizer(src): FootnoteRefToken | undefined {
          const match = /^\[\^([^\]\s]+)\]/.exec(src);
          if (!match) {
            return undefined;
          }
          const found = state.byId.get(match[1]);
          if (!found) {
            return undefined; // 没有定义的 `[^x]` 保持原文
          }
          return {
            type: "footnoteRef",
            raw: match[0],
            id: match[1],
            number: found.number,
            title: found.definition.text,
          };
        },
        renderer(token): string {
          const ref = token as FootnoteRefToken;
          const id = `${FOOTNOTE_ID_PREFIX}${escapeHtml(ref.id)}`;
          return (
            `<sup class="md-footnote-ref">` +
            `<a id="footnote-ref-${escapeHtml(ref.id)}" href="#${id}"` +
            ` data-md-footnote="${escapeHtml(ref.id)}"` +
            ` title="${escapeHtml(ref.title)}"` +
            ` aria-label="脚注 ${ref.number}">${ref.number}</a>` +
            `</sup>`
          );
        },
      },
    ],
  };
}

/**
 * 生成脚注区 HTML（渲染结束后追加到正文末尾）。
 *
 * 序号直接用 `<ol>` 的自增序号，与角标上的数字同源（都来自 `numbers`），
 * 因此不存在「角标写 2、条目显示 3」这种错位。
 *
 * 定义正文按**行内**解析（`parseInline`）：脚注里最常见的写法是「一句话 + 一个链接」，
 * 块级解析会把一个短句包成 `<p>`，条目里的行距立刻变得比正文还大。
 */
export function renderFootnoteSection(state: FootnoteState, marked: InlineParser): string {
  const entries = [...state.byId.values()].sort((a, b) => a.number - b.number);
  if (entries.length === 0) {
    return "";
  }
  const items = entries
    .map(({ number, definition }) => {
      // marked 的 parseInline 在「未声明 async」时是同步的，这里收口成字符串
      const body = String(marked.parseInline(definition.text));
      const back =
        `<a class="md-footnote-back" href="#footnote-ref-${escapeHtml(definition.id)}"` +
        ` data-md-footnote-ref="${escapeHtml(definition.id)}"` +
        ` aria-label="${BACK_LABEL_PREFIX} ${number}">↩</a>`;
      return (
        `<li id="${FOOTNOTE_ID_PREFIX}${escapeHtml(definition.id)}"` +
        ` data-md-footnote-item="${escapeHtml(definition.id)}">` +
        `${body} ${back}</li>`
      );
    })
    .join("");
  return `<section class="${FOOTNOTES_CLASS}" data-md-footnotes="1">\n<ol>${items}</ol>\n</section>\n`;
}
