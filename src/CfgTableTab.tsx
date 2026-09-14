import { useCallback, useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { copyTextToClipboard } from "./clipboard";
import { computeColumnWidths } from "./cfg-columns";
import { fmtValue } from "./cfg-types";
import type { ClientCfgTable, CfgColumn, CfgValue } from "./cfg-types";
import { langOfPath } from "./cfg-types";
import { useBodyViewEffects, type BodyViewProps, type ViewLang } from "./views";

// 这些类型/纯函数已拆到 cfg-types.ts / cfg-columns.ts，此处原样再导出，
// 保持既有 import 路径（App.tsx 等）不变。
export type { ClientCfgTable, CfgColumn, CfgValue };
export { fmtValue, computeColumnWidths };

// ==================== 组件 ====================

const BASE_ROW_HEIGHT = 26;

/**
 * 工具栏最左侧的「切换视图」图标按钮。
 * 表格视图下它是切回文本视图的唯一入口，所以三条渲染分支（解析中/解析失败/正常）
 * 都必须带上它 —— 否则解析失败时用户会被困在表格视图里。
 * 图标表示「将要切到的视图」：当前表格 → 显示文本图标。
 */
function ViewToggleButton({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button
      className="icon-btn toolbar-icon view-toggle on"
      onClick={onClick}
      aria-pressed={true}
      title={title}
    >
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
        <path d="M2.5 3.5h11M2.5 8h11M2.5 12.5h6" stroke="currentColor" strokeWidth="1.55" />
      </svg>
    </button>
  );
}

/** 表格视图的专属属性（`lang` 在本页叫 `uiLang`：与配置数据语言区分）。 */
export interface CfgTableTabProps
  extends Pick<
    BodyViewProps,
    | "tabId"
    | "path"
    | "active"
    | "fontSize"
    | "onSwitchViewMode"
    | "registerCopy"
    | "reportTotal"
  > {
  /** 界面语言（App 全局设置，与配置数据语言无关）。 */
  uiLang: ViewLang;
  /** 解析成功的表格数据；null = 尚未解析成功。 */
  data: ClientCfgTable | null;
  /** 解析失败信息（有值时显示错误面板）。 */
  error?: string;
  /** 用户手动选择 cfg_table_slots.json（解析失败/想换表时）。 */
  onPickSchema: () => void;
}

export function CfgTableTab(props: CfgTableTabProps) {
  // tabId / active / registerCopy / reportTotal 由公共生命周期 hook 直接从 props 取，
  // 这里只解构渲染真正用到的字段。
  const { path, data, error, fontSize, uiLang, onPickSchema, onSwitchViewMode } = props;
  const zh = uiLang === "zh";
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = data?.rows ?? [];
  const columns = data?.columns ?? [];

  // 行高随字体调整；表头（sticky）与行等高。
  const rowHeight = Math.max(BASE_ROW_HEIGHT, fontSize + 12);

  // 虚拟滚动：表格可能很大（几十万行配置），只渲染可视区。
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

  // 复制当前表格为 TSV（首行 key + 全部数据行）；行数一起供右上角显示。
  const copyAsTsv = useCallback(async (): Promise<string> => {
    if (!data) {
      return "";
    }
    const lines: string[] = [["key", ...columns.map((c) => c.name)].join("\t")];
    for (let i = 0; i < rows.length; i++) {
      lines.push(
        [String(data.keys[i] ?? ""), ...rows[i].map((cell) => fmtValue(cell))].join("\t")
      );
    }
    const text = lines.join("\r\n");
    await copyTextToClipboard(text);
    return text;
  }, [data, columns, rows]);

  // 激活时注册「复制当前视图」并上报行数；失活 / 卸载时由 hook 注销。
  // 尚未解析出数据时两者都不适用（reportTotal(null) 会清空右上角的行数显示）。
  useBodyViewEffects(props, {
    copy: data ? copyAsTsv : null,
    total: data ? rows.length : null,
  });

  const cfgLang = langOfPath(path);

  // 列宽：按表头 + 全表内容算出的固定像素，表头/表体用同一套（CSS grid 各自成格，
  // 不共用轨道，所以必须显式算出同样的宽度，否则两处列宽会对不齐）。
  // 依赖 rows/columns/fontSize：换表、重新解析、调字号都会重算。
  const { keyWidth, colWidths } = useMemo(
    () => computeColumnWidths(columns, rows, data?.keys ?? [], fontSize),
    [columns, rows, data?.keys, fontSize]
  );

  const gridTemplate = useMemo(() => {
    const cols = [`${keyWidth}px`, ...colWidths.map((w) => `${w}px`)];
    return cols.join(" ");
  }, [keyWidth, colWidths]);

  // 整表预计宽度：给 sticky 表头一个显式宽度，
  // 保证它不会比表体窄（否则横向滚动到右侧时最后几列表头会缺失）。
  const tableWidth = useMemo(
    () => keyWidth + colWidths.reduce((a, b) => a + b, 0),
    [keyWidth, colWidths]
  );

  if (error) {
    return (
      <div className="cfg-tab">
        <div className="cfg-toolbar">
          <ViewToggleButton title={zh ? "切换视图模式" : "Switch view mode"} onClick={onSwitchViewMode} />
          <span className="cfg-name">{path.split(/[\\/]/).pop()}</span>
          <span className="cfg-actions">
            <button className="cfg-btn" onClick={onPickSchema} title={error}>
              {zh ? "选择 schema…" : "Choose schema…"}
            </button>
          </span>
        </div>
        <div className="cfg-error">
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="cfg-tab">
        <div className="cfg-toolbar">
          <ViewToggleButton title={zh ? "切换视图模式" : "Switch view mode"} onClick={onSwitchViewMode} />
          <span className="cfg-name">{path.split(/[\\/]/).pop()}</span>
        </div>
        <div className="cfg-error">
          <p>{zh ? "解析中…" : "Parsing…"}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="cfg-tab">
      <div className="cfg-toolbar">
        <ViewToggleButton title={zh ? "切换视图模式" : "Switch view mode"} onClick={onSwitchViewMode} />
        <span className="cfg-name" title={path}>
          {data.name}
        </span>
        {cfgLang ? <span className="cfg-lang">{cfgLang}</span> : null}
        <span className="cfg-count">
          {zh ? `${rows.length} 行 × ${columns.length} 列` : `${rows.length} rows × ${columns.length} cols`}
        </span>
        <span className="cfg-actions">
          <button className="cfg-btn" onClick={onPickSchema}>
            {zh ? "重选 schema" : "Re-pick schema"}
          </button>
        </span>
      </div>
      <div className="cfg-scroll" ref={scrollRef} style={{ "--log-font-size": `${fontSize}px` } as React.CSSProperties}>
        <div className="cfg-inner" style={{ height: virtualizer.getTotalSize(), width: "max-content", minWidth: "100%" }}>
          {/* 表头（粘在滚动容器顶部；高度与行高一致，scrollMargin 已为其预留偏移） */}
          <div
            className="cfg-head"
            data-testid="cfg-head"
            data-col-widths={colWidths.join(",")}
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
            <div className="cfg-cell cfg-head-cell">key</div>
            {columns.map((c) => (
              <div className="cfg-cell cfg-head-cell" key={c.name} title={`${c.name}: ${c.field_type}`}>
                {c.name}
                <span className="cfg-ftype">{c.field_type}</span>
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
                style={{
                  display: "grid",
                  gridTemplateColumns: gridTemplate,
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "max-content",
                  minWidth: "100%",
                  height: rowHeight,
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                <div className="cfg-cell cfg-key">{String(data.keys[vi.index] ?? "")}</div>
                {columns.map((c, ci) => (
                  <div className="cfg-cell" key={c.name} title={fmtValue(row?.[ci])}>
                    {fmtValue(row?.[ci])}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
