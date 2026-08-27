import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";

/** 一行日志（与后端 LogLine 对应）。 */
interface LogLine {
  file_offset: number;
  text: string;
}

/** 后端 log-lines 事件负载（带 tab_id）。 */
interface LinesPayload {
  tab_id: string;
  lines: LogLine[];
  reset: boolean;
}

/** 一个 tab 的元信息。 */
interface TabInfo {
  id: string;
  title: string;
  path: string;
}

/**
 * 把关键词输入框的内容解析为关键词列表。
 * 关键词框视为「一个完整短语」匹配（空格是短语的一部分），
 * 多条件 OR 请在正则框输入，例如 `error|warn`。
 */
function tokenizeKeywordInput(input: string): string[] {
  const trimmed = input.trim();
  return trimmed ? [trimmed] : [];
}

let tabSeq = 0;
function nextTabId(): string {
  tabSeq += 1;
  return `tab-${tabSeq}`;
}

/** 行高估算常量：font-size 12px × line-height 1.4 + 1px border ≈ 18px。 */
const LINE_HEIGHT = 18;
/** 复制按钮列宽。 */
const COPY_BTN_WIDTH = 18;
/** 行号列宽度（48px）+ padding-right（8px）。 */
const LINENO_WIDTH = 56;
/** 行号列 + 复制按钮列合计宽度（估算文本区宽度时扣除）。 */
const GUTTER_WIDTH = COPY_BTN_WIDTH + LINENO_WIDTH;

/** 前端行窗口上限：防止长期运行后 lines 数组无限增长、复制成本线性恶化。 */
const MAX_FRONT_LINES = 300_000;
/** 触发裁剪时保留的行数（留余量，裁剪均摊）。 */
const TRIM_FRONT_TO = 250_000;

/** 对 setLines 的结果做窗口化：超过上限丢弃最旧的行。 */
function clampFrontLines(next: LogLine[]): LogLine[] {
  if (next.length > MAX_FRONT_LINES) {
    return next.slice(next.length - TRIM_FRONT_TO);
  }
  return next;
}
/** Consolas 12px 等宽字体的半角字符近似宽度。 */
const CHAR_WIDTH = 6.6;
/** 全角（CJK）字符宽度 = 2 × 半角。 */
const CJK_CHAR_WIDTH = 13.2;

/** 估算一行文本的像素宽度（等宽字体近似）。 */
function estimateTextWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += ch.charCodeAt(0) > 0xff ? CJK_CHAR_WIDTH : CHAR_WIDTH;
  }
  return width;
}

/** 估算一行的显示高度（用于历史 prepend 后的像素锚定）。 */
function estimateRowHeight(text: string, wrap: boolean, containerWidth: number): number {
  if (!wrap) {
    return LINE_HEIGHT;
  }
  const textWidth = estimateTextWidth(text);
  const rows = Math.max(1, Math.ceil(textWidth / Math.max(containerWidth - GUTTER_WIDTH, 100)));
  return rows * LINE_HEIGHT;
}

