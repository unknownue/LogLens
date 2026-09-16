/**
 * font-catalog.ts — 字体目录 + 「非中文 / 中文」两条字体栈的拼装规则。
 *
 * 纯逻辑模块：不碰 DOM，可被 `node --test` 直接加载
 * （见 tools/verify-settings.test.mjs），App 与设置模态框共用。
 *
 * ==================== 为什么把字体分成「非中文」和「中文」两份 ====================
 *
 * 浏览器给一段文本挑字体是**逐字符**回退的：它沿 font-family 列表从第一项往后走，
 * 谁能画出这个字符就用谁。于是「西文用 Consolas、中文用微软雅黑」并不需要声明
 * unicode-range，只要把两者按顺序拼成一条列表：
 *
 *     font-family: "Consolas", "Cascadia Mono", "Courier New", "微软雅黑", monospace;
 *
 * 西文字符命中 Consolas（这类纯西文字体没有中文字形，中文自然落到列表更后面的
 * 中文字体）；中文字符跳过前面所有纯西文字体后命中中文字体。这是 Windows Terminal /
 * VSCode 等终端类工具处理「中英混排」的通用做法，也不用加载任何字体文件。
 *
 * 唯一的前提是：**排在前面的非中文字体不要自己带中文字形**（如「微软雅黑」当西文字体
 * 用），否则中文也会被它吃掉。`font-probe.ts` 的 `familyProvidesCjk` 就是用来在设置
 * 界面里提示这种搭配的。
 */

/** 一个候选字体族。 */
export interface FontOption {
  /** CSS font-family 家族名（用系统注册的英文名；Chromium 对中英文名都认，英文名更稳）。 */
  family: string;
  /** 中文界面下的显示名。 */
  zh: string;
  /** 英文界面下的显示名（缺省用 {@link FontOption.family}）。 */
  en?: string;
  /** 是否等宽字体（目录内静态标注：等宽是日志/表格对齐的前提）。 */
  mono: boolean;
}

/** 默认「非中文字体」族列表（与 App.css 的 `--font-latin` 初值保持一致，单测会卡这条）。 */
export const DEFAULT_LATIN_FAMILIES: readonly string[] = [
  "Consolas",
  "Cascadia Mono",
  "Courier New",
];

/**
 * 默认「中文字体」族列表（与 App.css 的 `--font-cjk` 初值一致）。
 *
 * 按可用性从高到低排：Windows 10+ 的雅黑 UI → 雅黑 → macOS 苹方 → 开源思源/Noto。
 * 一个都不在时，浏览器的系统 CJK 回退接手（与改动前的行为一致）。
 */
export const DEFAULT_CJK_FAMILIES: readonly string[] = [
  "Microsoft YaHei UI",
  "Microsoft YaHei",
  "PingFang SC",
  "Noto Sans CJK SC",
  "Source Han Sans SC",
];

/**
 * 非中文字体候选（等宽在前：日志查看器的默认选择永远是等宽）。
 *
 * 只列「常见且值得一试」的家族 —— 列表外的字体可以在设置里手动输入，
 * 所以这里不必求全。
 */
export const LATIN_FONT_OPTIONS: readonly FontOption[] = [
  { family: "Consolas", zh: "Consolas（系统自带）", mono: true },
  { family: "Cascadia Mono", zh: "Cascadia Mono", mono: true },
  { family: "Cascadia Code", zh: "Cascadia Code", mono: true },
  { family: "Courier New", zh: "Courier New（系统自带）", mono: true },
  { family: "Lucida Console", zh: "Lucida Console", mono: true },
  { family: "JetBrains Mono", zh: "JetBrains Mono", mono: true },
  { family: "Fira Code", zh: "Fira Code", mono: true },
  { family: "Source Code Pro", zh: "Source Code Pro", mono: true },
  { family: "IBM Plex Mono", zh: "IBM Plex Mono", mono: true },
  { family: "Roboto Mono", zh: "Roboto Mono", mono: true },
  { family: "DejaVu Sans Mono", zh: "DejaVu Sans Mono", mono: true },
  { family: "Menlo", zh: "Menlo", mono: true },
  { family: "Monaco", zh: "Monaco", mono: true },
  { family: "Segoe UI", zh: "Segoe UI", mono: false },
  { family: "Arial", zh: "Arial", mono: false },
  { family: "Tahoma", zh: "Tahoma", mono: false },
  { family: "Verdana", zh: "Verdana", mono: false },
  { family: "Calibri", zh: "Calibri", mono: false },
  { family: "Georgia", zh: "Georgia", mono: false },
  { family: "Times New Roman", zh: "Times New Roman", mono: false },
];

