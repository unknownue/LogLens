/**
 * 共用表格网格：粘性表头 + 虚拟滚动行 + 内容定宽列。
 *
 * 表格视图有两种解析后端（配置表 bin / CSV 文本，见 `table-kind.ts`），但**长得一样**：
 * 同一套 `.cfg-*` 样式（css 里那一组类的名字沿用最早的 cfg- 前缀，现在是表格视图共用）、
 * 同一套列宽口径、同一套「表头 sticky + 只渲染可视行」的虚拟滚动。
 * 这套网格只写一遍 —— 两份拷贝最容易出的问题是其中一份在改行高 / scrollMargin 时
 * 忘了同步，表现为两个视图一个滚动条对得齐、一个对不齐。
 *
 * 组件是纯展示层：数据、列宽、单元格文本都由调用方给（配置表走 `fmtValue`、
 * CSV 走 `csvCellText`），这里不认识任何一种表格的业务。
 */

import { useEffect, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

/** 表头列。 */
export interface TableGridColumn {
  /** 列名（表头第一行）。 */
  name: string;
  /** 表头里的小字（配置表是字段类型；CSV 没有）。 */
  sub?: string;
  /** 表头的悬停提示（缺省：有 `sub` 时是 `name: sub`，否则就是 `name`）。 */
  title?: string;
}

export interface TableGridProps<T> {
  /** 列定义（顺序即列顺序）。 */
  columns: readonly TableGridColumn[];
  /** 数据行。 */
  rows: readonly T[];
  /**
   * 单元格显示文本。
   *
   * 用回调而不是「先铺平成 string[][]」：行数上限是 20 万，预先给每个单元格算出
   * 显示文本，等于把只对可见行做的工作放大到全表。虚拟滚动保证这里只被调用
   * 「可视行 × 列数」次。
   */
  cellText: (row: T, rowIndex: number, colIndex: number) => string;
  /**
   * 单元格的渲染实现（缺省就是 `cellText` 的纯文本）。
   *
   * 给「查找命中」用：命中片段要包成 `<mark class="find-mark">`，而那是数据层的
   * 事（表格网格不认识搜索）。返回 `null`/`undefined` 时退回纯文本。
   */
  cellNode?: (row: T, rowIndex: number, colIndex: number, text: string) => ReactNode;
  /**
   * 当前定位到的单元格（表格视图的查找：步进到某一处就把它滚进视野）。
   *
   * 纵向按行滚到可视区中部（虚拟滚动），横向把该单元格拉到可视区内 —— 宽表里
   * 命中一个靠右的列时，只滚行不滚列等于什么都没看见。
   */
  focusCell?: { row: number; col: number } | null;
  /** 行首固定列的表头（配置表的 `key`）；不给就不渲染这一列。 */
  leadingHeader?: string;
  /** 行首固定列的单元格文本（与 `leadingHeader` 成对出现）。 */
  leadingText?: (row: T, rowIndex: number) => string;
  /** 列宽（px；含行首列）。由调用方用纯函数算好（可在 Node 里单测）。 */
  widths: readonly number[];
  /** 行高（px，随字号变化；表头与行等高）。 */
  rowHeight: number;
  /** 正文字号（写进 CSS 变量，与文本视图同一套字体设置）。 */
  fontSize: number;
  /** 表头的 data-testid（E2E 断言列宽用）。 */
  headTestId?: string;
}

/** 表格网格（见文件头注释）。 */
export function TableGrid<T>({
  columns,
  rows,
  cellText,
  cellNode,
  focusCell,
  leadingHeader,
  leadingText,
  widths,
  rowHeight,
  fontSize,
  headTestId,
}: TableGridProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 当前命中所在的单元格节点（横向滚动用）。 */
  const focusRef = useRef<HTMLDivElement | null>(null);
  /** 是否还需要把当前命中横向滚进视野：只在「命中变化后第一次渲染」做一次， */
  /** 免得用户自己横向滚动时被一直拽回来。 */
  const pendingHScroll = useRef(false);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    // sticky 表头占一行高度：scrollMargin 让虚拟项的 start 从表头之下开始。
    scrollMargin: rowHeight,
    overscan: 8,
  });

  // 行高变化（字体调整）后重新测量。
  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  // 查找步进：把当前命中那一行滚到可视区中部（虚拟滚动会顺带把它渲染出来）。
  const focusRow = focusCell?.row ?? null;
  useEffect(() => {
    if (focusRow == null || focusRow < 0 || focusRow >= rows.length) {
      return;
    }
    pendingHScroll.current = true;
    virtualizer.scrollToIndex(focusRow, { align: "center" });
    // 只认「定位目标变了」：用户随后自己滚动不应被反复拉回。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRow, focusCell?.col]);

  // 横向：该行渲染出来后（可能晚一拍），把命中的那一列拉进可视区。
  useEffect(() => {
    if (!pendingHScroll.current) {
      return;
    }
    const cell = focusRef.current;
    const scroll = scrollRef.current;
    if (!cell || !scroll) {
      return; // 还没渲染出来，等下一次渲染
    }
    pendingHScroll.current = false;
    const cellRect = cell.getBoundingClientRect();
    const viewRect = scroll.getBoundingClientRect();
    const pad = 8;
    if (cellRect.left < viewRect.left) {
      scroll.scrollLeft -= viewRect.left - cellRect.left + pad;
    } else if (cellRect.right > viewRect.right) {
      scroll.scrollLeft += cellRect.right - viewRect.right + pad;
    }
  });

  const hasLeading = leadingText != null;
  const gridTemplate = widths.map((w) => `${w}px`).join(" ");
  // 整表预计宽度：给 sticky 表头一个显式宽度，保证它不会比表体窄
  // （否则横向滚动到右侧时最后几列表头会缺失）。
  const tableWidth = widths.reduce((a, b) => a + b, 0);
  const rowStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: gridTemplate,
    position: "absolute",
    top: 0,
    left: 0,
    width: "max-content",
    minWidth: "100%",
    height: rowHeight,
  };

  return (
    <div
      className="cfg-scroll"
      ref={scrollRef}
      style={{ "--log-font-size": `${fontSize}px` } as React.CSSProperties}
    >
      <div
        className="cfg-inner"
        style={{ height: virtualizer.getTotalSize(), width: "max-content", minWidth: "100%" }}
      >
        {/* 表头（粘在滚动容器顶部；高度与行高一致，scrollMargin 已为其预留偏移） */}
        <div
          className="cfg-head"
          data-testid={headTestId}
          data-col-widths={widths.join(",")}
          style={{
            display: "grid",
            gridTemplateColumns: gridTemplate,
            position: "sticky",
            top: 0,
            height: rowHeight,
            width: "max-content",
            minWidth: tableWidth,
          }}
        >
          {hasLeading ? (
            <div className="cfg-cell cfg-head-cell">{leadingHeader ?? ""}</div>
          ) : null}
          {columns.map((c, ci) => (
            <div
              className="cfg-cell cfg-head-cell"
              key={`${ci}-${c.name}`}
              title={c.title ?? (c.sub ? `${c.name}: ${c.sub}` : c.name)}
            >
              {c.name}
              {c.sub ? <span className="cfg-ftype">{c.sub}</span> : null}
            </div>
          ))}
        </div>
        {/* 表体（虚拟行） */}
        {virtualizer.getVirtualItems().map((vi) => {
          const row = rows[vi.index];
          return (
            <div
              className="cfg-row"
              key={vi.key}
              style={{ ...rowStyle, transform: `translateY(${vi.start}px)` }}
            >
              {hasLeading ? (
                <div className="cfg-cell cfg-key">{leadingText(row, vi.index)}</div>
              ) : null}
              {columns.map((c, ci) => {
                const text = cellText(row, vi.index, ci);
                const focused = focusCell?.row === vi.index && focusCell?.col === ci;
                return (
                  <div
                    className="cfg-cell"
                    key={`${ci}-${c.name}`}
                    title={text}
                    ref={focused ? focusRef : undefined}
                    data-focus-cell={focused ? "1" : undefined}
                  >
                    {cellNode ? cellNode(row, vi.index, ci, text) : text}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
