/**
 * settings.ts — 应用设置的模型与持久化（字体 + 字号）。
 *
 * 与 `font-catalog.ts` 一样保持纯逻辑：除了 `readSettings` / `writeSettings` /
 * `applyFontSettings` 这三个明确要碰 `localStorage` / `document` 的函数外，
 * 其余都是可单测的纯函数，且这三个函数在非浏览器环境下静默降级
 * （E2E 的 mock 后端、SSR 或 Node 单测里都不会炸）。
 *
 * 持久化：`localStorage["lv-settings"]`（一个 JSON 对象）。老版本只有一个
 * `lv-fontsize` 标量，`readSettings` 会在读不到新键时把它迁进来。
 */

import {
  DEFAULT_CJK_FAMILIES,
  DEFAULT_LATIN_FAMILIES,
  buildFamilyList,
  buildFontStack,
  parseFamilyList,
} from "./font-catalog.ts";

/** 存储键。 */
export const SETTINGS_KEY = "lv-settings";
/** 旧版的「正文字号」键（只读，用于迁移）。 */
export const LEGACY_FONT_SIZE_KEY = "lv-fontsize";

/** 正文字号范围（与工具栏 A-/A+ 的可用区间一致）。 */
export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 20;
export const FONT_SIZE_DEFAULT = 12;

/** 应用设置：字体定制 + 正文字号。 */
export interface AppSettings {
  /** 非中文字体（逗号分隔可写多条；空串 = 用内置默认栈）。 */
  latinFont: string;
  /** 中文字体（同上）。 */
  cjkFont: string;
  /** 正文字号（px）。 */
  fontSize: number;
}

/** 出厂设置。 */
export const DEFAULT_SETTINGS: AppSettings = {
  latinFont: "",
  cjkFont: "",
  fontSize: FONT_SIZE_DEFAULT,
};

/** 把字号夹到可用区间（非数字 / NaN → 默认值）。 */
export function clampFontSize(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) {
    return FONT_SIZE_DEFAULT;
  }
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, n));
}

/**
 * 解析一份可能被写脏的设置对象。
 *
 * 容错策略：**逐字段**回退 —— 字体字段坏了只丢字体，字号仍然按老键迁移，
 * 不会因为一个字段非法就把用户其它设置一起清掉。
 */
export function parseSettings(raw: unknown, legacyFontSize?: unknown): AppSettings {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const latinRaw = typeof source.latinFont === "string" ? source.latinFont : "";
  const cjkRaw = typeof source.cjkFont === "string" ? source.cjkFont : "";
  const localSize = source.fontSize;
  // 新键里的字号不可用时，退回旧键；两者都没有才用默认值。
  const size =
    localSize == null || !Number.isFinite(Number(localSize))
      ? clampFontSize(legacyFontSize)
      : clampFontSize(localSize);
  return {
    // 用 parseFamilyList 再拼一遍：把用户输入里的畸形部分（空项 / 通用族 / 引号）规范化，
    // 保证存下来的一定是「干净的族列表」。
    latinFont: familyListInput(latinRaw),
    cjkFont: familyListInput(cjkRaw),
    fontSize: size,
  };
}

/** 规范化用户输入的族列表（保持逗号分隔的字符串形态，空串 = 默认）。 */
export function familyListInput(raw: string): string {
  return parseFamilyList(raw ?? "").join(", ");
}

/** 读取设置（含从旧版 `lv-fontsize` 迁移）。浏览器不可用时给默认值。 */
export function readSettings(): AppSettings {
  let raw: string | null = null;
  let legacy: string | null = null;
  try {
    raw = localStorage.getItem(SETTINGS_KEY);
    legacy = localStorage.getItem(LEGACY_FONT_SIZE_KEY);
  } catch {
    /* localStorage 不可用（隐私模式 / 非浏览器）：用默认值 */
    return { ...DEFAULT_SETTINGS };
  }
  if (raw == null) {
    // 首次启动 / 从旧版本升级：老字号迁移进来，字体保持默认。
    const legacySize = legacy == null ? undefined : Number(legacy);
    return parseSettings(null, legacySize);
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* 存档被写坏：当作没有设置 */
  }
  const legacySize = legacy == null ? undefined : Number(legacy);
  return parseSettings(parsed, legacySize);
}

/** 写入设置（失败静默：设置丢不了命）。 */
export function writeSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

/**
 * 把字体设置写进根元素的 CSS 变量。
 *
 * 写在 `documentElement` 上而不是 `.loglens` 容器上：菜单 / 拖影等经 `createPortal`
 * 挂到 `document.body` 的浮层在 `.loglens` 之外，写在容器上它们拿不到新字体。
 * 字号走 `--log-font-size`（由 App 内联在容器上，各视图共用），这里只管字体族。
 */
export function applyFontSettings(settings: AppSettings): void {
  if (typeof document === "undefined") {
    return;
  }
  const style = document.documentElement.style;
  style.setProperty("--font-latin", buildFamilyList(settings.latinFont, DEFAULT_LATIN_FAMILIES));
  style.setProperty("--font-cjk", buildFamilyList(settings.cjkFont, DEFAULT_CJK_FAMILIES));
}

/** 当前设置解析出的完整字体栈（设置界面用来展示「实际生效的字体栈」）。 */
export function resolveFontStack(settings: AppSettings): string {
  return buildFontStack(settings.latinFont, settings.cjkFont);
}
