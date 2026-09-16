/**
 * font-options.ts — 字体下拉的**选项模型**：分组、过滤、展示名（纯逻辑，可单测）。
 *
 * 数据来源有两处，但下游看到的都是同一个 {@link FontChoice}：
 *   1. 后端枚举的**系统字体集**（DirectWrite，见 `src-tauri/src/fonts.rs`）——
 *      正常路径，本机两三百个 family；
 *   2. 内置候选表（`font-catalog.ts`）—— 后端不可用时的兜底（浏览器复现环境）。
 *
 * 分组规则（按「能不能当非中文字体用」排序）：
 *   - `mono`  ：等宽且**不含**中文字形 → 日志 / 表格的对齐前提，非中文字体的首选；
 *   - `cjk`   ：自带中文字形 → 中文字体该从这里挑（含中文字形的等宽字体也在这里）；
 *   - `other` ：其余比例字体。
 * 前端不做「推荐 / 评分」，只把事实分组，避免用户把「微软雅黑」当成非中文字体后
 * 发现中文字体设置「没生效」。
 */

import { familyLabel, fontOptions, type FontRole } from "./font-catalog.ts";
import type { ViewLang } from "../views/body-view.ts";

/** 下拉里的一个可选项。 */
export interface FontChoice {
  /** 写进 CSS 的 family 名。 */
  family: string;
  /** 展示名（后端给的是界面语言对应的本地化名，如「微软雅黑」）。 */
  display: string;
  /**
   * 其它本地化名（可能为空）：搜索时一并参与匹配。
   *
   * 界面切成英文后展示名是 `Microsoft YaHei`，光看这个名字搜不到「雅黑」——
   * 用户在系统里认的是中文名，所以别名必须参与搜索。
   */
  aliases: string[];
  /** 等宽（西文宽度一致）——日志 / 表格对齐的前提。 */
  mono: boolean;
  /** 自带中文字形：放在「非中文字体」里会连中文一起接管。 */
  cjk: boolean;
}

/**
 * 后端枚举出来的系统字体（`list_system_fonts` 的返回项）。
 *
 * `mono` / `cjk` 是**字体自己声明的事实**（DirectWrite 的 `IDWriteFont1::IsMonospacedFont`
 * 与 `IDWriteFont::HasCharacter`），不是前端猜的：汉字在所有中文字体里都是一个 em 宽，
 * 在页面上量宽度对中文字体毫无区分度，只能问字体表。
 */
export interface SystemFontLike {
  family: string;
  display?: string;
  aliases?: string[];
  mono?: boolean;
  cjk?: boolean;
}

/** 系统字体 → 下拉选项（纯映射：事实由后端给，前端不猜）。 */
export function choicesFromSystem(fonts: readonly SystemFontLike[]): FontChoice[] {
  return fonts.map((f) => ({
    family: f.family,
    display: (f.display ?? "").trim() || f.family,
    aliases: (f.aliases ?? []).map((a) => (a ?? "").trim()).filter(Boolean),
    mono: f.mono === true,
    cjk: f.cjk === true,
  }));
}

/**
 * 内置候选表的选项（后端不可用时的兜底）。
 *
 * 这里的事实来自**候选表自己的标注**而不是探测：候选表按角色分成
 * `LATIN_FONT_OPTIONS` / `CJK_FONT_OPTIONS` 两份，所以「是否自带中文字形」
 * 就是「在哪一份里」，比在页面上探测可靠（见上面 `SystemFontLike` 的注释）。
 */
export function catalogChoices(role: FontRole, lang: ViewLang = "zh"): FontChoice[] {
  return fontOptions(role).map((o) => ({
    family: o.family,
    display: familyLabel(role, o.family, lang),
    // 候选表里中文候选的英文名（family）本身就是 family 字段，另外补上中文标签
    aliases: [lang === "zh" ? (o.en ?? "") : o.zh].filter(Boolean),
    mono: o.mono,
    cjk: role === "cjk",
  }));
}