/**
 * 中文字体候选。
 *
 * 包含几款「中文等宽」（更纱黑体 / 思源等宽）：它们同时含有等宽西文字形，做非中文字体
 * 也合适，但放在这里是因为用户找中文字体时通常会想到它们。
 */
export const CJK_FONT_OPTIONS: readonly FontOption[] = [
  { family: "Microsoft YaHei UI", zh: "微软雅黑 UI（系统自带）", mono: false },
  { family: "Microsoft YaHei", zh: "微软雅黑（系统自带）", mono: false },
  { family: "SimSun", zh: "宋体（系统自带）", mono: false },
  { family: "NSimSun", zh: "新宋体（系统自带，等宽）", mono: true },
  { family: "SimHei", zh: "黑体（系统自带）", mono: false },
  { family: "DengXian", zh: "等线（系统自带）", mono: false },
  { family: "KaiTi", zh: "楷体（系统自带）", mono: false },
  { family: "FangSong", zh: "仿宋（系统自带）", mono: false },
  { family: "Sarasa Mono SC", zh: "更纱黑体 SC（等宽）", mono: true },
  { family: "Sarasa Fixed SC", zh: "更纱黑体 Fixed SC（等宽）", mono: true },
  { family: "Noto Sans Mono CJK SC", zh: "思源等宽（Noto Sans Mono CJK SC）", mono: true },
  { family: "Source Han Sans SC", zh: "思源黑体 SC", mono: false },
  { family: "Noto Sans CJK SC", zh: "Noto Sans CJK SC", mono: false },
  { family: "Source Han Serif SC", zh: "思源宋体 SC", mono: false },
  { family: "LXGW WenKai", zh: "霞鹜文楷", mono: false },
  { family: "PingFang SC", zh: "苹方（macOS）", mono: false },
  { family: "Hiragino Sans GB", zh: "冬青黑体（macOS）", mono: false },
];

/** 字体在设置里扮演的角色：非中文字体 / 中文字体。 */
export type FontRole = "latin" | "cjk";

/** 取某个角色的候选表。 */
export function fontOptions(role: FontRole): readonly FontOption[] {
  return role === "latin" ? LATIN_FONT_OPTIONS : CJK_FONT_OPTIONS;
}

/** 取某个角色的内置默认族列表。 */
export function defaultFamilies(role: FontRole): readonly string[] {
  return role === "latin" ? DEFAULT_LATIN_FAMILIES : DEFAULT_CJK_FAMILIES;
}

/** CSS 通用字体族（generic family）关键字：不能加引号，只能出现在列表末尾。 */
const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
]);

/** 用户输入里被折叠掉的空白（避免把控制字符 / 换行带进 CSS 变量）。 */
const WHITESPACE_RE = /\s+/g;

/** 单个族名的最大长度：localStorage 被写脏时不要让一条畸形值撑爆样式表。 */
const MAX_FAMILY_LEN = 64;

/** 一条输入最多接受的族数量（用逗号分隔的多族栈）。 */
const MAX_FAMILIES = 8;

/** 这是个通用字体族吗（`monospace` / `sans-serif` …）？ */
export function isGenericFamily(name: string): boolean {
  return GENERIC_FAMILIES.has(name.trim().toLowerCase());
}

/**
 * 归一化一个族名：去掉空白与两端引号。
 *
 * 用户可能从别处粘贴 `"Sarasa Mono SC"`（带引号）或 `微软雅黑，`（带全角逗号），
 * 这里统一收拾干净，后面再按需要重新加引号。
 */
