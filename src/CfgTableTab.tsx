import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { computeColumnWidths } from "./cfg-columns";
import { fmtValue } from "./cfg-types";
import type { ClientCfgTable, CfgColumn, CfgValue } from "./cfg-types";
import { langOfPath } from "./cfg-types";

// 这些类型/纯函数已拆到 cfg-types.ts / cfg-columns.ts，此处原样再导出，
// 保持既有 import 路径（App.tsx 等）不变。
export type { ClientCfgTable, CfgColumn, CfgValue };
export { fmtValue, computeColumnWidths };

async function copyTextToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
}

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

export function CfgTableTab({
  tabId,
  path,
  data,
  error,
  active,
  fontSize,
  uiLang,
  onPickSchema,
  onSwitchViewMode,
  registerCopy,
  reportTotal,
}: {
  tabId: string;
  path: string;
  /** 解析成功的表格数据；null = 尚未解析成功。 */
  data: ClientCfgTable | null;
  /** 解析失败信息（有值时显示错误面板）。 */
  error?: string;
  active: boolean;
  fontSize: number;
  /** 界面语言（App 全局设置，与配置数据语言无关）。 */
  uiLang: "zh" | "en";
  /** 用户手动选择 cfg_table_slots.json（解析失败/想换表时）。 */
  onPickSchema: () => void;
  /** 打开视图模式选择框（切回文本视图的唯一入口，工具栏最左侧图标按钮）。 */
  onSwitchViewMode: () => void;
  registerCopy: (tabId: string, fn: (() => Promise<string>) | null) => void;
  reportTotal: (tabId: string, total: number | null) => void;
}) {
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

  // 激活时上报行数（右上角“N 行”显示）+ 注册“复制当前视图”（TSV）。
  useEffect(() => {
    if (!active) {
      return;
    }
    if (data) {
      reportTotal(tabId, rows.length);
      registerCopy(tabId, async () => {
        const lines: string[] = [];
        lines.push(["key", ...columns.map((c) => c.name)].join("\t"));
        for (let i = 0; i < rows.length; i++) {
          lines.push(
            [String(data.keys[i] ?? ""), ...rows[i].map((cell) => fmtValue(cell))].join("\t")
          );
        }
        await copyTextToClipboard(lines.join("\r\n"));
        return lines.join("\r\n");
      });
    } else {
      reportTotal(tabId, null);
    }
    return () => {
      reportTotal(tabId, null);
      registerCopy(tabId, null);
    };
  }, [active, data, rows.length, tabId, registerCopy, reportTotal, columns]);

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
