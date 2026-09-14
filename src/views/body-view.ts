/**
 * 正文（tab 内容区）多页面框架 —— 纯逻辑部分（不依赖 React / DOM，可在 Node 中单测）。
 *
 * 为什么需要它：正文区此前只有「文本视图 / 表格视图」两种形态，在 App 里用三元
 * 表达式二选一。但正文区的「页面」不止内容视图 —— 文件不存在、打开失败、解析失败、
 * 以及后续要加的其它视图，都是同一层的页面。二元选择一旦扩到四五个分支，就会退化
 * 成难读的嵌套三元，且每加一个页面都得改动 App 的渲染树。这里把「某个 tab 该显示
 * 哪个页面」抽象成一条单向管线：
 *
 *     tab 状态（上下文 ctx） → 带优先级的候选页面 → 命中的唯一一个页面
 *
 * 新增页面的成本（详见 docs/body-views.md）：
 *   1. 写一个页面组件，props 继承 {@link BodyViewProps}（公共属性由宿主注入）；
 *   2. 在注册表（App.tsx 的 bodyViews）里加一条
 *      `{ id, priority, title, match, render }`。
 * App 的渲染树不变，既有页面不受影响。
 */

import type { ReactNode } from "react";

/** 界面语言（与 App 的 Lang 同构）。本模块不反向依赖 App，避免循环引用。 */
export type ViewLang = "zh" | "en";

/**
 * 正文页面的公共属性：由宿主（`BodyViewHost`）统一注入。
 * 页面可以只取用其中一部分（如状态页面不需要 fontSize），但契约对每个页面一致 ——
 * 这样「页面」之间可以互换，App 只认识契约、不认识具体页面。
 */
export interface BodyViewProps {
  /** 所属 tab（后端会话也按它索引）。 */
  tabId: string;
  /** 该 tab 绑定的文件路径（可能已不存在）。 */
  path: string;
  /** 是否为当前激活 tab（只有激活 tab 才注册复制函数 / 上报行数）。 */
  active: boolean;
  /** 正文字号（px）。 */
  fontSize: number;
  /** 界面语言。 */
  lang: ViewLang;
  /** 用户点了工具栏的「切换视图模式」按钮（打开视图模式选择框）。 */
  onSwitchViewMode: () => void;
  /** 关闭本 tab。 */
  onClose: () => void;
  /** 注册「复制当前视图」：激活时注册、失活/卸载时注销。 */
  registerCopy: (tabId: string, fn: (() => Promise<string>) | null) => void;
  /** 上报文件总行数（窗口右上角显示）：null = 不适用（清空显示）。 */
  reportTotal: (tabId: string, total: number | null) => void;
}

// ==================== 打开失败分类 ====================

/**
 * 打开失败的原因分类 —— 决定正文区显示哪个「状态页面」。
 *
 * - `none`   无错误，走正常内容视图；
 * - `missing` 目标不存在（文件被删除 / 移动 / 磁盘未挂载）；
 * - `denied`  目标存在但无权限读取；
 * - `other`   其它（解析失败、IO 错误……），走通用错误页。
 */
export type OpenErrorKind = "none" | "missing" | "denied" | "other";

/** {@link classifyOpenError} 的结果。 */
export interface OpenErrorInfo {
  /** 分类结果。 */
  kind: OpenErrorKind;
  /**
   * 缺失的对象（仅 `kind === "missing"` 时有意义）：
   *
   * - `file`   tab 绑定的日志 / bin 文件本体不存在；
   * - `schema` 文件本体在，缺的是表格视图的 schema（cfg_table_slots.json）。
   *
   * 两者需要的修复入口完全不同（重新定位文件 vs 重选 schema），所以必须区分：
   * 否则一个「schema 丢了」的表格 tab 会显示「文件不存在」页，并把**存在**的
   * bin 路径当作缺失文件展示。
   */
  subject?: "file" | "schema";
  /** 后端返回的原始错误文本。 */
  raw?: string;
}

/**
 * 「目标不存在」的错误文本特征。后端的错误是带前缀的中文串
 * （`文件不存在: C:\logs\a.log`、`schema 文件不存在: …`），前端不做 locale
 * 判断，直接按消息契约匹配；措辞变化只需改这里（`tools/verify-body-views.test.mjs`
 * 用真实消息样本覆盖了这些分支）。
 *
 * 注意不要匹配裸的「不存在」：`tab 不存在: tab-3` 这类会话错误也含这两个字，
 * 却与文件系统无关。同理「未在 schema 中找到」不等于「找不到」。
 */
