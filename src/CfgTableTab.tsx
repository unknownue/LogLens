import { useCallback, useMemo } from "react";

import { copyTextToClipboard } from "./clipboard";
import { computeColumnWidths } from "./cfg-columns";
import { fmtValue } from "./cfg-types";
import type { ClientCfgTable, CfgColumn, CfgValue } from "./cfg-types";
import { langOfPath } from "./cfg-types";
import {
  TableGrid,
  useBodyViewEffects,
  ViewToggleButton,
  type BodyViewProps,
  type ViewLang,
} from "./views";

// 这些类型/纯函数已拆到 cfg-types.ts / cfg-columns.ts，此处原样再导出，
// 保持既有 import 路径（App.tsx 等）不变。
export type { ClientCfgTable, CfgColumn, CfgValue };
export { fmtValue, computeColumnWidths };

// ==================== 组件 ====================

const BASE_ROW_HEIGHT = 26;

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

/**
 * 配置表页 —— 表格视图（`viewMode = "table"`）的**二进制**后端页面。
 *
 * 表格视图有两种后端（.bin → 本页；其它文本文件 → `CsvTableTab`），选择规则见
 * `views/table-kind.ts`。两者共用 `TableGrid`（网格与虚拟滚动）与 `.cfg-*` 样式，
 * 本页多出来的只有「schema 相关」的那几个入口。
 */
export function CfgTableTab(props: CfgTableTabProps) {
  // tabId / active / registerCopy / reportTotal 由公共生命周期 hook 直接从 props 取，
  // 这里只解构渲染真正用到的字段。
  const { path, data, error, fontSize, uiLang, onPickSchema, onSwitchViewMode } = props;
  const zh = uiLang === "zh";
  const rows = data?.rows ?? [];
  const columns = data?.columns ?? [];

  // 行高随字体调整；表头（sticky）与行等高。
  const rowHeight = Math.max(BASE_ROW_HEIGHT, fontSize + 12);

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

  // 网格的列定义与宽度（行首 key 列 + 各字段列）。
  const gridColumns = useMemo(
    () => columns.map((c) => ({ name: c.name, sub: c.field_type })),
    [columns]
  );
  const widths = useMemo(() => [keyWidth, ...colWidths], [keyWidth, colWidths]);

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
      <TableGrid
        columns={gridColumns}
        rows={rows}
        cellText={(row, _ri, ci) => fmtValue(row?.[ci])}
        leadingHeader="key"
        leadingText={(_row, ri) => String(data.keys[ri] ?? "")}
        widths={widths}
        rowHeight={rowHeight}
        fontSize={fontSize}
        headTestId="cfg-head"
      />
    </div>
  );
}