/** 字体分组（顺序即下拉里的顺序）。 */
export type FontGroupKey = "mono" | "cjk" | "other";

/** 一组字体。 */
export interface FontGroup {
  key: FontGroupKey;
  choices: FontChoice[];
}

/** 组内排序用的比较器（按展示名，UI 语言决定中文的排序结果）。 */
function compareChoices(a: FontChoice, b: FontChoice, lang: string): number {
  return a.display.localeCompare(b.display, lang, { numeric: true, sensitivity: "base" });
}

/**
 * 按事实分组（空组不返回），组内按展示名排序。
 *
 * `lang` 只影响排序用的 collation（中文界面下「微软雅黑」这类名字按中文规则排）。
 */
export function buildFontGroups(choices: readonly FontChoice[], lang = "en"): FontGroup[] {
  const mono: FontChoice[] = [];
  const cjk: FontChoice[] = [];
  const other: FontChoice[] = [];
  for (const choice of choices) {
    if (choice.cjk) {
      cjk.push(choice);
    } else if (choice.mono) {
      mono.push(choice);
    } else {
      other.push(choice);
    }
  }
  const groups: FontGroup[] = [
    { key: "mono", choices: mono.sort((a, b) => compareChoices(a, b, lang)) },
    { key: "cjk", choices: cjk.sort((a, b) => compareChoices(a, b, lang)) },
    { key: "other", choices: other.sort((a, b) => compareChoices(a, b, lang)) },
  ];
  return groups.filter((g) => g.choices.length > 0);
}

/** 规范化搜索词：去首尾空白、转小写、去掉空格（`micro soft` 也能搜到 `Microsoft`）。 */
export function normalizeQuery(query: string): string {
  return (query ?? "").trim().toLowerCase().replace(/\s+/g, "");
}

/**
 * 搜索匹配：family 名、展示名、本地化别名都参与匹配。
 *
 * 中文界面下用户可能按中文名搜（「雅黑」），也可能按英文名搜（`yahei`）；
 * 界面切成英文后，中文名只剩在别名里 —— 两边都得能搜到，
 * 因为用户在系统里认的可能就是另一个语言的名字。
 */
export function matchesQuery(choice: FontChoice, query: string): boolean {
  const q = normalizeQuery(query);
  if (!q) {
    return true;
  }
  const flatten = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  if (flatten(choice.family).includes(q) || flatten(choice.display).includes(q)) {
    return true;
  }
  return choice.aliases.some((alias) => flatten(alias).includes(q));
}

/** 过滤（搜索词为空时原样返回）。 */
export function filterChoices(choices: readonly FontChoice[], query: string): FontChoice[] {
  const q = normalizeQuery(query);
  if (!q) {
    return [...choices];
  }
  return choices.filter((c) => matchesQuery(c, q));
}

/** 下拉项的显示文本：本地化名与 CSS 名不同时把 CSS 名也带上（便于排查 / 复制）。 */
export function optionLabel(choice: FontChoice): string {
  const display = choice.display.trim();
  if (!display) {
    return choice.family;
  }
  if (display.toLowerCase() === choice.family.toLowerCase()) {
    return display;
  }
  return `${display}（${choice.family}）`;
}

/** 选中值归一化：忽略大小写与引号，判断某个 family 是否就是用户当前的选择。 */
export function sameFamily(a: string, b: string): boolean {
  const norm = (s: string) => (s ?? "").trim().replace(/["']/g, "").toLowerCase();
  return norm(a) !== "" && norm(a) === norm(b);
}

/** 在候选里找当前选中的那一项（找不到返回 undefined = 走「自定义」）。 */
export function findChoice(choices: readonly FontChoice[], family: string): FontChoice | undefined {
  return choices.find((c) => sameFamily(c.family, family) || sameFamily(c.display, family));
}