const MISSING_PATTERNS: readonly RegExp[] = [
  /文件不存在/,
  /路径不存在/,
  /找不到/,
  /no such file/i,
  /file not found/i,
  /cannot find the file/i,
  /系统找不到指定的文件/,
  /os error 2\b/i,
];

/** 「缺的是 schema 而不是文件本体」的判定。 */
const SCHEMA_SUBJECT_RE = /schema\s*文件不存在/i;

/** 「无权限读取」的错误文本特征。 */
const DENIED_PATTERNS: readonly RegExp[] = [
  /拒绝访问/,
  /无权限/,
  /权限不足/,
  /permission denied/i,
  /access is denied/i,
  /os error 5\b/i,
];

/** 把后端错误文本分类为状态页面所需的类型（无错误/空串 → `none`）。 */
export function classifyOpenError(raw?: string | null): OpenErrorInfo {
  if (!raw) {
    return { kind: "none" };
  }
  if (MISSING_PATTERNS.some((re) => re.test(raw))) {
    return {
      kind: "missing",
      subject: SCHEMA_SUBJECT_RE.test(raw) ? "schema" : "file",
      raw,
    };
  }
  if (DENIED_PATTERNS.some((re) => re.test(raw))) {
    return { kind: "denied", raw };
  }
  return { kind: "other", raw };
}

// ==================== 页面注册表 ====================

/**
 * 一条正文页面注册项。
 *
 * - `match` 只回答「该不该由我显示」；显示所需的数据在 `render` 里从 ctx 取。
 * - `render` 返回 React 节点：公共属性由宿主以 `base` 传入，页面专属属性在这里
 *   组装。比「给注册表再加一层泛型 props」更好读，也避开了 React 组件类型参数
 *   不变性带来的类型体操。
 */
export interface BodyViewDefinition<Ctx> {
  /** 页面标识（注册表内唯一）。同时写到容器的 `data-view` 上，供 E2E 断言当前页面。 */
  id: string;
  /** 优先级：数值大者优先；同一 tab 命中多个时取最高的那个。 */
  priority: number;
  /** 兜底页面：所有 match 都不命中时使用。注册表要求有且仅有一个。 */
  fallback?: boolean;
  /** 页面标题（aria-label / 调试用，与窗口标题无关）。 */
  title: (lang: ViewLang) => string;
  /** 命中判定。 */
  match: (ctx: Ctx) => boolean;
  /** 渲染：`base` 为公共属性，`ctx` 为宿主上下文。 */
  render: (base: BodyViewProps, ctx: Ctx) => ReactNode;
}

/**
 * 页面注册表：正文区「多类页面」的唯一事实来源。
 *
 * 校验放在构造期（重复 id / 缺兜底属于配置错误，等到渲染时才炸会难查得多）。
 */
export class BodyViewRegistry<Ctx> {
  /** 已按优先级降序排好的定义表（resolve 取第一个命中项即可）。 */
  private readonly defs: BodyViewDefinition<Ctx>[];
  /** 兜底页面。 */
  private readonly fallbackDef: BodyViewDefinition<Ctx>;

  constructor(defs: readonly BodyViewDefinition<Ctx>[]) {
    const seen = new Set<string>();
    for (const d of defs) {
      if (seen.has(d.id)) {
        throw new Error(`正文页面 id 重复: ${d.id}`);
      }
      seen.add(d.id);
    }
    const fallbacks = defs.filter((d) => d.fallback);
    if (fallbacks.length !== 1) {
      throw new Error(
        `正文页面注册表需要且仅需要一个 fallback 页面，当前 ${fallbacks.length} 个`
      );
    }
    this.defs = [...defs].sort((a, b) => b.priority - a.priority);
    this.fallbackDef = fallbacks[0];
  }

  /** 全部页面定义（按优先级降序）。 */
  get definitions(): readonly BodyViewDefinition<Ctx>[] {
    return this.defs;
  }

  /** 按 id 取页面定义（未注册返回 undefined）。 */
  find(id: string): BodyViewDefinition<Ctx> | undefined {
    return this.defs.find((d) => d.id === id);
  }

  /** 解析该 tab 应显示的页面：优先级最高的命中项；都不命中则用兜底页面。 */
  resolve(ctx: Ctx): BodyViewDefinition<Ctx> {
    return this.defs.find((d) => d.match(ctx)) ?? this.fallbackDef;
  }
}
