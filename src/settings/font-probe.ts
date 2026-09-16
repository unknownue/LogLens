/**
 * font-probe.ts — 用 canvas 量宽度探测「系统里到底装没装这个字体」。
 *
 * 为什么不用 `document.fonts.check()`：它只回答「FontFaceSet 里有没有这一项」，
 * 对**系统已安装**的字体（本应用只用系统字体，不加载字体文件）在 Chromium 上
 * 一律返回 true，无法区分「装了」和「没装但能用回退画出来」。
 *
 * 可靠的做法是量宽度：同一段文字，用 `"候选字体", 通用族` 与只用 `通用族` 各量一次 ——
 * 候选字体不存在时两者必然相等（都走了回退），存在时几乎不可能相等。为降低
 * 「候选字体恰好与回退字体同宽」的假阴性，这里对 3 个通用族 × 2 个样本串
 * （西文串 + 中文串）交叉验证，任意一组不同即认定已安装。
 *
 * 探测结果按族名缓存：一次设置界面渲染最多几十次测量，可忽略不计，但没必要重复。
 */

import { fontOptions, type FontOption, type FontRole } from "./font-catalog.ts";

/** 西文样本串：混入宽窄不同的字符，放大不同字体之间的宽度差。 */
const LATIN_PROBE = "mmmmmmmmmmlliWQ@#0123456789";
/** 中文样本串：用来判断一个字体是否自带中文字形。 */
const CJK_PROBE = "中文日志字体测检";
/** 用于对照的通用族（候选字体不存在时，三者必然各自回到自己的默认字体）。 */
const BASE_FAMILIES = ["monospace", "sans-serif", "serif"] as const;
/** 探测字号：72px 让宽度差足够显著（远大于亚像素舍入）。 */
const PROBE_PX = 72;

/** 一个候选字体的探测结果。 */
export interface ProbedFont extends FontOption {
  /** 系统里是否安装了该字体。 */
  installed: boolean;
}

const installedCache = new Map<string, boolean>();
const cjkCache = new Map<string, boolean>();
const monoCache = new Map<string, boolean>();

/** 取一个 2D 上下文（拿不到时返回 null：调用方按「未知」处理，不要过滤候选）。 */
function context(): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") {
    return null;
  }
  try {
    const canvas = document.createElement("canvas");
    return canvas.getContext("2d");
  } catch {
    return null;
  }
}

/** 用给定 font 简写量一段文字的宽度。 */
function measure(ctx: CanvasRenderingContext2D, font: string, text: string): number {
  ctx.font = font;
  return ctx.measureText(text).width;
}

/** 该字体族在系统里可用吗？ */
export function isFamilyInstalled(family: string): boolean {
  const name = (family ?? "").trim();
  if (!name) {
    return false;
  }
  const key = name.toLowerCase();
  const cached = installedCache.get(key);
  if (cached != null) {
    return cached;
  }
  const ctx = context();
  if (!ctx) {
    // 拿不到 canvas（非浏览器）：当作「已安装」，宁可让候选列表完整，也不要空表。
    return true;
  }
  let installed = false;
  const samples = [LATIN_PROBE, CJK_PROBE];
  for (const base of BASE_FAMILIES) {
    const baseWidths = samples.map((s) => measure(ctx, `${PROBE_PX}px ${base}`, s));
    const testWidths = samples.map((s) => measure(ctx, `${PROBE_PX}px "${name}", ${base}`, s));
    if (baseWidths.some((w, i) => Math.abs(w - testWidths[i]) > 0.01)) {
      installed = true;
      break;
    }
  }
  installedCache.set(key, installed);
  return installed;
}

/**
 * 该字体自带中文字形吗？
 *
 * ⚠️ 这条启发式**只对西文字体可靠**，中文字体会漏报：汉字在所有中文字体里都是
 * 一个 em 宽，候选字体在不在、是不是中文字体，量出来的宽度都等于系统中文回退字体
 * 的宽度，区分不出来。所以：
 *   - 系统字体列表里的字体一律用后端给的事实（DirectWrite `HasCharacter`，
 *     见 `src-tauri/src/fonts.rs`）；
 *   - 这里只用于**用户手输的、列表里没有的**字体名（此时返回 false 是保守的：
 *     少给一条提示，不会给错提示）。
 */
export function familyProvidesCjk(family: string): boolean {
  const name = (family ?? "").trim();
  if (!name) {
    return false;
  }
  const key = name.toLowerCase();
  const cached = cjkCache.get(key);
  if (cached != null) {
    return cached;
  }
  const ctx = context();
  if (!ctx) {
    return false;
  }
  let provides = false;
  for (const base of BASE_FAMILIES) {
    const baseWidth = measure(ctx, `${PROBE_PX}px ${base}`, CJK_PROBE);
    const testWidth = measure(ctx, `${PROBE_PX}px "${name}", ${base}`, CJK_PROBE);
    if (Math.abs(baseWidth - testWidth) > 0.01) {
      provides = true;
      break;
    }
  }
  cjkCache.set(key, provides);
  return provides;
}

/**
 * 该字体族是等宽的吗？
 *
 * 量 10 个 `i` 与 10 个 `W`：等宽字体两者等宽，比例字体差得很远。
 * 字体未安装时量到的是回退字体，结论无意义 —— 调用方应先用 {@link isFamilyInstalled} 过滤。
 */
export function isMonospaceFamily(family: string): boolean {
  const name = (family ?? "").trim();
  if (!name) {
    return false;
  }
  const key = name.toLowerCase();
  const cached = monoCache.get(key);
  if (cached != null) {
    return cached;
  }
  const ctx = context();
  if (!ctx) {
    return false;
  }
  const narrow = measure(ctx, `${PROBE_PX}px "${name}"`, "iiiiiiiiii");
  const wide = measure(ctx, `${PROBE_PX}px "${name}"`, "WWWWWWWWWW");
  const mono = Math.abs(narrow - wide) < 0.5;
  monoCache.set(key, mono);
  return mono;
}

/** 候选表 + 安装状态（设置界面用它给字体分组、标「未安装」）。 */
export function probeFontOptions(role: FontRole): ProbedFont[] {
  return fontOptions(role).map((option) => ({
    ...option,
    installed: isFamilyInstalled(option.family),
  }));
}

/** 清空探测缓存（仅测试用：同一进程里换字体环境后需要重新探测）。 */
export function resetFontProbeCache(): void {
  installedCache.clear();
  cjkCache.clear();
  monoCache.clear();
}
