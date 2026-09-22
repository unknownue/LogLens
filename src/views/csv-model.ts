/**
 * CSV 表格的**数据模型与显示规则**（纯函数，不碰 React / 后端，可在 Node 里单测）。
 *
 * 后端（`src-tauri/src/csv_table.rs`）只回一份「行矩阵」：含表头行、行长度可能不等、
 * 所有单元格都是字符串。**表头 / 数据的分界留在前端**，好处是「首行为表头」这个开关
 * 是纯前端状态 —— 切一下不用重读文件、不用重新解析（200 万行的表重读代价可不小）。
 */

// 列宽的估算口径与配置表视图共用（等宽字体下按字符数估宽），见 src/cfg-columns.ts。
import {
  CELL_FUDGE,
  CELL_PADDING_X,
  MAX_COL_W,
  MIN_COL_W,
  measureTextWidth,
} from "../cfg-columns.ts";

/** 后端的 `parse_csv_table` 返回负载（字段名与 Rust 侧对齐）。 */
export interface CsvTable {
  /** 原始行（含可能的表头行；行长度不等，取不到的按空串处理）。 */
  rows: string[][];
  /** 列数（全表最长的一行）。 */
  width: number;
  /** 实际使用的分隔符（单字符）。 */
  delimiter: string;
  /** 是否只解析了文件的一部分（触到行数 / 字节上限）。 */
  truncated: boolean;
  /** 生效的行数上限（截断横幅要显示这个数字）。 */
  max_rows: number;
  /** 文件真实字节数。 */
  bytes: number;
  /** 实际按哪种编码解出来的（自动探测的结果也在里面）。 */
  encoding?: {
    choice: string;
    id: string;
    name: string;
    note: string;
    group: string;
    source: string;
    bom: boolean;
  };
}

/** 界面语言（与 `body-view.ts` 的 `ViewLang` 同构，避免反向依赖）。 */
export type CsvLang = "zh" | "en";

/**
 * 单元格的**显示**文本：把单元格内的制表符与换行换成可见记号。
 *
 * 表格的行高是固定的（虚拟滚动按固定行高布局），一个含换行的单元格会把那一行撑开、
 * 与虚拟行高打架。CSV 里带换行的单元格是合法的（引号包裹的多行文本），所以不能
 * 简单丢掉换行 —— 显示成 `␊` 既保住单行排版，又在界面上明说「这里还有内容」，
 * 完整原文在单元格的悬停提示里。
 */
export function csvCellText(raw: string | undefined): string {
  if (!raw) {
    return "";
  }
  return raw.replace(/\r\n|\r|\n/g, "␊").replace(/\t/g, "⇥");
}

/** 表头行（`headers` 为真且确有首行时）。 */
function headerRow(t: CsvTable, headers: boolean): string[] | null {
  return headers && t.rows.length > 0 ? t.rows[0] : null;
}

/**
 * 数据行数（表格视图右上角的「N 行 × M 列」用）。
 *
 * 注意与「后端解析到的行数」的差别：勾了「首行为表头」时首行是表头，不算数据行。
 */
export function csvDataRowCount(t: CsvTable, headers: boolean): number {
  return Math.max(0, t.rows.length - (headerRow(t, headers) ? 1 : 0));
}

/** 数据行（`headers` 为真时跳过首行）。返回的是原数组，**不复制**。 */
export function csvBodyRows(t: CsvTable, headers: boolean): string[][] {
  return headerRow(t, headers) ? t.rows.slice(1) : t.rows;
}

/**
 * 每列的表头文本：
 *
 * - 勾了「首行为表头」→ 用首行的文字；
 * - 没勾 / 该单元格是空的 → 生成「列1」「列2」…（英文 `Col1`）。
 *
 * 为什么空表头也要生成名字：Excel 导出的表常有列名缺失，一个没有名字的列在界面上
 * 就是「一片空白」，用户既没法指着它说话，也看不出这里其实是一列。
 *
 * 列数取 `max(表头长度, width)`：数据行比表头长时必须照样画出那些列，否则多出来的
 * 数据会静默消失 —— 那才是真正的数据损失。
 */
