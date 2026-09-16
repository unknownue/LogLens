/**
 * marked 的数学公式扩展（KaTeX 渲染）：支持 `$$…$$` / `$…$` / `\(…\)` / `\[…\]`。
 *
 * 为什么不直接用 `marked-katex-extension`：它的默认规则要求 `$` 两侧有空格
 * （tokenizer 正则的收尾要求是 `(?=[\s?!\.,:？！。，：]|$)`），而中文技术文档里
 * `质数$p$满足…` 这种紧贴写法极其常见，默认规则会整篇漏渲染；改用它的
 * `nonStandard: true` 又走到另一个极端 —— `echo $PATH $HOME`、`价格 $5 到 $10`
 * 这类文本会被当成公式，渲染出乱码般的行内数学块。
 *
 * 这里的规则是两条路都避开的折中（单 `$` 的判定全部基于「向前可见的信息」，
 * 不依赖 `$` 左侧字符，因此 tokenizer 在任意位置都能给出稳定结果）：
 *
 * 1. 内容非空，且首尾都不能是空白（`$ 100` / `$5 到 $` 不成立）；
 * 2. 内容里不能有换行、不能出现裸 `$`（`$a$b$` 不会把 `$a$` 咬下来）；
 * 3. 收尾 `$` 后面不能紧跟数字（`$5$10` 不是公式）；
 * 4. 内容不能是纯数字/标点（`$100`、`价格$5$个` 这类价格写法不成立）；
 * 5. `$$…$$`（行内 displayMode）、`\(…\)`、`\[…\]` 语义无歧义，不施加上述限制。
 *
 * 第 4 条是刻意的取舍：`$2$` 这种「把一个数字写成公式」的写法会被放弃，
 * 换取「正文里的价格数字不会被误判」——后者在日志/文档里出现的概率高得多。
 * 需要表达单个数字公式时写 `\(2\)` 即可。
 */

import katex from "katex";
import type { MarkedExtension, Tokens } from "marked";

/** 公式 token（行内 / 块级共用字段）。 */
export interface MathToken extends Tokens.Generic {
  type: "inlineKatex" | "blockKatex";
  /** LaTeX 源码（已去掉首尾空白）。 */
  text: string;
  /** 是否行间公式（`$$…$$` 或 `\[…\]`）。 */
  displayMode: boolean;
  /** 原始文本（marked 用来计算位置，必须保留）。 */
  raw: string;
}

/**
 * 行内 `$…$` / `$$…$$`。
 *
 * 逐段解释：`(\${1,2})` 定界符（1 或 2 个 `$`）；内容 `[^\s$](?:[^$\n]*[^\s$])?`
 * 保证「首尾非空白、中间不含裸 `$` 与换行」；`\1` 要求收尾定界符与开头等长；
 * 末尾 `(?!\d)` 拒绝后接数字的收尾（`$5$10`）。
 */
const INLINE_DOLLAR = /^(\${1,2})([^\s$](?:[^$\n]*[^\s$])?)\1(?!\d)/;

/** 行内 `\(…\)`（语义无歧义，不设额外限制，但要求内容里至少有一个非空白字符）。 */
const INLINE_PAREN = /^\\\(([\s\S]*?[^\s\\])\\\)/;

/** 块级 `$$`：定界符独占一行，内容可多行。 */
const BLOCK_DOLLAR = /^\$\$\n([\s\S]+?)\n\$\$(?:\n|$)/;

/** 块级 `\[…\]`：定界符可与内容同行，也可独占一行。 */
const BLOCK_BRACKET = /^\\\[([\s\S]+?)\\\](?:[ \t]*(?:\n|$))/;

/** 「纯数字/标点」的内容判定：这类内容按价格处理，不当作公式（见文件头第 4 条）。 */
const NUMERIC_ONLY = /^[0-9\s.,%+\-*/:]+$/;

/** KaTeX 渲染参数（错误就地显示、未知字符不刷控制台）。 */
const KATEX_OPTIONS = {
  /** 语法错误时输出红色错误标记而不是抛异常（一个坏公式不该毁掉整篇文档）。 */
  throwOnError: false,
  /** 未知 Unicode / 非标准写法只忽略：中文文档里 `\text{中文}` 很常见。 */
  strict: false as const,
  /** 不信任 `\href` 等需要外部资源/交互的命令。 */
  trust: false,
  /** 同时输出 HTML 与 MathML：前者负责视觉，后者负责无障碍与「复制公式」。 */
  output: "htmlAndMathml" as const,
};

/**
 * 用 KaTeX 渲染一段 LaTeX；失败时退化成转义后的原文（受 throwOnError 兜底）。
 *
 * 形参按 marked 的扩展契约收 `Tokens.Generic`（marked 只承诺给到这里），
 * 内部再收窄成自己的 token 类型。
 */
function renderKatex(token: Tokens.Generic): string {
  const math = token as MathToken;
  return katex.renderToString(math.text, {
    ...KATEX_OPTIONS,
    displayMode: math.displayMode,
  });
}

/**
 * 构造 marked 扩展。
 *
 * 注意：marked 的扩展 tokenizer **先于**内置规则运行，所以 `$$` 独占一行时
 * 不会被段落规则吃掉（`tests` 里有回归样例）。
 */
export function mathExtension(): MarkedExtension {
  return {
    extensions: [
      {
        name: "blockKatex",
        level: "block",
        tokenizer(src): MathToken | undefined {
          const match = BLOCK_DOLLAR.exec(src) ?? BLOCK_BRACKET.exec(src);
          if (!match) {
            return undefined;
          }
          return {
            type: "blockKatex",
            raw: match[0],
            text: match[1].trim(),
            displayMode: true,
          };
        },
        renderer: renderKatex,
      },
      {
        name: "inlineKatex",
        level: "inline",
        // 只为加速：把扫描起点提前到下一个 `$` 或 `\(`，判定本身全在 tokenizer 里。
        start(src) {
          const dollar = src.indexOf("$");
          const paren = src.indexOf("\\(");
          if (dollar < 0) {
            return paren;
          }
          if (paren < 0) {
            return dollar;
          }
          return Math.min(dollar, paren);
        },
        tokenizer(src): MathToken | undefined {
          const paren = INLINE_PAREN.exec(src);
          if (paren) {
            return {
              type: "inlineKatex",
              raw: paren[0],
              text: paren[1].trim(),
              displayMode: false,
            };
          }
          const dollar = INLINE_DOLLAR.exec(src);
          if (!dollar || NUMERIC_ONLY.test(dollar[2])) {
            return undefined;
          }
          return {
            type: "inlineKatex",
            raw: dollar[0],
            text: dollar[2].trim(),
            displayMode: dollar[1].length === 2,
          };
        },
        renderer: renderKatex,
      },
    ],
  };
}