export function normalizeFamily(raw: string): string {
  let name = (raw ?? "").replace(WHITESPACE_RE, " ").trim();
  // 成对引号（半角 / 全角）剥一层
  if (name.length >= 2) {
    const first = name[0];
    const last = name[name.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      name = name.slice(1, -1).trim();
    }
  }
  if (name.length > MAX_FAMILY_LEN) {
    name = name.slice(0, MAX_FAMILY_LEN).trim();
  }
  return name;
}

/**
 * 把用户输入拆成族名列表：支持逗号（半角/全角）分隔的多族栈、剥引号、去重、
 * 丢掉通用族（通用族由 {@link buildFontStack} 统一补在末尾）。
 */
export function parseFamilyList(input: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of String(input ?? "").split(/[,，]/)) {
    const name = normalizeFamily(part);
    if (!name || isGenericFamily(name)) {
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_FAMILIES) {
      break;
    }
  }
  return out;
}

/**
 * 给一个族名加上 CSS 引号。
 *
 * 除通用族（`monospace` 等关键字不能加引号）外统一加引号：等价于「不必引号」的
 * 单字族名加了引号也只是更保守，但换来一条稳定规则 —— 生成的字体栈与手写在
 * App.css 里的默认值逐字符一致，单测可以直接比对（见 verify-settings.test.mjs）。
 * 含空格或非 ASCII（中文字体名）的族名则**必须**加引号，否则 CSS 会按标识符断开。
 */
export function quoteFamily(name: string): string {
  const n = normalizeFamily(name);
  if (!n) {
    return "";
  }
  if (isGenericFamily(n)) {
    return n;
  }
  return `"${n.replace(/"/g, "")}"`;
}

/**
 * 拼一条「族列表」CSS 值（不含通用族）：用户值为空时回落到内置默认列表。
 *
 * 结果直接写进 `--font-latin` / `--font-cjk` 两个 CSS 变量。
 */
export function buildFamilyList(input: string, fallback: readonly string[]): string {
  const families = parseFamilyList(input);
  const list = families.length > 0 ? families : fallback.map(normalizeFamily).filter(Boolean);
  return list.map(quoteFamily).filter(Boolean).join(", ");
}

/**
 * 拼「非中文字体 + 中文字体 + 通用族」的完整字体栈。
 *
 * 顺序即优先级：非中文字体在前（它没有中文字形，中文会继续往后找），中文字体在后，
 * 最后补一个通用族兜底。设置界面的预览、单测与 CSS 默认值都用同一套规则。
 */
export function buildFontStack(latin: string, cjk: string, generic = "monospace"): string {
  // 每个角色单独判空：只填了通用族（`monospace`）视同没填，回落到该角色的内置默认，
  // 与 buildFamilyList 的口径一致 —— 设置页显示的字体栈必须就是实际生效的那条。
  const latinList = parseFamilyList(latin);
  const cjkList = parseFamilyList(cjk);
  const families = [
    ...(latinList.length > 0 ? latinList : DEFAULT_LATIN_FAMILIES),
    ...(cjkList.length > 0 ? cjkList : DEFAULT_CJK_FAMILIES),
  ];
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const family of families) {
    const key = family.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    parts.push(quoteFamily(family));
  }
  parts.push(isGenericFamily(generic) ? generic : "monospace");
  return parts.join(", ");
}

/** 该族名是本角色的候选表成员吗（用于设置界面判断「自定义」）。 */
export function isCatalogFamily(role: FontRole, family: string): boolean {
  const key = normalizeFamily(family).toLowerCase();
  return fontOptions(role).some((o) => o.family.toLowerCase() === key);
}

/** 候选表里该族名对应的显示名（中/英）。 */
export function familyLabel(role: FontRole, family: string, lang: "zh" | "en"): string {
  const key = normalizeFamily(family).toLowerCase();
  const hit = fontOptions(role).find((o) => o.family.toLowerCase() === key);
  if (!hit) {
    return family;
  }
  return lang === "en" ? hit.en ?? hit.family : hit.zh;
}

/** 候选表里该族名是否等宽（非候选表成员返回 null = 未知）。 */
export function catalogMono(role: FontRole, family: string): boolean | null {
  const key = normalizeFamily(family).toLowerCase();
  const hit = fontOptions(role).find((o) => o.family.toLowerCase() === key);
  return hit ? hit.mono : null;
}
