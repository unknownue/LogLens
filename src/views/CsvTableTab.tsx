/**
 * CSV / TSV 表格页 —— 表格视图（`viewMode = "table"`）的**文本**后端页面。
 *
 * 与配置表页（`CfgTableTab`）的关系：两者共用同一个视图模式入口、同一套表格样式与
 * 同一个网格组件（`TableGrid`），区别只在「数据从哪来、工具栏上多什么」：
 * CSV 不需要 schema，但需要「分隔符」与「首行为表头」两个开关。
 *
 * 与其他页面的边界：读文件、解析、会话存档都在 App 侧（这里只拿结果），
 * 生命周期用 `useBodyViewEffects`（激活时注册「复制当前视图」/ 上报行数）。
 */

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { copyTextToClipboard } from "../clipboard";
import { findSpans } from "../search/matcher.ts";
import {
  computeCsvColumnWidths,
  csvBodyCell,
  csvBodyRows,
  csvDataRowCount,
  csvHeaderCells,
  csvToTsv,
  formatBytes,
  type CsvTable,
} from "./csv-model";
import { findCsvHits, groupHitsByRow, type CsvHit } from "./csv-search";
import { DELIMITERS, delimiterLabel } from "./table-kind";
import { TableGrid } from "./TableGrid";
import { useBodyViewEffects } from "./use-body-view";
import { ViewToggleButton } from "./ViewToggleButton";
import type { BodyViewProps, ViewLang } from "./body-view";

const BASE_ROW_HEIGHT = 26;

/** 页内查找的状态。 */
interface FindState {
  open: boolean;
  query: string;
  /** 区分大小写（Aa）。 */
  caseSensitive: boolean;
  /** 全字匹配（ab|）。 */
  wholeWord: boolean;
  /** 当前命中在命中表里的下标（0-based）；无命中时为 0。 */
  index: number;
}

const FIND_CLOSED: FindState = {
  open: false,
  query: "",
  caseSensitive: false,
  wholeWord: false,
  index: 0,
};

/** 页内文案（与 `CfgTableTab` / `MarkdownView` 一致：视图模块自带中英文案）。 */
const TEXT = {
  zh: {
    toggle: "切换视图模式",
    parsing: "解析中…",
    errorTitle: "表格解析失败",
    hint: "文件不是标准的表格文本时，先试着手动选一个分隔符再重新解析。",
    retry: "重新解析",
    reloadHint: "重新读取并解析当前文件（表格不跟随外部改动，文件被改过后点这里）",
    delimiter: "分隔符",
    headers: "首行为表头",
    headersHint: "勾选后首行作为表头显示（切换不需要重新读文件）",
    truncated: (shown: number, limit: number, size: string) =>
      `已截断：只解析了文件的前 ${shown} 行（上限 ${limit} 行；文件 ${size}）。更靠后的行请切到文本视图查看。`,
    rows: (n: number, cols: number) => `${n} 行 × ${cols} 列`,
    empty: "文件里没有可显示的行",
    find: "查找",
    findPlaceholder: "在表格中查找…",
    findCase: "区分大小写",
    findWholeWord: "全字匹配",
    findPrev: "上一处（Shift+Enter）",
    findNext: "下一处（Enter）",
    findClose: "关闭查找（Esc）",
    findCapped: (cap: number) => `${cap}+`,
  },
  en: {
    toggle: "Switch view mode",
    parsing: "Parsing…",
    errorTitle: "Failed to parse the table",
    hint: "If this file is not standard table text, pick a different delimiter and parse again.",
    retry: "Parse again",
    reloadHint: "Re-read and parse the file (the table does not follow external edits by itself)",
    delimiter: "Delimiter",
    headers: "First row is the header",
    headersHint: "Treat the first row as column names (no re-read needed)",
    truncated: (shown: number, limit: number, size: string) =>
      `Truncated: only the first ${shown} rows of the file are parsed (limit ${limit} rows; file ${size}). Use the text view for the rest.`,
    rows: (n: number, cols: number) => `${n} rows × ${cols} cols`,
    empty: "No rows to display",
    find: "Find",
    findPlaceholder: "Find in table…",
    findCase: "Match case",
    findWholeWord: "Match whole word",
    findPrev: "Previous match (Shift+Enter)",
    findNext: "Next match (Enter)",
    findClose: "Close find (Esc)",
    findCapped: (cap: number) => `${cap}+`,
  },
};

