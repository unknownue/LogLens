import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

// ==================== 类型（与后端 client_cfg.rs 序列化对齐） ====================

/** 单元格值（tagged JSON：t=类型，v=值）。 */
export interface CfgValue {
  t:
    | "null"
    | "bool"
    | "byte"
    | "int"
    | "uint"
    | "long"
    | "ulong"
    | "short"
    | "ushort"
    | "float"
    | "double"
    | "str"
    | "array"
    | "dict"
    | "set";
  v: unknown;
}

export interface CfgColumn {
  name: string;
  field_type: string;
}

export interface ClientCfgTable {
  name: string;
  columns: CfgColumn[];
  keys: number[];
  rows: CfgValue[][];
}

/** 把单元格值渲染成表格文本。 */
export function fmtValue(v: CfgValue | undefined | null): string {
  if (v == null || v.t === "null") {
    return "";
  }
  switch (v.t) {
    case "str":
      return String(v.v);
    case "bool":
      return v.v ? "true" : "false";
    case "array":
      return (v.v as CfgValue[]).map(fmtValue).join(", ");
    case "set":
      return (v.v as CfgValue[]).map(fmtValue).join(", ");
    case "dict":
      return (v.v as [CfgValue, CfgValue][])
        .map(([k, x]) => `${fmtValue(k)}: ${fmtValue(x)}`)
        .join(", ");
    default:
      return String(v.v);
  }
}

/** 从路径提取语言目录（.../client_cfg/<lang>/xxx.bin → <lang>）。 */
function langOfPath(path: string): string | null {
  const m = path.toLowerCase().match(/[\\/]client_cfg[\\/]([^\\/]+)[\\/][^\\/]+\.bin$/);
  return m ? m[1] : null;
}

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

export function CfgTableTab({
  tabId,
  path,
  data,
  error,
  active,
  fontSize,
  uiLang,
  onPickSchema,
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

  // 整表宽度：固定列宽 + 自适应；表头/表体用同一列宽（CSS grid）。
  const gridTemplate = useMemo(() => {
    const cols = ["64px", ...columns.map(() => "minmax(90px, 220px)")];
    return cols.join(" ");
  }, [columns]);

  if (error) {
    return (
      <div className="cfg-tab">
        <div className="cfg-toolbar">
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
            style={{
              display: "grid",
              gridTemplateColumns: gridTemplate,
              position: "sticky",
              top: 0,
              height: rowHeight,
              width: "max-content",
              minWidth: "100%",
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