export function csvHeaderCells(t: CsvTable, headers: boolean, lang: CsvLang): string[] {
  const first = headerRow(t, headers);
  const count = Math.max(t.width, first?.length ?? 0);
  const generated = (i: number) => `${lang === "zh" ? "列" : "Col"}${i + 1}`;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = first?.[i]?.trim();
    out.push(name ? name : generated(i));
  }
  return out;
}

/** 数据行的第 `ci` 列显示文本（行比列短时是空串）。 */
export function csvBodyCell(row: string[] | undefined, ci: number): string {
  return csvCellText(row?.[ci]);
}

/**
 * 把整张表复制成 TSV（与配置表视图同款：首行表头 + 全部数据行）。
 *
 * 单元格内的制表符 / 换行替换为空格：TSV 的单元格分隔符就是制表符、行分隔符是换行，
 * 原样拼进去会把「一个单元格」粘贴成「两行两列」。表格视图的剪贴板是**表格**格式，
 * 目标是把数据完整地贴进 Excel，而不是逐字节还原源文件。
 */
export function csvToTsv(t: CsvTable, headers: boolean, lang: CsvLang): string {
  const flat = (s: string) => s.replace(/[\t\r\n]+/g, " ");
  const lines: string[] = [csvHeaderCells(t, headers, lang).map(flat).join("\t")];
  for (const row of csvBodyRows(t, headers)) {
    const cells: string[] = [];
    for (let i = 0; i < Math.max(t.width, row.length); i++) {
      cells.push(flat(row[i] ?? ""));
    }
    lines.push(cells.join("\t"));
  }
  return lines.join("\r\n");
}

/** 一个文件大小的可读文本（截断横幅里显示）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ==================== 列宽 ====================
//
// 与配置表视图（src/cfg-columns.ts）是同一套观感：等宽字体下按「字符数 × 字宽」估宽，
// 表头与表体各自成格，所以宽度必须显式算成同一个值，否则两处列宽对不齐。

/** 列宽计算时最多扫描多少行（均匀采样，见 [`computeCsvColumnWidths`]）。 */
export const WIDTH_SAMPLE_ROWS = 2000;

/**
 * 按表头 + 采样内容估算每一列的像素宽度。
 *
 * 为什么采样而不是扫全表：配置表最多几万行、且早有既有的全扫实现；CSV 这边上限是
 * 20 万行 × 任意列数，全扫（20 万 × 20 列 = 400 万次文本测量）会让「打开文件」
 * 明显卡一下 —— 而列宽只是观感问题，不值得付这个代价。均匀跳行采样后，
 * 每列最多测 [`WIDTH_SAMPLE_ROWS`] 行，代价与表大小无关。
 *
 * 代价：某列若只有「没被采样到的那几行」特别长，会被按 [`MAX_COL_W`] 截断显示
 * （单元格悬停有完整原文）。这个取舍在 docs/csv-view.md 里写明了。
 */
export function computeCsvColumnWidths(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  fontSize: number
): number[] {
  const headFont = Math.max(9, fontSize - 1);
  const step = Math.max(1, Math.ceil(rows.length / WIDTH_SAMPLE_ROWS));
  return headers.map((name, ci) => {
    let widest = measureTextWidth(name, headFont);
    for (let ri = 0; ri < rows.length; ri += step) {
      const w = measureTextWidth(csvCellText(rows[ri]?.[ci]), fontSize);
      if (w > widest) {
        widest = w;
      }
    }
    return Math.min(
      MAX_COL_W,
      Math.max(MIN_COL_W, Math.round(widest) + CELL_PADDING_X + CELL_FUDGE)
    );
  });
}