/** CSV 表格页的专属属性（公共属性见 `BodyViewProps`）。 */
export interface CsvTableTabProps
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
  /** 界面语言（与 `CfgTableTab.uiLang` 同义：与数据本身的语言无关）。 */
  lang: ViewLang;
  /** 解析结果；null = 尚未解析成功。 */
  data: CsvTable | null;
  /** 解析失败信息（有值时显示错误面板）。 */
  error?: string;
  /** 当前分隔符（单字符；`\t` 就是制表符）。 */
  delimiter: string;
  /** 是否把首行当表头。 */
  headers: boolean;
  /** 换分隔符（App 保存到该 tab 并重新解析）。 */
  onDelimiterChange: (delimiter: string) => void;
  /** 切「首行为表头」（纯前端状态，不重读文件）。 */
  onHeadersChange: (headers: boolean) => void;
  /** 重新解析（失败后重试 / 外部改过文件后刷新）。 */
  onReload: () => void;
}

export function CsvTableTab(props: CsvTableTabProps) {
  const { path, data, error, fontSize, lang, headers, onSwitchViewMode } = props;
  const t = TEXT[lang];
  const fileLabel = path.split(/[\\/]/).pop() || path;

  // 表头文本与数据行：都由「行矩阵 + 是否把首行当表头」这两件事决定（纯函数）。
  const columns = useMemo(
    () => (data ? csvHeaderCells(data, headers, lang) : []),
    [data, headers, lang]
  );
  const rows = useMemo(() => (data ? csvBodyRows(data, headers) : []), [data, headers]);

  // 列宽：按表头 + 采样内容估算（大表不全扫，见 computeCsvColumnWidths 的注释）。
  const widths = useMemo(
    () => computeCsvColumnWidths(columns, rows, fontSize),
    [columns, rows, fontSize]
  );

  // 行高随字体调整；表头（sticky）与行等高。
  const rowHeight = Math.max(BASE_ROW_HEIGHT, fontSize + 12);

  // ---- 页内查找（Ctrl+F） ----
  //
  // 命中是「单元格」：步进顺序从上到下、从左到右；当前命中所在的行会滚到可视区
  // 中部，靠右的列会被横向拉进视野（见 TableGrid 的 focusCell）。
  const [find, setFind] = useState<FindState>(FIND_CLOSED);
  const findInputRef = useRef<HTMLInputElement>(null);
  // 扫描的延迟版本：大表（20 万行）一次全扫要几十到几百毫秒，直接绑输入框会让
  // 每个字符都卡一下；`useDeferredValue` 让输入先回显，命中计数稍后跟上。
  const deferredQuery = useDeferredValue(find.query);
  const matcher = useMemo(
    () => ({ term: deferredQuery, caseSensitive: find.caseSensitive, wholeWord: find.wholeWord }),
    [deferredQuery, find.caseSensitive, find.wholeWord]
  );
  const { hits, capped } = useMemo(() => findCsvHits(rows, matcher), [rows, matcher]);
  const hitsByRow = useMemo(() => groupHitsByRow(hits), [hits]);
  // 命中表变了（换了搜索词 / 选项 / 重新解析）就回到第一处；步进只改 index，不回到这里。
  useEffect(() => {
    setFind((prev) => (prev.index === 0 ? prev : { ...prev, index: 0 }));
  }, [hits]);
  const currentHit: CsvHit | null =
    hits.length > 0 ? hits[Math.min(find.index, hits.length - 1)] : null;

  const openFind = useCallback(() => {
    setFind((prev) => ({ ...prev, open: true }));
  }, []);

  /**
   * 查找框打开后聚焦并全选。
   *
   * 必须放在 effect 里、而不是 `openFind` 里顺手调 `focus()`：`setFind` 之后 DOM 还没
   * 重新渲染，那一刻 ref 还是 null（Ctrl+F 第一次打开时输入框根本还不存在），
   * focus 静默失效 —— 表现为「按了 Ctrl+F，框出来了但光标不在里面，得再点一下」。
   */
  useEffect(() => {
    if (!find.open) {
      return;
    }
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, [find.open]);

  /** 上一处 / 下一处（循环）。 */
  const stepFind = useCallback(
    (delta: number) => {
      setFind((prev) => {
        if (hits.length === 0) {
          return prev;
        }
        return { ...prev, index: (prev.index + delta + hits.length) % hits.length };
      });
    },
    [hits.length]
  );

  // 键盘：Ctrl+F 打开（只在本 tab 激活时）、Esc 关闭、Enter / Shift+Enter 步进。
  useEffect(() => {
    if (!props.active) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        openFind();
      } else if (e.key === "Escape" && find.open) {
        setFind(FIND_CLOSED);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props.active, find.open, openFind]);

  // 复制当前表格为 TSV（表头 + 全部数据行，与配置表视图同口径）。
  const copyAsTsv = useCallback(async (): Promise<string> => {
    if (!data) {
      return "";
    }
    const text = csvToTsv(data, headers, lang);
    await copyTextToClipboard(text);
    return text;
  }, [data, headers, lang]);

  // 激活时注册「复制当前视图」并上报行数；失活 / 卸载时由 hook 注销。
  useBodyViewEffects(props, {
    copy: data ? copyAsTsv : null,
    total: data ? csvDataRowCount(data, headers) : null,
  });

  // ---- 解析失败：错误面板（保留分隔符工具，否则改不了导致失败的那个选择）----
  if (error) {
    return (
      <div className="cfg-tab">
        <div className="cfg-toolbar">
          <ViewToggleButton title={t.toggle} onClick={onSwitchViewMode} />
          <span className="cfg-name" title={path}>
            {fileLabel}
          </span>
          <DelimiterPicker {...props} />
          <span className="cfg-actions">
            <button className="cfg-btn" onClick={props.onReload}>
              {t.retry}
            </button>
          </span>
        </div>
        <div className="cfg-error" title={error}>
          <p className="cfg-error-title">{t.errorTitle}</p>
          <p>{error}</p>
          <p className="cfg-error-hint">{t.hint}</p>
        </div>
      </div>
    );
  }

  // ---- 还没解析出结果（切换视图 / 换分隔符时的一瞬间）----
  if (!data) {
    return (
      <div className="cfg-tab">
        <div className="cfg-toolbar">
          <ViewToggleButton title={t.toggle} onClick={onSwitchViewMode} />
          <span className="cfg-name" title={path}>
            {fileLabel}
          </span>
        </div>
        <div className="cfg-error">
          <p>{t.parsing}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="cfg-tab">
      <div className="cfg-toolbar">
        <ViewToggleButton title={t.toggle} onClick={onSwitchViewMode} />
        <span className="cfg-name" title={path}>
          {fileLabel}
        </span>
        <span className="cfg-count">{t.rows(rows.length, columns.length)}</span>
        <DelimiterPicker {...props} />
        <label className="cfg-check" title={t.headersHint}>
          <input
            type="checkbox"
            checked={headers}
            onChange={(e) => props.onHeadersChange(e.target.checked)}
          />
          {t.headers}
        </label>
        {/* 重新解析：CSV 表格不跟随文件变化（不做轮询），文件被外部改过就点这里重读。 */}
        <span className="cfg-actions">
          <button
            className={`cfg-btn${find.open ? " on" : ""}`}
            onClick={openFind}
            aria-pressed={find.open}
            title={`${t.find}（Ctrl+F）`}
          >
            {t.find}
          </button>
          <button className="cfg-btn" onClick={props.onReload} title={t.reloadHint}>
            {t.retry}
          </button>
        </span>
      </div>
      {data.truncated ? (
        <div className="cfg-banner">
          {t.truncated(data.rows.length, data.max_rows, formatBytes(data.bytes))}
        </div>
      ) : null}
      {rows.length === 0 && columns.length === 0 ? (
        <div className="cfg-error">
          <p>{t.empty}</p>
        </div>
      ) : (
        // 相对定位的包裹层：查找框悬浮在表格右上角（与文本视图的搜索框同一套样式）
        <div className="table-holder">
          <TableGrid
            columns={columns.map((name) => ({ name }))}
            rows={rows}
            cellText={(row, _ri, ci) => csvBodyCell(row, ci)}
            // 命中的单元格把命中片段包成 <mark class="find-mark">：与文本视图用的是
            // 同一套视觉语言（靛蓝实心块 / 当前命中品红 + 亮环），见 App.css。
            cellNode={(_row, ri, ci, text) => {
              const cols = hitsByRow.get(ri);
              if (!cols || !cols.has(ci)) {
                return text;
              }
              const isCurrent = currentHit?.row === ri && currentHit?.col === ci;
              return renderHitSpans(text, matcher, isCurrent);
            }}
            focusCell={currentHit}
            widths={widths}
            rowHeight={rowHeight}
            fontSize={fontSize}
            headTestId="csv-head"
          />
          {find.open ? (
            <div className="find-widget" role="search">
              <input
                ref={findInputRef}
                className="find-input"
                value={find.query}
                placeholder={t.findPlaceholder}
                aria-label={t.find}
                onChange={(e) => setFind((prev) => ({ ...prev, query: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    stepFind(e.shiftKey ? -1 : 1);
                  } else if (e.key === "Escape") {
                    setFind(FIND_CLOSED);
                  }
                }}
              />
              <span className="find-count" title={capped ? t.findCapped(hits.length) : undefined}>
                {findCountText(hits.length, find.index, capped, t.findCapped)}
              </span>
              <button
                className={`find-toggle${find.caseSensitive ? " on" : ""}`}
                onClick={() =>
                  setFind((prev) => ({ ...prev, caseSensitive: !prev.caseSensitive }))
                }
                aria-pressed={find.caseSensitive}
                title={t.findCase}
              >
                Aa
              </button>
              <button
                className={`find-toggle${find.wholeWord ? " on" : ""}`}
                onClick={() => setFind((prev) => ({ ...prev, wholeWord: !prev.wholeWord }))}
                aria-pressed={find.wholeWord}
                title={t.findWholeWord}
              >
                ab|
              </button>
              <button
                className="find-nav"
                onClick={() => stepFind(-1)}
                disabled={hits.length === 0}
                title={t.findPrev}
                aria-label={t.findPrev}
              >
                ↑
              </button>
              <button
                className="find-nav"
                onClick={() => stepFind(1)}
                disabled={hits.length === 0}
                title={t.findNext}
                aria-label={t.findNext}
              >
                ↓
              </button>
              <button
                className="find-close"
                onClick={() => setFind(FIND_CLOSED)}
                title={t.findClose}
                aria-label={t.findClose}
              >
                ✕
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** 查找计数文案：`当前/总数`（命中被上限截断时标 `+`）。 */
function findCountText(
  total: number,
  index: number,
  capped: boolean,
  cappedLabel: (cap: number) => string
): string {
  if (total === 0) {
    return "0/0";
  }
  const shown = Math.min(index, total - 1) + 1;
  return `${shown}/${capped ? cappedLabel(total) : total}`;
}

/**
 * 把一个命中的单元格文本渲染成 `普通文本 / <mark>命中</mark>` 交替的片段。
 *
 * 与文本视图同一套口径：命中片段用 `find-mark`，当前那一处再加 `current`
 * （更重的底 + 亮环），所以两个视图里的「搜索命中」长得一样。
 */
function renderHitSpans(
  text: string,
  matcher: { term: string; caseSensitive: boolean; wholeWord: boolean },
  isCurrent: boolean
): React.ReactNode {
  const spans = findSpans(text, matcher);
  if (spans.length === 0) {
    return text;
  }
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of spans) {
    if (start > cursor) {
      parts.push(text.slice(cursor, start));
    }
    parts.push(
      <mark className={`find-mark${isCurrent ? " current" : ""}`} key={`${start}-${end}`}>
        {text.slice(start, end)}
      </mark>
    );
    cursor = end;
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return parts;
}

/** 分隔符下拉（工具栏上唯一的「换一种解析方式」入口）。 */
function DelimiterPicker({ lang, delimiter, onDelimiterChange }: CsvTableTabProps) {
  const t = TEXT[lang];
  return (
    <label className="cfg-delim" title={`${t.delimiter}: ${delimiterLabel(delimiter, lang)}`}>
      <span className="cfg-delim-label">{t.delimiter}</span>
      <select
        className="cfg-delim-select"
        value={delimiter}
        onChange={(e) => onDelimiterChange(e.target.value)}
      >
        {DELIMITERS.map((d) => (
          <option key={d.id} value={d.char}>
            {d.label[lang]}
          </option>
        ))}
      </select>
    </label>
  );
}