/** 转义正则特殊字符。 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 解析高亮关键词输入：空格分隔多个关键词。 */
function parseHighlightKeywords(input: string): string[] {
  return input
    .split(/\s+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

/** 高亮片段的两种类型：普通文本 | 命中关键词（携带关键词索引用于取色）。 */
type HighlightPart = string | { kw: string; colorIndex: number };

/** 预编译的高亮器：正则 + 小写关键词表（避免每行渲染时重复构建正则）。 */
interface HighlightMatcher {
  re: RegExp;
  lowerKeywords: string[];
}

/** 由关键词列表构建高亮匹配器（大小写不敏感）。 */
function buildHighlightMatcher(keywords: string[]): HighlightMatcher | null {
  if (keywords.length === 0) {
    return null;
  }
  const escaped = keywords.map(escapeRegex);
  return {
    re: new RegExp(`(${escaped.join("|")})`, "gi"),
    lowerKeywords: keywords.map((k) => k.toLowerCase()),
  };
}

/**
 * 用预编译的高亮匹配器把一行文本切分为高亮片段。
 * 返回数组：普通文本为 string，命中关键词为 { kw, colorIndex } 对象。
 */
function splitByMatcher(text: string, matcher: HighlightMatcher): HighlightPart[] {
  const parts = text.split(matcher.re);
  const { lowerKeywords } = matcher;
  return parts.map((part) => {
    const lower = part.toLowerCase();
    const idx = lowerKeywords.findIndex((k) => k === lower);
    return idx >= 0 ? { kw: part, colorIndex: idx } : part;
  });
}

/** 单个日志 tab：独立的状态（行、过滤、滚动、高亮）与事件监听。 */
function LogTab({ tabId, path, active, onClose }: {
  tabId: string;
  path: string;
  active: boolean;
  onClose: () => void;
}) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [keywordInput, setKeywordInput] = useState("");
  const [regexInput, setRegexInput] = useState("");
  // 高亮关键词（输入框原始文本 + 解析后的列表，实时生效）。
  const [highlightInput, setHighlightInput] = useState("");
  const highlightKeywords = parseHighlightKeywords(highlightInput);
  // 预编译高亮匹配器：只在关键词变化时重建正则（避免每行渲染重复 new RegExp）。
  const highlightMatcher = useMemo(
    () => buildHighlightMatcher(highlightKeywords),
    [highlightInput]
  );
  const [followTail, setFollowTail] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [wrapLines, setWrapLines] = useState(true);
  const [status, setStatus] = useState("未打开文件");
  const listRef = useRef<HTMLDivElement>(null);
  const autoRefreshRef = useRef(autoRefresh);
  autoRefreshRef.current = autoRefresh;
  const [highlightOffsets, setHighlightOffsets] = useState<Set<number>>(new Set());

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => listRef.current,
    // 精确估算行高：等宽字体下按文本长度估算折行数，接近实测值，
    // 避免向上滚动进入未测量区域时「估算 vs 实测」偏差导致总高度突变、滚动条漂移。
    estimateSize: (index) => {
      if (!wrapLines) {
        return LINE_HEIGHT; // 不换行：固定单行高
      }
      const line = lines[index];
      if (!line) {
        return LINE_HEIGHT;
      }
      const containerWidth = (listRef.current?.clientWidth ?? 800) - GUTTER_WIDTH;
      const textWidth = estimateTextWidth(line.text);
      const rows = Math.max(1, Math.ceil(textWidth / Math.max(containerWidth, 100)));
      return rows * LINE_HEIGHT;
    },
    // 用稳定的 file_offset 作 key：测量缓存在重渲染/追加后仍命中。
    getItemKey: (index) => lines[index]?.file_offset ?? index,
    overscan: 30,
    measureElement: (el) => el.getBoundingClientRect().height,
    // 用 rAF 批量合并 ResizeObserver 测量更新，减少滚动时的布局抖动。
    useAnimationFrameWithResizeObserver: true,
  });

  // 只监听本 tab 的事件。
  useEffect(() => {
    const unlisten = listen<LinesPayload>("log-lines", (event) => {
      const { tab_id, lines: newLines, reset } = event.payload;
      if (tab_id !== tabId) {
        return;
      }
      if (!autoRefreshRef.current) {
        return;
      }
      setLines((prev) => clampFrontLines(reset ? newLines : [...prev, ...newLines]));
      if (reset) {
        // 视图整体替换（新文件/过滤）后，允许重新加载历史。
        setHasMoreHistory(true);
      }

      if (!reset && newLines.length > 0) {
        const offsets = newLines.map((l) => l.file_offset);
        setHighlightOffsets((prev) => {
          const next = new Set(prev);
          offsets.forEach((o) => next.add(o));
          return next;
        });
        window.setTimeout(() => {
          setHighlightOffsets((prev) => {
            const next = new Set(prev);
            offsets.forEach((o) => next.delete(o));
            return next;
          });
        }, 1000);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [tabId]);

  // 挂载时主动向后端拉取当前视图：新建 tab 时后端可能在组件挂载前就 emit 了初始行，
  // 该事件会被错过；这里兜底拉取一次，保证首次打开即显示日志正文。
  useEffect(() => {
    let cancelled = false;
    invoke<LogLine[]>("get_lines", { tabId })
      .then((view) => {
        if (!cancelled) {
          setLines(clampFrontLines(view));
          setStatus(`已打开，共 ${view.length} 行`);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setStatus(`加载失败: ${e}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tabId]);

  // 尾部跟随。
  useEffect(() => {
    if (followTail && lines.length > 0) {
      const raf = requestAnimationFrame(() => {
        virtualizer.scrollToEnd();
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [lines.length, followTail]);

  // tab 从隐藏变为显示时，重新测量虚拟滚动（display:none 期间尺寸为 0）。
  useEffect(() => {
    if (active) {
      const raf = requestAnimationFrame(() => {
        virtualizer.measure();
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [active]);

  // ---- 历史行按需加载（滚动到顶部时向后端请求更早的历史段） ----
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const loadingHistoryRef = useRef(false);

  const loadMoreHistory = useCallback(async () => {
    if (loadingHistoryRef.current || !hasMoreHistory) {
      return;
    }
    loadingHistoryRef.current = true;
    try {
      const res = await invoke<{ lines: LogLine[]; has_more: boolean }>("load_history", {
        tabId,
        rows: 2000,
      });
      setHasMoreHistory(res.has_more);
      if (res.lines.length === 0) {
        return;
      }
      // 像素锚定：prepend 历史行后，把滚动位置往下推新增内容的高度，
      // 保持用户当前正在看的行位置不变。
      const oldScrollTop = listRef.current?.scrollTop ?? 0;
      const containerWidth = listRef.current?.clientWidth ?? 800;
      const newHeight = res.lines.reduce(
        (sum, l) => sum + estimateRowHeight(l.text, wrapLines, containerWidth),
        0
      );
      setLines((prev) => clampFrontLines([...res.lines, ...prev]));
      requestAnimationFrame(() => {
        if (listRef.current) {
          listRef.current.scrollTop = oldScrollTop + newHeight;
        }
      });
    } catch {
      // 静默失败：下次滚动到顶会重试。
    } finally {
      loadingHistoryRef.current = false;
    }
  }, [tabId, hasMoreHistory, wrapLines]);

  const onListScroll = useCallback(() => {
    const el = listRef.current;
    if (el && el.scrollTop < 200) {
      void loadMoreHistory();
    }
  }, [loadMoreHistory]);

  const toggleWrapLines = useCallback((next: boolean) => {
    setWrapLines(next);
    requestAnimationFrame(() => {
      virtualizer.measure();
    });
  }, [virtualizer]);

  const toggleAutoRefresh = useCallback(
    async (next: boolean) => {
      setAutoRefresh(next);
      if (next) {
        try {
          const keywords = tokenizeKeywordInput(keywordInput);
          const regex = regexInput.trim() || null;
          await invoke("set_filter", { tabId, keywords, regex, caseSensitive: false });
          setStatus("已恢复自动刷新");
        } catch (e) {
          setStatus(`刷新失败: ${e}`);
        }
      } else {
        setStatus("已暂停自动刷新");
      }
    },
    [tabId, keywordInput, regexInput]
  );

  const applyFilter = useCallback(async () => {
    const keywords = tokenizeKeywordInput(keywordInput);
    const regex = regexInput.trim() || null;
    try {
      await invoke("set_filter", { tabId, keywords, regex, caseSensitive: false });
    } catch (e) {
      setStatus(`过滤失败: ${e}`);
    }
  }, [tabId, keywordInput, regexInput]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      applyFilter();
    }
  };

  // 复制一行文本到剪贴板。
  const copyLine = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("已复制该行");
    } catch {
      // fallback：旧 execCommand 方式。
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setStatus("已复制该行");
    }
  }, []);

  return (
    <div className="tab-content">
      <div className="toolbar">
        <span className="tab-path" title={path}>
          {path || "（未打开文件）"}
        </span>
        <button className="tab-close" onClick={onClose} title="关闭此 tab">
          ✕
        </button>
        <span className="toolbar-spacer" />
        <label className="follow">
          <input type="checkbox" checked={followTail} onChange={(e) => setFollowTail(e.target.checked)} />
          跟随尾部
        </label>
        <label className="follow">
          <input type="checkbox" checked={autoRefresh} onChange={(e) => toggleAutoRefresh(e.target.checked)} />
          自动刷新
        </label>
        <label className="follow">
          <input type="checkbox" checked={wrapLines} onChange={(e) => toggleWrapLines(e.target.checked)} />
          自动换行
        </label>
      </div>

      <div className="filterbar">
        <input
          className="keyword"
          value={keywordInput}
          onChange={(e) => setKeywordInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="关键词（含空格作为完整短语匹配）"
        />
        <input
          className="regex"
          value={regexInput}
          onChange={(e) => setRegexInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="正则（可选，多条件 OR 如 error|warn）"
        />
        <input
          className="highlight"
          value={highlightInput}
          onChange={(e) => setHighlightInput(e.target.value)}
          placeholder="高亮关键词（空格分隔多个，实时生效）"
        />
        <button onClick={applyFilter}>过滤</button>
        <span className="status">{status}</span>
        <span className="count">{lines.length} 行</span>
      </div>

      <div className={`list ${wrapLines ? "wrap" : "nowrap"}`} ref={listRef} onScroll={onListScroll}>
        <div
          className="list-inner"
          style={{
            height: virtualizer.getTotalSize(),
            width: wrapLines ? "100%" : "max-content",
            minWidth: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((vi) => {
            const line = lines[vi.index];
            const highlighted = highlightOffsets.has(line.file_offset);
            const textParts = highlightMatcher
              ? splitByMatcher(line.text, highlightMatcher)
              : [line.text];
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                className={`row ${wrapLines ? "wrap" : "nowrap"}${highlighted ? " highlight" : ""}`}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: wrapLines ? "100%" : "max-content",
                  minWidth: "100%",
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                <button
                  className="copy-btn"
                  title="复制此行"
                  onClick={(e) => {
                    e.stopPropagation();
                    void copyLine(line.text);
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                    <rect x="5.5" y="5.5" width="9" height="9" rx="1" stroke="currentColor" strokeWidth="1.2" />
                    <path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" stroke="currentColor" strokeWidth="1.2" fill="none" />
                  </svg>
                </button>
                <span className="lineno">{vi.index + 1}</span>
                <span className="text">
                  {textParts.map((part, i) =>
                    typeof part === "string" ? (
                      <span key={i}>{part}</span>
                    ) : (
                      <mark key={i} className={`kw-mark kw-c${part.colorIndex % 8}`}>{part.kw}</mark>
                    )
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  // 打开新文件：新建一个 tab。
  const handleOpen = useCallback(async () => {
    setOpening(true);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "日志文件", extensions: ["log", "txt", "*"] }],
      });
      if (typeof selected === "string") {
        const id = nextTabId();
        const name = selected.split(/[\\/]/).pop() || selected;
        // 先建 tab，再让后端打开文件。
        setTabs((prev) => [...prev, { id, title: name, path: selected }]);
        setActiveTabId(id);
        await invoke("open_log_file", { tabId: id, path: selected });
      }
    } catch (e) {
      console.error("打开失败", e);
    } finally {
      setOpening(false);
    }
  }, []);

  const closeTab = useCallback(
    (id: string) => {
      void invoke("close_tab", { tabId: id });
      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== id);
        if (activeTabId === id) {
          setActiveTabId(next.length > 0 ? next[next.length - 1].id : null);
        }
        return next;
      });
    },
    [activeTabId]
  );

  return (
    <div className="logviewer">
      <div className="tabbar">
        <div className="tabs">
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`tab ${t.id === activeTabId ? "active" : ""}`}
              onClick={() => setActiveTabId(t.id)}
            >
              <span className="tab-title">{t.title}</span>
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
                title="关闭 tab"
              >
                ✕
              </button>
            </div>
          ))}
          <button className="tab-add" onClick={handleOpen} disabled={opening} title="打开新日志文件">
            {opening ? "…" : "+ 打开日志"}
          </button>
        </div>
      </div>

      {tabs.length > 0 ? (
        <>
          {tabs.map((t) => (
            <div
              key={t.id}
              className="tab-panel"
              style={{ display: t.id === activeTabId ? "flex" : "none" }}
            >
              <LogTab
                tabId={t.id}
                path={t.path}
                active={t.id === activeTabId}
                onClose={() => closeTab(t.id)}
              />
            </div>
          ))}
        </>
      ) : (
        <div className="empty">
          <p>未打开任何日志文件</p>
          <button className="open-first" onClick={handleOpen} disabled={opening}>
            {opening ? "打开中…" : "打开日志文件"}
          </button>
        </div>
      )}
    </div>
  );
}
