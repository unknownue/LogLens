// cfg-columns.ts — 配置表列宽计算（从 CfgTableTab 抽出的纯函数）。
//
// 表格用的是等宽字体（`Consolas` / `Courier New`），所以按「字符数 × 字宽」估算
// 与实际渲染宽度高度一致，不需要为了量宽度先渲染一遍 DOM。
// 抽成独立模块还有个好处：可以脱离浏览器直接用 node --experimental-strip-types 测试。

// 显式写 .ts 后缀：让这个模块既能被 Vite/tsc 打包，
// 也能被 `node --experimental-strip-types` 直接加载（Node 的 ESM 解析器不补后缀）。
import type { CfgColumn, CfgValue } from "./cfg-types.ts";
import { fmtValue } from "./cfg-types.ts";

/** 单元格左右内边距之和（与 .cfg-cell 的 padding: 3px 8px 对齐）。 */
export const CELL_PADDING_X = 16;
/** 行高亮/边框等留一点余量，避免文字刚好顶到边界。 */
export const CELL_FUDGE = 2;
/** 列宽下限：比表头文字还窄会很难看。 */
export const MIN_COL_W = 72;
/** 列宽上限：单个超长值（数组/字典串）不应把整列撑开、把其它列挤出屏幕。 */
export const MAX_COL_W = 600;
/** keys 列的上下限。 */
export const MIN_KEY_W = 48;
export const MAX_KEY_W = 200;

/**
 * 按内容估算一段文本的像素宽度。
 *
 * 中日韩字符在等宽字体下是整宽，单独计。这套比例与日志视图的
 * `estimateTextWidth` 保持一致，避免两处宽度口径不一致。
 */
export function measureTextWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) {
    w += ch.charCodeAt(0) > 0xff ? fontSize * 1.1 : fontSize * 0.55;
  }
  return w;
}

/**
 * 计算每列的像素宽度：取「表头（含类型名）」与「该列所有单元格」的最大内容宽度。
 *
 * 原先用的是写死的 `minmax(90px, 220px)`：短值（数字/布尔）白占 90px，
 * 长值（字符串/数组）又会在 220px 处被省略号截断。改为按实际内容定宽后，
 * 窄列收紧、宽列放得下，常见配置表不再需要横向滚动。
 *
 * 表头里还显示字段类型（`.cfg-ftype`，比单元格小 1px），所以表头按
 * 「列名宽度 + 6px 间距 + 类型名宽度」估。
 */
export function computeColumnWidths(
  columns: CfgColumn[],
  rows: CfgValue[][],
  keys: number[],
  fontSize: number
): { keyWidth: number; colWidths: number[] } {
  const cellFont = fontSize;
  const headFont = Math.max(9, fontSize - 1);

  let maxKey = measureTextWidth("key", headFont);
  for (let i = 0; i < rows.length; i++) {
    const k = keys[i];
    if (k == null) {
      continue;
    }
    const w = measureTextWidth(String(k), cellFont);
    if (w > maxKey) {
      maxKey = w;
    }
  }
  const keyWidth = Math.min(
    MAX_KEY_W,
    Math.max(MIN_KEY_W, Math.round(maxKey) + CELL_PADDING_X + CELL_FUDGE)
  );

  const colWidths = columns.map((c, ci) => {
    // 表头：列名 + 类型名（两者之间还有 6px 间距）
    let widest =
      measureTextWidth(c.name, headFont) + 6 + measureTextWidth(c.field_type, headFont);
    for (let ri = 0; ri < rows.length; ri++) {
      const w = measureTextWidth(fmtValue(rows[ri]?.[ci]), cellFont);
      if (w > widest) {
        widest = w;
      }
    }
    return Math.min(
      MAX_COL_W,
      Math.max(MIN_COL_W, Math.round(widest) + CELL_PADDING_X + CELL_FUDGE)
    );
  });

  return { keyWidth, colWidths };
}
