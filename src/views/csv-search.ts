/**
 * CSV 表格的页内查找：在**已加载的行矩阵**里找命中的单元格（纯逻辑，可单测）。
 *
 * 与文本视图的区别：文本视图的搜索走后端（文件可能没全load、还要按过滤范围搜），
 * 而表格的数据本来就已经整份在前端（上限 20 万行），所以这里是纯前端扫描 ——
 * 不需要新命令，也不需要跨 IPC 的往返。
 */

import { matchesTerm, type SearchMatcher } from "../search/matcher.ts";

/** 一次命中：数据行下标 + 列下标（行下标与 `TableGrid` 的 `rows` 对齐）。 */
export interface CsvHit {
  row: number;
  col: number;
}

/** 命中上限。 */
export const CSV_FIND_CAP = 5000;

/** 扫描结果。 */
export interface CsvFindResult {
  /** 按「从上到下、从左到右」的顺序排列的命中（步进顺序就是它）。 */
  hits: CsvHit[];
  /** 是否因为命中上限而提前停止（UI 的计数要显示成 `5000+`）。 */
  capped: boolean;
}

/** 空结果（复用同一个冻结对象，避免每次渲染都新建）。 */
const EMPTY: CsvFindResult = { hits: [], capped: false };

/**
 * 扫描行矩阵，返回命中的单元格。
 *
 * - `rows` 是**数据行**（表头不参与搜索：它常驻在表头行里，跳过去没有意义）；
 * - 空搜索词直接返回空结果（「没输入」不等于「命中一切」）；
 * - 到 {@link CSV_FIND_CAP} 处停止：命中位置真正的用处是「跳过去看」，几千处已经
 *   远超人能逐个浏览的量，继续扫下去只会让大表的每次输入都白等。
 */
export function findCsvHits(
  rows: readonly (readonly string[])[],
  matcher: SearchMatcher,
  cap: number = CSV_FIND_CAP
): CsvFindResult {
  if (!matcher.term) {
    return EMPTY;
  }
  const hits: CsvHit[] = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (cell && matchesTerm(cell, matcher)) {
        hits.push({ row: r, col: c });
        if (hits.length >= cap) {
          return { hits, capped: true };
        }
      }
    }
  }
  return { hits, capped: false };
}

/** 把命中按行归组（`TableGrid` 渲染单元格时按「行 → 命中列集合」查表）。 */
export function groupHitsByRow(hits: readonly CsvHit[]): Map<number, Set<number>> {
  const byRow = new Map<number, Set<number>>();
  for (const hit of hits) {
    const cols = byRow.get(hit.row);
    if (cols) {
      cols.add(hit.col);
    } else {
      byRow.set(hit.row, new Set([hit.col]));
    }
  }
  return byRow;
}
