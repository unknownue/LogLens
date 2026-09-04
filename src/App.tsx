import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { CfgTableTab, type ClientCfgTable } from "./CfgTableTab";
import "./App.css";

/** 一行日志（与后端 LogLine 对应）。 */
interface LogLine {
  /** 稳定行标识（后端单调分配；历史行为负数）。必须全局唯一：用作 React key
   *  与虚拟滚动测量缓存的 key，碰撞会导致相邻行重叠。 */
  file_offset: number;
  /** 该行在文件中的真实行号（1-based）。行号列优先显示它。 */
  file_line: number;
  text: string;
}

/** 后端 log-lines 事件负载（带 tab_id）。 */
interface LinesPayload {
  tab_id: string;
  lines: LogLine[];
  reset: boolean;
  /** 文件当前总行数（实时，随追加增长）。 */
  total_lines: number;
  /** 平均行长（字节/行，来自后端行索引）：占位行高度与滚动条比例的估算依据。 */
  avg_line_len?: number | null;
}

/** 后端 jump_to_line 命令的返回负载。 */
interface JumpPayload {
  /** 窗口内经过滤的命中行（整体替换前端视图）。 */
  lines: LogLine[];
  /** 目标行在 lines 中的下标（滚动定位用）。 */
  target_index: number;
  /** 目标行是否出现在过滤后的视图中。 */
  target_visible: boolean;
  /** 文件总行数。 */
  total_lines: number;
  /** 窗口起点之前是否还有更早的历史。 */
  has_more: boolean;
  /** 窗口第一行的文件行号（1-based）。 */
  first_line_no: number;
}

/** 一个 tab 的元信息。 */
interface TabInfo {
  id: string;
  title: string;
  path: string;
  /** 当前视图模式：默认文本（日志），用户可手动切换为 client_cfg 表格。 */
  viewMode?: "text" | "cfg";
  /** 打开失败（如恢复上次会话时文件已被删除）时的错误信息；成功打开为 undefined。 */
  openError?: string;
}

// ==================== 文件记忆（重启恢复上次打开的文件） ====================

/** localStorage 中保存的标签页列表。 */
interface SavedTabs {
  paths: string[];
  /** 上次激活的 tab 下标。 */
  active: number;
}

/** 读取上次会话的标签页（无数据/损坏时返回 null）。 */
function readSavedTabs(): SavedTabs | null {
  try {
    const raw = localStorage.getItem("lv-tabs");
    if (!raw) {
      return null;
    }
    const v = JSON.parse(raw) as Partial<SavedTabs>;
    if (!v || !Array.isArray(v.paths)) {
      return null;
    }
    const paths = v.paths.filter((p): p is string => typeof p === "string" && p.length > 0);
    if (paths.length === 0) {
      return null;
    }
    return { paths, active: typeof v.active === "number" ? v.active : paths.length - 1 };
  } catch {
    return null;
  }
}

// ==================== 最近打开记录（首行最左侧的历史下拉菜单） ====================
//
// 仅做「记录」：展开菜单时不检查文件存在性，不存在的文件记录照样保留
// （点击后走常规打开流程，失败时 tab 上显示 ⚠ 提示，与手动打开一致）。

/** 历史记录条数上限。 */
const RECENT_MAX = 10;
/** localStorage 键。 */
const RECENT_KEY = "lv-recent";

/** 读取最近打开记录（无数据/损坏时返回空列表）。 */
function readRecentPaths(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) {
      return [];
    }
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) {
      return [];
    }
    return v
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/**
 * 把一条路径插入历史头部：Windows 路径大小写不敏感，去重按小写比较；
 * 保留最新一次的大小写写法，截断到 RECENT_MAX 条。
 */
function pushRecentPath(list: string[], path: string): string[] {
  const key = path.toLowerCase();
  return [path, ...list.filter((p) => p.toLowerCase() !== key)].slice(0, RECENT_MAX);
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

// 性能统计（仅 DEV 构建）：挂到 window.__lvPerf，便于浏览器控制台观察热点。
// 计数在每次打开页面时重置。
declare global {
  interface Window {
    __lvPerf?: {
      estimateCalls: number;
      estimateMs: number;
      getItemKeyCalls: number;
      renders: number;
      scrollEvents: number;
    };
  }
}
if (import.meta.env.DEV) {
  window.__lvPerf = {
    estimateCalls: 0,
    estimateMs: 0,
    getItemKeyCalls: 0,
    renders: 0,
    scrollEvents: 0,
  };
}

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

// ==================== 稀疏虚拟列表（无过滤态） ====================
//
// 滚动条按文件总行数映射全文件；已加载内容存于「段缓存」（blockIdx → 行数组，
// 未加载位为 null，渲染成占位行）。滚动到未加载区域时按块向 get_range 拉取，
// 双向皆可，中段浏览只需一次请求；远离视口的块会被淘汰以控制内存。
// 过滤生效时回落到旧「窗口模型」（lines 数组 + load_history 向上加载）。

/** 稀疏段缓存中一个块的行数。 */
const SPARSE_BLOCK_LINES = 10_000;
/** 可视区外的预取块数（每侧）。 */
const SPARSE_PREFETCH_BLOCKS = 1;
/** 淘汰时保留视口两侧的块数。 */
const SPARSE_KEEP_BLOCKS = 2;
/** 块拉取的最大并发数：快速拖动时保证终点视口的块优先到达。 */
const SPARSE_MAX_INFLIGHT = 4;
/** 段缓存类型：blockIdx → 块内行数组（null = 未加载）。 */
type SparseSegments = Map<number, (LogLine | null)[]>;

/** 由行号计算块号（file_line 1-based）。 */
function blockIndexOf(fileLine: number): number {
  return Math.floor((fileLine - 1) / SPARSE_BLOCK_LINES);
}

/** 按行号取块内下标（0-based）。 */
function posInBlock(fileLine: number): number {
  return (fileLine - 1) % SPARSE_BLOCK_LINES;
}

/** 取虚拟列表 index（0-based 文件行）对应的已加载行；undefined/null = 未加载。 */
function segLineAt(
  segments: SparseSegments,
  index: number
): LogLine | null | undefined {
  const block = segments.get(Math.floor(index / SPARSE_BLOCK_LINES));
  return block ? block[index % SPARSE_BLOCK_LINES] : undefined;
}

/** 把新行合并进段缓存（返回新 Map，触发重渲染）。 */
function mergeSegments(prev: SparseSegments, newLines: LogLine[]): SparseSegments {
  if (newLines.length === 0) {
    return prev;
  }
  const next = new Map(prev);
  for (const l of newLines) {
    if (l == null || !Number.isFinite(l.file_line)) {
      continue;
    }
    const bi = blockIndexOf(l.file_line);
    let block = next.get(bi);
    if (!block) {
      block = new Array<LogLine | null>(SPARSE_BLOCK_LINES).fill(null);
      next.set(bi, block);
    }
    block[posInBlock(l.file_line)] = l;
  }
  return next;
}

/** 段缓存中已加载的行数（状态栏显示用）。 */
function segLoadedCount(segments: SparseSegments): number {
  let n = 0;
  for (const block of segments.values()) {
    for (const l of block) {
      if (l) {
        n += 1;
      }
    }
  }
  return n;
}

/** 块是否已完整加载：块内所有「应存在的行」（行号 ≤ 文件总行数）都非 null。
 *  注意不能用「块存在」判断——初始尾部事件会预填末块的一部分，
 *  若只按存在性跳过拉取，该块其余区域会成为永久占位符。 */
function blockComplete(segments: SparseSegments, b: number, totalLines: number): boolean {
  const arr = segments.get(b);
  if (!arr) {
    return false;
  }
  const start = b * SPARSE_BLOCK_LINES;
  const want = Math.min(SPARSE_BLOCK_LINES, totalLines - start);
  if (want <= 0) {
    return false;
  }
  for (let i = 0; i < want; i++) {
    if (!arr[i]) {
      return false;
    }
  }
  return true;
}

/** 行高估算参数（随字体大小缩放，等宽字体近似）。 */
interface RowMetrics {
  /** 单行显示高度：font-size × 1.4 + 1px border。 */
  lineHeight: number;
  /** 半角字符近似宽度：font-size × 0.55。 */
  charWidth: number;
  /** 全角（CJK）字符宽度：font-size × 1.1。 */
  cjkWidth: number;
}

/**
 * 单行最大显示字符数：超长行截断显示（如 71 万字符的行若完整折行会高达
 * ~6400 行 / 10 万像素，导致渲染卡顿、估算偏差放大 → 相邻行重叠）。
 * 截断后行高有界，估算与渲染一致，重叠消除；复制按钮仍复制完整原文。
 */
const MAX_LINE_CHARS = 2000;

/** 返回一行的显示文本（超长截断），估算与渲染共用保证一致。 */
function displayTextOf(text: string, lang: Lang): string {
  if (text.length <= MAX_LINE_CHARS) {
    return text;
  }
  return text.slice(0, MAX_LINE_CHARS) + MESSAGES[lang].truncateMark;
}

/** 由字体大小计算行高估算参数。 */
function metricsForFontSize(fontSize: number): RowMetrics {
  // 关键：行框高度按浏览器 1/64px 网格取整（Chromium 行为）。
  // 例如 12px × 1.4 = 16.8 → 实测行框 16.796875（= 1075/64）。
  // 若估算直接用 16.8，每行实测与估算永远差 ~0.003px → 虚拟滚动的
  // resizeItem 对每行都触发一次「测量缓存版本号 ++」→ 每次滚动都引发
  // 对全部未测量行的全量重估算（性能放大十倍以上）。对齐取整后 delta==0，
  // 只有折行数估算确实有偏差的行才会触发重算。
  const lineBox = Math.round(fontSize * 1.4 * 64) / 64;
  return {
    lineHeight: lineBox + 1,
    charWidth: fontSize * 0.55,
    cjkWidth: fontSize * 1.1,
  };
}

/** 估算一行文本的像素宽度（等宽字体近似）。 */
function estimateTextWidth(text: string, m: RowMetrics): number {
  let width = 0;
  for (const ch of text) {
    width += ch.charCodeAt(0) > 0xff ? m.cjkWidth : m.charWidth;
  }
  return width;
}

/** 估算一行的显示高度（用于历史 prepend 后的像素锚定）。 */
function estimateRowHeight(
  text: string,
  wrap: boolean,
  containerWidth: number,
  m: RowMetrics,
  lang: Lang
): number {
  if (!wrap) {
    return m.lineHeight;
  }
  const textWidth = estimateTextWidth(displayTextOf(text, lang), m);
  const rows = Math.max(1, Math.ceil(textWidth / Math.max(containerWidth - GUTTER_WIDTH, 100)));
  return rows * m.lineHeight;
}

/** 转义正则特殊字符。 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 复制文本到剪贴板（clipboard API + 旧 execCommand 兜底，WebView2 兼容）。 */
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

// ==================== 多语言（zh / en） ====================

type Lang = "zh" | "en";

/** 界面文案字典：所有 UI 字符串集中于此，便于中英文切换与维护。 */
interface Messages {
  notOpened: string;
  openedLines: (n: number) => string;
  loadFailed: (e: string) => string;
  followTail: string;
  autoRefresh: string;
  wrapLines: string;
  gotoTop: string;
  gotoBottom: string;
  jump: string;
  gotoTopTitle: string;
  gotoBottomTitle: string;
  jumpTitle: string;
  jumpPlaceholder: string;
  jumpPlaceholderRange: (n: number) => string;
  jumpModalTitle: string;
  jumpConfirm: string;
  jumpCancel: string;
  jumpOutOfRange: (total: number) => string;
  keywordPlaceholder: string;
  keywordCaseOnTitle: string;
  keywordCaseOffTitle: string;
  regexPlaceholder: string;
  highlightPlaceholder: string;
  applyFilter: string;
  countLines: (n: number) => string;
  countLinesOfTotal: (n: number, total: number) => string;
  totalLinesTitle: string;
  invalidLine: string;
  jumpFailed: (e: string) => string;
  jumpSuccess: (line: number, first: number) => string;
  jumpFilteredHidden: (line: number) => string;
  topReached: string;
  bottomReached: string;
  refreshResumed: string;
  refreshPaused: string;
  refreshFailed: (e: string) => string;
  filterFailed: (e: string) => string;
  lineCopied: string;
  viewCopied: (n: number) => string;
  closeTabToolbarTitle: string;
  closeTabTitle: string;
  openTab: string;
  openTabTitle: string;
  recentTitle: string;
  recentEmpty: string;
  recentDeleteTitle: string;
  openDialogName: string;
  openFailed: string;
  fontSizeSmaller: string;
  fontSizeBigger: string;
  switchToLight: string;
  switchToDark: string;
  alwaysOnTopOn: string;
  alwaysOnTopOff: string;
  switchLangTitle: (current: Lang) => string;
  copyViewTitle: string;
  copyViewOk: string;
  copyViewErr: string;
  copyLineTitle: string;
  noFileOpened: string;
  openFirst: string;
  opening: string;
  pathPlaceholder: string;
  truncateMark: string;
  viewBody: string;
  viewBodyTitle: string;
  noLineSelected: string;
  viewBodyClose: string;
  viewBodyCopy: string;
  viewBodyCount: (n: number) => string;
  viewBodySizeSmall: string;
  viewBodySizeMedium: string;
  viewBodySizeLarge: string;
  viewBodySizeMax: string;
  dropToOpen: string;
  cfgViewTitle: string;
  cfgBackTextTitle: string;
}

const MESSAGES: Record<Lang, Messages> = {
  zh: {
    notOpened: "未打开文件",
    openedLines: (n) => `已打开，共 ${n} 行`,
    loadFailed: (e) => `加载失败: ${e}`,
    followTail: "跟随尾部",
    autoRefresh: "自动刷新",
    wrapLines: "自动换行",
    gotoTop: "置顶",
    gotoBottom: "置底",
    jump: "跳转",
    gotoTopTitle: "置顶：跳到文件第 1 行",
    gotoBottomTitle: "置底：跳到文件最后一行",
    jumpTitle: "跳转到文件第 N 行（目标行会被定位到视图中央）",
    jumpPlaceholder: "跳转到行号",
    jumpPlaceholderRange: (n) => `行号 1-${n}`,
    jumpModalTitle: "跳转到行",
    jumpConfirm: "确定",
    jumpCancel: "取消",
    jumpOutOfRange: (total) => `行号超出范围（1-${total}）`,
    keywordPlaceholder: "关键词（含空格作为完整短语匹配）",
    keywordCaseOnTitle: "关键词匹配区分大小写：开（点击关闭）",
    keywordCaseOffTitle: "关键词匹配区分大小写：关（点击开启，忽略大小写）",
    regexPlaceholder: "正则（可选，多条件 OR 如 error|warn）",
    highlightPlaceholder: "高亮关键词（空格分隔多个，实时生效）",
    applyFilter: "过滤",
    countLines: (n) => `${n} 行`,
    countLinesOfTotal: (n, total) => `${n} / ${total} 行`,
    totalLinesTitle: "文件总行数（实时）",
    invalidLine: "请输入 ≥ 1 的整数行号",
    jumpFailed: (e) => `跳转失败: ${e}`,
    jumpSuccess: (line, first) => `已跳转到文件第 ${line} 行（窗口起点为第 ${first} 行）`,
    jumpFilteredHidden: (line) => `第 ${line} 行被过滤隐藏，已定位到最近的匹配行`,
    topReached: "已置顶（文件第 1 行）",
    bottomReached: "已置底（跟随尾部）",
    refreshResumed: "已恢复自动刷新",
    refreshPaused: "已暂停自动刷新",
    refreshFailed: (e) => `刷新失败: ${e}`,
    filterFailed: (e) => `过滤失败: ${e}`,
    lineCopied: "已复制该行",
    viewCopied: (n) => `已复制当前视图（${n} 行）`,
    closeTabToolbarTitle: "关闭此 tab",
    closeTabTitle: "关闭 tab",
    openTab: "+ 打开日志",
    openTabTitle: "打开新日志文件",
    recentTitle: "最近打开的日志（历史记录）",
    recentEmpty: "暂无历史记录",
    recentDeleteTitle: "删除此记录",
    openDialogName: "日志文件",
    openFailed: "打开失败",
    fontSizeSmaller: "减小字体",
    fontSizeBigger: "增大字体",
    switchToLight: "切换到浅色主题",
    switchToDark: "切换到深色主题",
    alwaysOnTopOn: "取消窗口置顶",
    alwaysOnTopOff: "窗口始终置顶",
    switchLangTitle: (cur) => (cur === "zh" ? "Switch to English" : "切换为中文"),
    copyViewTitle: "复制当前正文（若使用过滤，则复制过滤后的内容）",
    copyViewOk: "已复制",
    copyViewErr: "复制失败",
    copyLineTitle: "复制此行",
    noFileOpened: "未打开任何日志文件",
    openFirst: "打开日志文件",
    opening: "打开中…",
    pathPlaceholder: "（未打开文件）",
    truncateMark: " …(行过长已截断，点左侧复制按钮获取全文)",
    viewBody: "提取",
    viewBodyTitle: "查看选中行的完整正文内容（点击行后或拖选多行文字后使用）",
    noLineSelected: "请先点击选中一行，或拖选多行文字",
    viewBodyClose: "关闭",
    viewBodyCopy: "复制全文",
    viewBodyCount: (n) => `共 ${n} 行`,
    viewBodySizeSmall: "小",
    viewBodySizeMedium: "中",
    viewBodySizeLarge: "大",
    viewBodySizeMax: "最大",
    dropToOpen: "松开以打开文件",
    cfgViewTitle: "切换为表格视图（以 client_cfg 配置表格式解析当前文件）",
    cfgBackTextTitle: "切回文本视图",
  },
  en: {
    notOpened: "No file opened",
    openedLines: (n) => `Opened, ${n} lines`,
    loadFailed: (e) => `Load failed: ${e}`,
    followTail: "Follow tail",
    autoRefresh: "Auto refresh",
    wrapLines: "Word wrap",
    gotoTop: "Top",
    gotoBottom: "Bottom",
    jump: "Go",
    gotoTopTitle: "Top: jump to file line 1",
    gotoBottomTitle: "Bottom: jump to the last line",
    jumpTitle: "Jump to file line N (target line is centered in the view)",
    jumpPlaceholder: "Jump to line",
    jumpPlaceholderRange: (n) => `Line 1-${n}`,
    jumpModalTitle: "Jump to line",
    jumpConfirm: "OK",
    jumpCancel: "Cancel",
    jumpOutOfRange: (total) => `Line out of range (1-${total})`,
    keywordPlaceholder: "Keyword (spaces match the whole phrase)",
    keywordCaseOnTitle: "Match keyword case: on (click to turn off)",
    keywordCaseOffTitle: "Match keyword case: off (click to turn on, ignore case)",
    regexPlaceholder: "Regex (optional, OR conditions like error|warn)",
    highlightPlaceholder: "Highlight keywords (space-separated, live)",
    applyFilter: "Filter",
    countLines: (n) => `${n} lines`,
    countLinesOfTotal: (n, total) => `${n} / ${total} lines`,
    totalLinesTitle: "Total lines in file (live)",
    invalidLine: "Enter an integer line number ≥ 1",
    jumpFailed: (e) => `Jump failed: ${e}`,
    jumpSuccess: (line, first) => `Jumped to file line ${line} (window starts at line ${first})`,
    jumpFilteredHidden: (line) => `Line ${line} is hidden by the filter; located the nearest match`,
    topReached: "Top (file line 1)",
    bottomReached: "Bottom (following tail)",
    refreshResumed: "Auto refresh resumed",
    refreshPaused: "Auto refresh paused",
    refreshFailed: (e) => `Refresh failed: ${e}`,
    filterFailed: (e) => `Filter failed: ${e}`,
    lineCopied: "Line copied",
    viewCopied: (n) => `View copied (${n} lines)`,
    closeTabToolbarTitle: "Close this tab",
    closeTabTitle: "Close tab",
    openTab: "+ Open log",
    openTabTitle: "Open a new log file",
    recentTitle: "Recently opened logs (history)",
    recentEmpty: "No recent files",
    recentDeleteTitle: "Remove this entry",
    openDialogName: "Log files",
    openFailed: "Failed to open",
    fontSizeSmaller: "Decrease font size",
    fontSizeBigger: "Increase font size",
    switchToLight: "Switch to light theme",
    switchToDark: "Switch to dark theme",
    alwaysOnTopOn: "Turn off always-on-top",
    alwaysOnTopOff: "Keep window always on top",
    switchLangTitle: (cur) => (cur === "zh" ? "Switch to English" : "切换为中文"),
    copyViewTitle: "Copy the current view (filtered content when a filter is active)",
    copyViewOk: "Copied",
    copyViewErr: "Copy failed",
    copyLineTitle: "Copy this line",
    noFileOpened: "No log file opened",
    openFirst: "Open log file",
    opening: "Opening…",
    pathPlaceholder: "(no file opened)",
    truncateMark: " …(line truncated; click the copy button for the full text)",
    viewBody: "Extract",
    viewBodyTitle: "View the full body of the selected line(s) (click a line or drag-select multiple)",
    noLineSelected: "Click a line first, or drag-select multiple lines",
    viewBodyClose: "Close",
    viewBodyCopy: "Copy all",
    viewBodyCount: (n) => `${n} lines`,
    viewBodySizeSmall: "Small",
    viewBodySizeMedium: "Medium",
    viewBodySizeLarge: "Large",
    viewBodySizeMax: "Max",
    dropToOpen: "Drop files to open",
    cfgViewTitle: "Switch to table view (parse current file as a client_cfg config table)",
    cfgBackTextTitle: "Switch back to text view",
  },
};

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
function LogTab({ tabId, path, openError, active, fontSize, lang, onClose, registerCopy, reportTotal }: {
  tabId: string;
  path: string;
  /** 打开失败信息（恢复会话时文件已不存在等）；有值时工具栏显示警告。 */
  openError?: string;
  active: boolean;
  fontSize: number;
  lang: Lang;
  onClose: () => void;
  /** 注册「复制当前视图」函数：激活时注册、失活/卸载时注销（App 右上角按钮用）。 */
  registerCopy: (tabId: string, fn: (() => Promise<string>) | null) => void;
  /** 上报本 tab 的文件总行数（激活时实时同步给 App 右上角显示）。 */
  reportTotal: (tabId: string, total: number | null) => void;
}) {
  const t = MESSAGES[lang];
  const [lines, setLines] = useState<LogLine[]>([]);
  // ---- 稀疏虚拟列表（无过滤态）状态 ----
  const [segments, setSegments] = useState<SparseSegments>(() => new Map());
  const [avgLineLen, setAvgLineLen] = useState<number | null>(null);
  /** 每个稀疏块的平均行长（字节/行，来自后端行索引 64 行采样，无额外 IO）。
   *  占位行高按块估算而非全局平均：日志区域密度差异大（堆栈/JSON 段 vs 短行），
   *  全局平均会让块加载后总高突变 → 滚动条跳变、拖动幅度与进度不一致。
   *  null = 索引尚未覆盖该块（回退全局平均）。 */
  const [blockAvgLens, setBlockAvgLens] = useState<(number | null)[]>([]);
  /** 密度数据代际：文件轮转/截断（reset）时 +1，触发重新拉取。 */
  const [densityEpoch, setDensityEpoch] = useState(0);
  /** 过滤是否已生效：true = 旧窗口模型；false = 稀疏模型。 */
  const [filterActive, setFilterActive] = useState(false);
  const filterActiveRef = useRef(false);
  filterActiveRef.current = filterActive;
  const segmentsRef = useRef<SparseSegments>(segments);
  segmentsRef.current = segments;
  /** 首屏内容绘制回执：只上报一次（供后端启动耗时打点）。 */
  const firstPaintReportedRef = useRef(false);
  const lastEvictRef = useRef(0);
  const [keywordInput, setKeywordInput] = useState("");
  const [regexInput, setRegexInput] = useState("");
  // 关键词匹配是否区分大小写（默认 false = 忽略大小写，与后端 FilterSpec 默认一致）。
  const [caseSensitive, setCaseSensitive] = useState(false);
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
  // ---- 跳转到指定行（模态框输入） ----
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpInput, setJumpInput] = useState("");
  /** 模态框内的校验/失败提示；null = 无提示。 */
  const [jumpError, setJumpError] = useState<string | null>(null);
  const [jumping, setJumping] = useState(false);
  const jumpInputRef = useRef<HTMLInputElement>(null);
  // 模态框打开时聚焦并全选已有内容（便于直接输入覆盖）。
  useEffect(() => {
    if (jumpOpen) {
      jumpInputRef.current?.focus();
      jumpInputRef.current?.select();
    }
  }, [jumpOpen]);
  const [totalLines, setTotalLines] = useState<number | null>(null);
  const totalLinesRef = useRef<number | null>(totalLines);
  totalLinesRef.current = totalLines;
  // 待执行的跳转定位请求：在 lines 替换**提交之后**由 effect 消费，
  // 避免 scrollToIndex 在新内容提交前执行（该库的 reconcile 会固化
  // 首次计算的偏移，若首次基于旧视图计算，落点就错到别处）。
  const [jumpRequest, setJumpRequest] = useState<{ target: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const autoRefreshRef = useRef(autoRefresh);
  autoRefreshRef.current = autoRefresh;
  const [highlightOffsets, setHighlightOffsets] = useState<Set<number>>(new Set());
  // ---- 查看正文：记录最近一次点选的行，及模态框显示内容 ----
  const [lastClickedLine, setLastClickedLine] = useState<LogLine | null>(null);
  const [viewerLines, setViewerLines] = useState<LogLine[] | null>(null);
  const [viewerFeedback, setViewerFeedback] = useState<"idle" | "ok" | "err">("idle");
  // ---- 正文查看器模态框尺寸（可拖拽调整 / 预设按钮） ----
  /** 默认宽度（相对窗口宽度，92% 上限 900px）。 */
  const defaultModalWidth = () =>
    Math.min(900, typeof window !== "undefined" ? window.innerWidth * 0.92 : 900);
  /** 默认高度（相对窗口高度，80% 上限 720px）。 */
  const defaultModalHeight = () =>
    Math.min(720, typeof window !== "undefined" ? window.innerHeight * 0.8 : 720);
  const [modalSize, setModalSize] = useState<{ width: number; height: number }>(() => ({
    width: defaultModalWidth(),
    height: defaultModalHeight(),
  }));
  const modalSizeRef = useRef(modalSize);
  modalSizeRef.current = modalSize;
  /** 模态框最小尺寸（防止拖到不可用）。 */
  const MODAL_MIN_W = 360;
  const MODAL_MIN_H = 200;
  // 标记「本轮 lines 增长来自历史 prepend」，期间抑制尾部跟随滚动。
  const suppressFollowRef = useRef(false);
  // 跳转定位的用户滚动保护：程序写入时间戳与最近一次用户滚动时间戳。
  const lastProgrammaticWriteRef = useRef(0);
  const lastUserScrollRef = useRef(0);

  // ---- JS 驱动的垂直滚动（接管原生滚动条） ----
  // 大文件换行模式下虚拟总高可超过 Chromium 元素高度硬上限（2^25 = 33,554,432px，
  // 实测 scrollHeight 被钳到 33,554,428）：原生滚动条的映射空间被截断——拖到
  // thumb 95% 实际只到内容 ~74%，文件尾部永远拖不到（E2E 实测复现）。
  // 因此垂直滚动完全由 JS 接管：virtualTopRef 保存虚拟滚动偏移（JS number 无上限），
  // 行内容以 transform 位移渲染，滚动条为自绘 overlay（thumb ↔ 偏移线性映射，
  // 拖动幅度与实际进度严格成正比，且不受高度估算误差影响）。
  const virtualTopRef = useRef(0);
  /** 虚拟滚动偏移变化时的回调（由 useVirtualizer 的 observeElementOffset 注册）。 */
  const offsetCbRef = useRef<((offset: number, isScrolling: boolean) => void) | null>(null);
  /** thumb 位置渲染用的偏移镜像（与 virtualTopRef 同步，驱动重渲染）。 */
  const [scrollOffsetUi, setScrollOffsetUi] = useState(0);
  /** 统一的偏移写入入口（实现在 virtualizer 定义之后赋值）。 */
  const applyVirtualTopRef = useRef<(next: number, source: "user" | "programmatic") => void>(() => {});

  // 行高估算参数（随字体大小变化）。用 useMemo 稳定引用：
  // 否则每次渲染都是新对象，estimateSize 的 useCallback 依赖会失效。
  const metrics = useMemo(() => metricsForFontSize(fontSize), [fontSize]);

  // 渲染计数（仅 DEV）：每次 LogTab 渲染递增，观察滚动时的重渲染频率。
  useEffect(() => {
    if (import.meta.env.DEV && window.__lvPerf) {
      window.__lvPerf.renders++;
    }
  });

  // estimateSize / getItemKey 必须用 useCallback 稳定引用：
  // 虚拟滚动的 getMeasurements 以 getItemKey 的引用为 memo 依赖；
  // 若每次渲染都新建闭包，纯滚动渲染也会触发 O(总行数×行长) 的全量重算，
  // 表现为大数据量下滚动卡顿（每次滚动上百万次字符宽度估算）。
  //
  // 每行估算高度缓存：键为 file_offset，值为 { 宽度桶, 高度 }。
  // 估算只在行首次出现（或宽度桶变化）时做一次字符遍历，之后全是 O(1) 命中。
  // 这样即使「追加/前插新数据 → 全量重建测量数组」，也只是 Map 查找而非逐字符扫描。
  const estimateCacheRef = useRef<Map<number, { bucket: number; height: number }>>(new Map());
  // 换行模式 / 字体大小 / 语言变化时，估算基准失效，清空缓存重建。
  useEffect(() => {
    estimateCacheRef.current.clear();
  }, [wrapLines, fontSize, lang]);

  // 占位行高度：优先用所在块的实测平均行长（后端行索引采样，按块估算），
  // 无块数据时回退全局平均。块级估算使「总高估算 ≈ 真实总高」，块加载后
  // 滚动条几乎不跳变，拖动滚动条的幅度与实际进度保持一致。
  const placeholderHeight = useCallback(
    (index: number) => {
      const len =
        blockAvgLens[Math.floor(index / SPARSE_BLOCK_LINES)] ?? avgLineLen;
      if (!wrapLines || len == null) {
        return metrics.lineHeight;
      }
      const width = Math.max((listRef.current?.clientWidth ?? 800) - GUTTER_WIDTH, 100);
      const estWidth = len * metrics.charWidth;
      const rows = Math.max(1, Math.ceil(estWidth / width));
      return rows * metrics.lineHeight;
    },
    [wrapLines, avgLineLen, blockAvgLens, metrics]
  );

  const estimateSize = useCallback(
    (index: number) => {
      const perf = window.__lvPerf;
      const t0 = perf ? performance.now() : 0;
      if (perf) {
        perf.estimateCalls++;
      }
      let result: number;
      if (!wrapLines) {
        result = metrics.lineHeight; // 不换行：固定单行高
      } else {
        // 稀疏模型：按文件行号取行；未加载 → 占位高度（O(1)，不逐字符估算）。
        const line = filterActiveRef.current
          ? lines[index]
          : segLineAt(segmentsRef.current, index);
        if (!line) {
          result = placeholderHeight(index);
        } else {
          // 宽度分桶（32px）：窗口宽度小幅变化不重算；桶变化时才重新估算。
          const width = (listRef.current?.clientWidth ?? 800) - GUTTER_WIDTH;
          const bucket = Math.round(width / 32);
          const cache = estimateCacheRef.current;
          // 防止长时间运行后缓存无限增长（前端行窗口裁剪后旧行仍留在缓存）。
          if (cache.size > 400_000) {
            cache.clear();
          }
          const cached = cache.get(line.file_offset);
          if (cached && cached.bucket === bucket) {
            result = cached.height;
          } else {
            // 用截断后的显示文本估算（与渲染一致，避免极长行估算偏差放大）。
            const textWidth = estimateTextWidth(displayTextOf(line.text, lang), metrics);
            const rows = Math.max(1, Math.ceil(textWidth / Math.max(width, 100)));
            result = rows * metrics.lineHeight;
            cache.set(line.file_offset, { bucket, height: result });
          }
        }
      }
      if (perf) {
        perf.estimateMs += performance.now() - t0;
      }
      return result;
    },
    [lines, segments, wrapLines, metrics, lang, placeholderHeight]
  );

  // 用稳定的 file_offset 作 key：测量缓存在重渲染/追加后仍命中。
  // 稀疏模型 key = 文件行号 index（稳定不漂移）；旧窗口模型 key = file_offset。
  const getItemKey = useCallback(
    (index: number) => {
      if (window.__lvPerf) {
        window.__lvPerf.getItemKeyCalls++;
      }
      return filterActiveRef.current ? (lines[index]?.file_offset ?? index) : index;
    },
    [lines]
  );

  const virtualizer = useVirtualizer({
    count: filterActive ? lines.length : (totalLines ?? 0),
    getScrollElement: () => listRef.current,
    estimateSize,
    getItemKey,
    overscan: 30,
    measureElement: (el) => el.getBoundingClientRect().height,
    // 垂直滚动由 JS 接管（见 virtualTopRef 注释）：偏移不经原生 scrollTop，
    // 而是由 applyVirtualTop 写入 ref 并回调此 cb 通知虚拟列表。
    observeElementOffset: (_instance, cb) => {
      offsetCbRef.current = cb;
      cb(virtualTopRef.current, false);
      return () => {
        offsetCbRef.current = null;
      };
    },
    // 所有程序性滚动（scrollToIndex/scrollToEnd/内部锚定补偿）统一经此落地。
    scrollToFn: (offset, { adjustments }) => {
      applyVirtualTopRef.current(offset + (adjustments ?? 0), "programmatic");
    },
    // 该 fork 默认 useFlushSync=true：同步 notify（发生在 React 提交阶段的
    // measureElement ref 回调里）会在渲染中调用 flushSync，触发
    // "flushSync was called from inside a lifecycle method" 并破坏同批次的
    // 状态更新（实测：过滤 reset 被当成追加，视图行数错误累积）。
    // 关闭后走正常异步 rerender，行为不变且无该错误。
    useFlushSync: false,
  });

  // 垂直滚动由 JS 接管后，最大滚动偏移 = 虚拟总高 − 视口高（JS number，无上限）。
  // 覆盖库内实现：其读取 DOM scrollHeight，会被 Chromium 2^25px 元素高度上限钳制，
  // 导致 getOffsetForIndex/scrollToEnd 对超大文件永远到不了真正的尾部。
  (virtualizer as unknown as { getMaxScrollOffset: () => number }).getMaxScrollOffset = () =>
    Math.max(0, virtualizer.getTotalSize() - (listRef.current?.clientHeight ?? 0));

  // ---- 稀疏块加载：距离优先调度 + rAF 合并 + 淘汰（双向均可） ----

  const inflightRef = useRef<Set<number>>(new Set());
  /** 本帧是否已排入调度。 */
  const fetchScheduledRef = useRef(false);

  /** 拉取一个块（1 万行）；并发上限由调度器控制，避免拖动时几十个块挤占 IPC。 */
  const fetchBlock = useCallback(
    async (b: number) => {
      // 完整加载过才跳过；部分填充（尾部事件预填的末块）仍需拉取补齐。
      const skipReason = inflightRef.current.has(b)
        ? "inflight"
        : blockComplete(segmentsRef.current, b, totalLinesRef.current ?? 0)
          ? "complete"
          : null;
      if (skipReason) {
        return;
      }
      inflightRef.current.add(b);
      try {
        const res = await invoke<LogLine[]>("get_range", {
          tabId,
          startLine: b * SPARSE_BLOCK_LINES + 1,
          count: SPARSE_BLOCK_LINES,
        });
        setSegments((prev) => mergeSegments(prev, res));
      } catch {
        // 静默失败：下次滚动到该块会重试。
      } finally {
        inflightRef.current.delete(b);
        // 本块完成后重排一轮：并发占满时被让位的块、以及拖动结束后
        // 没有新 scroll 事件的场景，都靠这里把剩余的缺失块补齐。
        if (!fetchScheduledRef.current) {
          fetchScheduledRef.current = true;
          requestAnimationFrame(runFetchTickRef.current);
        }
      }
    },
    [tabId]
  );

  /** 每帧一次的块调度：在 rAF 里读虚拟列表项（此时 React 已提交新的 scrollOffset），
   *  计算视口所需块、按距离优先拉取并淘汰远块。
   *
   *  关键教训：scroll 事件处理里同步读 `getVirtualItems()` 可能拿到 React 尚未提交的
   *  陈旧 scrollOffset（程序性 scrollToEnd 只产生一次 scroll 事件，之后没有新事件
   *  来纠正 → 视口块永远不被拉取）。因此这里先校验 items 与 DOM scrollTop 的一致性，
   *  不一致则顺延下一帧重试（最多 3 次）。 */
  const runFetchTick = useCallback(() => {
    fetchScheduledRef.current = false;
    if (filterActiveRef.current || totalLines == null || totalLines <= 0) {
      return;
    }
    const items = virtualizer.getVirtualItems();
    if (items.length === 0) {
      return;
    }
    // items 与滚动位置一致性校验：不一致说明虚拟列表还没跟上本次滚动。
    const el = listRef.current;
    if (el) {
      const first = items[0];
      const last = items[items.length - 1];
      const vTop = virtualTopRef.current;
      const covered =
        vTop >= first.start - 64 &&
        vTop + el.clientHeight <= last.start + last.size + 64;
      if (!covered) {
        if (tickRetryRef.current < 3) {
          tickRetryRef.current += 1;
          fetchScheduledRef.current = true;
          requestAnimationFrame(runFetchTickRef.current);
          return;
        }
      }
    }
    tickRetryRef.current = 0;

    const firstIdx = items[0].index;
    const lastIdx = items[items.length - 1].index;
    const center = Math.floor(
      items[Math.floor(items.length / 2)].index / SPARSE_BLOCK_LINES
    );
    const firstBlock = Math.max(0, Math.floor(firstIdx / SPARSE_BLOCK_LINES) - SPARSE_PREFETCH_BLOCKS);
    const lastBlock = Math.min(
      Math.floor((totalLines - 1) / SPARSE_BLOCK_LINES),
      Math.floor(lastIdx / SPARSE_BLOCK_LINES) + SPARSE_PREFETCH_BLOCKS
    );
    // 收集缺失块，按距视口中心块的距离排序（终点视口的块优先）。
    const missing: number[] = [];
    for (let b = firstBlock; b <= lastBlock; b++) {
      if (
        !inflightRef.current.has(b) &&
        !blockComplete(segmentsRef.current, b, totalLines)
      ) {
        missing.push(b);
      }
    }
    missing.sort((a, b) => Math.abs(a - center) - Math.abs(b - center));

    let slots = SPARSE_MAX_INFLIGHT - inflightRef.current.size;
    if (slots <= 0) {
      // 在途块已不在视口附近 → 放弃认领，腾出并发位给当前视口
      // （响应仍会合并进段缓存，稍后被淘汰；可能重复拉取一次，幂等无害）。
      for (const b of [...inflightRef.current]) {
        if (b < firstBlock - SPARSE_KEEP_BLOCKS || b > lastBlock + SPARSE_KEEP_BLOCKS) {
          inflightRef.current.delete(b);
          slots += 1;
        }
      }
      if (slots <= 0) {
        return;
      }
    }
    for (const b of missing.slice(0, slots)) {
      void fetchBlock(b);
    }
    // 淘汰：限频，保留视口两侧各 SPARSE_KEEP_BLOCKS 个块（在途块不淘汰）。
    const now = Date.now();
    if (now - lastEvictRef.current > 500) {
      lastEvictRef.current = now;
      setSegments((prev) => {
        let changed = false;
        for (const key of prev.keys()) {
          if (key < firstBlock - SPARSE_KEEP_BLOCKS || key > lastBlock + SPARSE_KEEP_BLOCKS) {
            changed = true;
            break;
          }
        }
        if (!changed) {
          return prev;
        }
        const next = new Map(prev);
        for (const key of prev.keys()) {
          if (
            (key < firstBlock - SPARSE_KEEP_BLOCKS || key > lastBlock + SPARSE_KEEP_BLOCKS) &&
            !inflightRef.current.has(key)
          ) {
            next.delete(key);
          }
        }
        return next;
      });
    }
  }, [totalLines, virtualizer, fetchBlock]);

  // 供 fetchBlock 在完成后自触发重排（fetchBlock 的依赖是稳定的，需经 ref 取最新 tick）。
  const runFetchTickRef = useRef<() => void>(() => {});
  runFetchTickRef.current = runFetchTick;
  /** items 与 DOM 不一致时的顺延重试计数。 */
  const tickRetryRef = useRef(0);

  /** 请求块调度（每帧合并一次；scroll 事件 / 跟随效应 / 块完成共用入口）。 */
  const scheduleFetchTick = useCallback(() => {
    if (fetchScheduledRef.current) {
      return;
    }
    fetchScheduledRef.current = true;
    tickRetryRef.current = 0;
    requestAnimationFrame(runFetchTickRef.current);
  }, []);

  /** 滚动后确保视口块加载（转发到调度；计算统一在 rAF 里做）。 */
  const ensureVisibleBlocks = useCallback(() => {
    scheduleFetchTick();
  }, [scheduleFetchTick]);

  // 字体大小变化时：在渲染 DOM 更新前同步清空行高缓存，
  // 之后行元素 resize → ResizeObserver 用新字体下的真实高度重建缓存。
  const prevFontSizeRef = useRef(fontSize);
  if (prevFontSizeRef.current !== fontSize) {
    prevFontSizeRef.current = fontSize;
    virtualizer.measure();
  }

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
      // 实时总行数：每次事件都会携带（随追加增长；轮转后归零重计）。
      setTotalLines(event.payload.total_lines);
      if (event.payload.avg_line_len != null) {
        setAvgLineLen(event.payload.avg_line_len);
      }
      if (filterActiveRef.current) {
        // 旧窗口模型：追加/替换 lines 数组。
        setLines((prev) => clampFrontLines(reset ? newLines : [...prev, ...newLines]));
        if (reset) {
          // 视图整体替换（新文件/过滤）后，允许重新加载历史。
          setHasMoreHistory(true);
        }
      } else {
        // 稀疏模型：合并进段缓存；reset（轮转/新文件）时清空重建。
        setSegments((prev) => mergeSegments(reset ? new Map() : prev, newLines));
        if (reset) {
          // 文件轮转/截断：行索引已重建，块密度全部失效，触发重新拉取。
          setBlockAvgLens([]);
          setDensityEpoch((n) => n + 1);
        }
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

  // 挂载时主动向后端拉取当前视图与总行数：新建 tab 时后端可能在组件挂载前
  // 就 emit 了初始行，该事件会被错过；这里兜底拉取一次，保证首次打开即显示。
  useEffect(() => {
    let cancelled = false;
    invoke<LogLine[]>("get_lines", { tabId })
      .then((view) => {
        if (cancelled) {
          return;
        }
        if (filterActiveRef.current) {
          setLines(clampFrontLines(view));
        } else {
          setSegments((prev) => mergeSegments(prev, view));
        }
      })
      .catch(() => {
        /* 静默失败：视图由 log-lines 事件兜底 */
      });
    invoke<number>("get_total_lines", { tabId })
      .then((n) => {
        if (!cancelled && Number.isFinite(n)) {
          setTotalLines(n);
        }
      })
      .catch(() => {
        /* 忽略：总行数也可由 log-lines 事件携带 */
      });
    return () => {
      cancelled = true;
    };
  }, [tabId]);

  // 首屏内容绘制回执：首次出现正文后，经「双 rAF」在绘制完成后通知后端
  // （第一个 rAF 在绘制前、第二个在绘制后），用于后端打点统计「启动→可见」总耗时。
  useEffect(() => {
    if (firstPaintReportedRef.current) {
      return;
    }
    const hasContent = filterActive ? lines.length > 0 : segLoadedCount(segments) > 0;
    if (!hasContent) {
      return;
    }
    firstPaintReportedRef.current = true;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        void invoke("report_first_paint").catch(() => {
          /* 打点失败静默 */
        });
      })
    );
  }, [segments, lines, filterActive]);

  // 拉取每块平均行长（占位行高按块估算的依据）。块数增长（文件追加跨过块边界）、
  // 过滤退出回到稀疏模型、或轮转/截断（densityEpoch）时重拉；索引预热未覆盖的
  // 块返回 null，稍后重试（预热通常在打开后秒级完成）。
  const blockCount =
    totalLines != null ? Math.ceil(totalLines / SPARSE_BLOCK_LINES) : 0;
  useEffect(() => {
    if (filterActive || blockCount <= 0) {
      return;
    }
    let cancelled = false;
    let attempts = 0;
    const fetchLens = () => {
      attempts += 1;
      invoke<(number | null)[]>("get_block_avg_lens", {
        tabId,
        blockLines: SPARSE_BLOCK_LINES,
      })
        .then((lens) => {
          if (cancelled) {
            return;
          }
          setBlockAvgLens(lens);
          if (lens.some((v) => v == null) && attempts < 3) {
            window.setTimeout(fetchLens, 2000);
          }
        })
        .catch(() => {
          /* 静默失败：回退全局平均估算 */
        });
    };
    fetchLens();
    return () => {
      cancelled = true;
    };
  }, [tabId, blockCount, filterActive, densityEpoch]);

  // 尾部跟随。
  useEffect(() => {
    // 历史 prepend 引起的行数变化不触发跟随（由 loadMoreHistory 的锚定接管）。
    const hasContent = filterActiveRef.current ? lines.length > 0 : (totalLines ?? 0) > 0;
    if (followTail && hasContent && !suppressFollowRef.current) {
      const raf = requestAnimationFrame(() => {
        virtualizer.scrollToEnd();
        if (!filterActiveRef.current) {
          ensureVisibleBlocks(); // 尾部块未加载时立即拉取
        }
      });
      return () => cancelAnimationFrame(raf);
    }
    // totalSize 入依赖：打开文件初期占位总高偏小（密度数据未到达），
    // 修正后重新贴尾，避免视口漂离尾部。用户向上滚/拖动会自动关闭跟随，
    // 因此不会与用户操作打架。
  }, [lines.length, totalLines, virtualizer.getTotalSize(), followTail, virtualizer, ensureVisibleBlocks]);

  // 高亮指定行 1s（与追加行的淡出高亮机制一致）：
  // 跳转/置顶/置底后高亮落点行，便于快速定位。
  const flashLine = useCallback((offset: number | null | undefined) => {
    if (offset == null) {
      return;
    }
    setHighlightOffsets((prev) => {
      const next = new Set(prev);
      next.add(offset);
      return next;
    });
    window.setTimeout(() => {
      setHighlightOffsets((prev) => {
        const next = new Set(prev);
        next.delete(offset);
        return next;
      });
    }, 1000);
  }, []);

  // 跳转定位：在 lines 替换**提交之后**执行（effect 时机保证新视图已在 DOM）。
  // scrollToIndex 的 reconcile 只追「首次计算」的固定偏移，不会按 index 重算；
  // 而视口上方行的首测补偿会持续微调 scrollTop。因此这里做收敛式重居中：
  // 每次按当前实测位置重算居中偏移，偏差 >2px 则重写，居中即停（最多 6 次）。
  // 用户滚动保护：程序写入后 120ms 内的 scroll 事件视为回读；其余视为用户
  // 滚动，之后 500ms 内不再干预。
  useEffect(() => {
    if (!jumpRequest) {
      return;
    }
    const { target } = jumpRequest;
    const listCount = filterActiveRef.current ? lines.length : (totalLines ?? 0);
    if (target >= 0 && target < listCount) {
      const attemptRecenter = (left: number) => {
        if (left <= 0) {
          return;
        }
        // 用户最近滚过 → 放弃干预。
        if (Date.now() - lastUserScrollRef.current < 500) {
          return;
        }
        const off = virtualizer.getOffsetForIndex(target, "center");
        if (off && Math.abs(virtualTopRef.current - off[0]) <= 2) {
          return; // 已精确居中，无需再动
        }
        lastProgrammaticWriteRef.current = Date.now();
        virtualizer.scrollToIndex(target, { align: "center" });
        window.setTimeout(() => attemptRecenter(left - 1), 250);
      };
      lastProgrammaticWriteRef.current = Date.now();
      virtualizer.scrollToIndex(target, { align: "center" });
      if (!filterActiveRef.current) {
        ensureVisibleBlocks(); // 稀疏：目标块未加载时立即拉取
      }
      window.setTimeout(() => attemptRecenter(6), 250);
      // 高亮落点行 1s（行渲染后自动套用 .highlight，移除时经 CSS 过渡淡出）。
      const targetLine = filterActiveRef.current
        ? lines[target]
        : segLineAt(segmentsRef.current, target);
      flashLine(targetLine?.file_offset);
    }
    setJumpRequest(null);
  }, [jumpRequest, lines, virtualizer, flashLine, totalLines, ensureVisibleBlocks]);

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
    // 仅旧窗口模型（过滤态）使用向上历史加载；稀疏模型走 get_range 块加载。
    if (filterActiveRef.current === false || loadingHistoryRef.current || !hasMoreHistory) {
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
      const oldScrollTop = virtualTopRef.current;
      const containerWidth = listRef.current?.clientWidth ?? 800;
      const newHeight = res.lines.reduce(
        (sum, l) => sum + estimateRowHeight(l.text, wrapLines, containerWidth, metrics, lang),
        0
      );
      suppressFollowRef.current = true; // 抑制本轮尾部跟随
      setLines((prev) => clampFrontLines([...res.lines, ...prev]));
      requestAnimationFrame(() => {
        applyVirtualTopRef.current(oldScrollTop + newHeight, "programmatic");
        // 注意：不调用 virtualizer.measure()——它会清空行高缓存，
        // 而已渲染行的 ResizeObserver 不会因缓存清空重新触发，
        // 导致这些行停留在估算高度（估算与实际折行有偏差时会出现重叠）。
        // measurements 会随 count 变化自然重建，getItemKey(file_offset) 保证旧行缓存命中。
        // 下一帧解除抑制（覆盖尾部跟随 effect 的执行窗口）。
        requestAnimationFrame(() => {
          suppressFollowRef.current = false;
        });
      });
    } catch {
      // 静默失败：下次滚动到顶会重试。
    } finally {
      loadingHistoryRef.current = false;
    }
  }, [tabId, hasMoreHistory, wrapLines, fontSize, lang]);

  // ---- 垂直滚动（JS 接管）：滚轮 / 自绘滚动条 / 程序性滚动统一走 applyVirtualTop ----
  /** 最近一次用户主动滚动（滚轮/拖动）的时间戳：交互期间锚定纠正不介入。 */
  const lastUserInputRef = useRef(0);
  /** 空闲纠正定时器：交互停止 350ms 后强制一次提交，让布局效应在空闲时收敛锚点。 */
  const idleCorrectTimerRef = useRef<number | null>(null);
  const [, setCorrectionTick] = useState(0);
  const scheduleIdleCorrection = useCallback(() => {
    if (idleCorrectTimerRef.current != null) {
      window.clearTimeout(idleCorrectTimerRef.current);
    }
    idleCorrectTimerRef.current = window.setTimeout(() => {
      idleCorrectTimerRef.current = null;
      setCorrectionTick((n) => n + 1); // 空闲后强制提交一次，触发布局效应重跑
    }, 350);
  }, []);
  useEffect(() => {
    return () => {
      if (idleCorrectTimerRef.current != null) {
        window.clearTimeout(idleCorrectTimerRef.current);
      }
    };
  }, []);
  const followTailRef = useRef(followTail);
  followTailRef.current = followTail;

  // 自绘垂直滚动条 DOM refs（applyVirtualTop 需要同步 thumb 位置，故提前声明）。
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  /** 滚动条交互进行中：期间拦截一切文字选区发起（selectstart 防线）。 */
  const draggingScrollbarRef = useRef(false);
  /** 列表包裹层 DOM：交互期间挂/摘 .dragging-scroll（子树整体禁选，见 App.css）。 */
  const wrapRef = useRef<HTMLDivElement>(null);

  // thumb 顶部位置 = 行空间映射：thumb 比例 f ⇔ 视口首行行号 = f ×（总行数−1）。
  // 日志是行寻址内容，行空间映射让「thumb 在 50% = 看到第 50% 行」精确成立，
  // 不受行高估算误差影响（像素空间映射会有 ~2.6% 的中段偏差）。
  const computeThumbTop = (v: number): number => {
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!track || !thumb) {
      return 0;
    }
    const travel = Math.max(1, track.clientHeight - thumb.offsetHeight);
    const count = filterActiveRef.current ? lines.length : (totalLinesRef.current ?? 0);
    if (count <= 1) {
      return 0;
    }
    const item = virtualizer.getVirtualItemForOffset(v);
    const f = item ? item.index / (count - 1) : 0;
    return Math.round(f * travel);
  };

  // 统一偏移写入入口：clamp 到 [0, totalSize − clientHeight]（虚拟 px，无浏览器上限），
  // 通知虚拟列表（observeElementOffset 的 cb）、同步 inner transform 与 thumb 位置，
  // 并按来源记录用户/程序写入时间戳（供锚定纠正与跳转重居中抑制判断）。
  applyVirtualTopRef.current = (next, source) => {
    const el = listRef.current;
    const maxScroll = Math.max(0, virtualizer.getTotalSize() - (el?.clientHeight ?? 0));
    const v = Math.max(0, Math.min(next, maxScroll));
    if (v !== virtualTopRef.current) {
      virtualTopRef.current = v;
      offsetCbRef.current?.(v, source === "user");
      setScrollOffsetUi(v);
      // 立即同步位移与 thumb（不等 React 提交），滚轮/拖动的视觉延迟与原生一致。
      if (innerRef.current) {
        innerRef.current.style.transform = `translateY(${-v}px)`;
      }
      if (thumbRef.current) {
        thumbRef.current.style.top = `${computeThumbTop(v)}px`;
      }
      if (source === "user") {
        lastUserInputRef.current = Date.now();
        lastUserScrollRef.current = Date.now();
        scheduleIdleCorrection();
      } else {
        lastProgrammaticWriteRef.current = Date.now();
      }
    }
    // 滚动后的副作用统一在此分发（含程序性滚动：跳转/跟随尾部后也要拉块）。
    if (filterActiveRef.current) {
      if (v < 200) {
        void loadMoreHistory();
      }
    } else {
      ensureVisibleBlocks();
    }
  };

  const wheelScrollHandler = useCallback(
    (e: WheelEvent) => {
      // 横向滚动（不换行模式的水平平移）交给原生处理，不拦截。
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        return;
      }
      const el = listRef.current;
      if (!el) {
        return;
      }
      const totalSize = virtualizer.getTotalSize();
      if (totalSize <= 0) {
        return;
      }
      // 向上滚动 = 离开尾部：关闭跟随，避免下一次追加把视图拽回底部。
      if (e.deltaY < 0 && followTailRef.current) {
        setFollowTail(false);
      }
      // deltaMode: 0=像素, 1=行, 2=页 → 统一换算为像素。
      let deltaPx = e.deltaY;
      if (e.deltaMode === 1) {
        deltaPx = e.deltaY * metrics.lineHeight;
      } else if (e.deltaMode === 2) {
        deltaPx = e.deltaY * el.clientHeight;
      }
      if (filterActiveRef.current) {
        // 旧窗口模型（过滤态）：按原生像素量滚动。
        e.preventDefault();
        applyVirtualTopRef.current(virtualTopRef.current + deltaPx, "user");
        return;
      }
      const totalLinesNow = totalLinesRef.current ?? 0;
      if (totalLinesNow <= 0) {
        return;
      }
      // 稀疏模型：按「文件行数」滚动，滚轮与滚动条严格成比例。
      // 视口中心行已加载 → 3 行/格（精细阅读）；未加载 → 放大步长快速穿越占位区。
      const pxPerLine = totalSize / totalLinesNow;
      const items = virtualizer.getVirtualItems();
      const centerIdx = items.length > 0 ? items[Math.floor(items.length / 2)].index : 0;
      const centerLoaded = segLineAt(segmentsRef.current, centerIdx) != null;
      let linesPerNotch = centerLoaded
        ? 3
        : Math.min(200, Math.max(10, Math.round(totalLinesNow / 15_000)));
      if (e.shiftKey || e.ctrlKey) {
        // 按住 Shift/Ctrl：粗粒度快速翻越（~0.4% 文件/格）。
        linesPerNotch = Math.max(linesPerNotch, Math.min(2000, Math.round(totalLinesNow / 250)));
      }
      // 像素模式按浏览器默认 ~100px/格折算为「格」。
      const notches = e.deltaMode === 0 ? e.deltaY / 100 : e.deltaY;
      e.preventDefault();
      const delta = notches * linesPerNotch * pxPerLine;
      applyVirtualTopRef.current(virtualTopRef.current + delta, "user");
    },
    [virtualizer, scheduleIdleCorrection, metrics]
  );

  // React 的 onWheel 在根容器上是 passive 监听，无法 preventDefault；
  // 这里手动挂非 passive 原生监听。
  useEffect(() => {
    const el = listRef.current;
    if (!el) {
      return;
    }
    el.addEventListener("wheel", wheelScrollHandler, { passive: false });
    return () => el.removeEventListener("wheel", wheelScrollHandler);
  }, [wheelScrollHandler]);

  // 滚动条交互期间的最后防线：selectstart 是 Chromium 发起文字选区的必经事件，
  // 交互进行中一律取消。个别 WebView2 版本可能不遵守 pointerdown 取消 /
  // 指针捕获对兼容鼠标事件的抑制，此监听保证拖动滚动条时正文行绝不会被多选。
  useEffect(() => {
    const onSelectStart = (e: Event) => {
      if (draggingScrollbarRef.current) {
        e.preventDefault();
      }
    };
    document.addEventListener("selectstart", onSelectStart);
    return () => document.removeEventListener("selectstart", onSelectStart);
  }, []);

  // ---- 滚动锚定：块加载使行高由占位估算变为实测后，总高会变化； ----
  // 把「首可见行及其相对视口顶部的偏移」钉回原位，消除内容跳动。
  const anchorRef = useRef<{ index: number; offset: number } | null>(null);
  const lastTotalSizeRef = useRef(0);

  // 提交后：先记录锚点（首可见行 + 相对偏移）；若总高变化且用户已停止交互，
  // 回写虚拟偏移让锚点行回到同一视口位置。
  // 关键：用户正在滚轮/拖动期间绝不回写（否则和用户的手打架）；空闲 350ms 后才收敛。
  useLayoutEffect(() => {
    if (!filterActiveRef.current) {
      const items = virtualizer.getVirtualItems();
      const first = items[0];
      if (first) {
        anchorRef.current = { index: first.index, offset: first.start - virtualTopRef.current };
      }
    }
    if (filterActiveRef.current || followTail) {
      return;
    }
    if (Date.now() - lastUserInputRef.current < 350) {
      return;
    }
    // 程序性滚动（跳转/置顶/置底/跟随）刚发生不久：不与其重居中打架。
    if (Date.now() - lastProgrammaticWriteRef.current < 350) {
      return;
    }
    const size = virtualizer.getTotalSize();
    const prev = lastTotalSizeRef.current;
    lastTotalSizeRef.current = size;
    if (prev === 0 || Math.abs(size - prev) <= 0.5) {
      return;
    }
    const anchor = anchorRef.current;
    if (!anchor) {
      return;
    }
    const item = virtualizer.getVirtualItems().find((vi) => vi.index === anchor.index);
    if (item) {
      const want = item.start - anchor.offset;
      if (Math.abs(virtualTopRef.current - want) > 1) {
        applyVirtualTopRef.current(want, "programmatic");
      }
    }
  });

  // ---- 自绘垂直滚动条（thumb 比例 ⇔ 行号比例，拖动幅度 = 实际进度） ----
  const totalSizeUi = virtualizer.getTotalSize();
  const clientHUi = listRef.current?.clientHeight ?? 0;
  const maxScrollUi = Math.max(0, totalSizeUi - clientHUi);
  const thumbHUi =
    maxScrollUi > 0
      ? Math.max(24, Math.round(clientHUi * (clientHUi / Math.max(totalSizeUi, 1))))
      : 0;
  const thumbTopUi = computeThumbTop(scrollOffsetUi);

  const onVScrollbarPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const track = trackRef.current;
      const el = listRef.current;
      if (!track || !el || e.button !== 0) {
        return;
      }
      // 关键：取消 pointerdown 默认行为（发起文字选区/拖拽图像等）。
      // 否则以 thumb 为锚点拖过正文时，浏览器会对正文行发起多选
      // （selectionchange 监听器也会因此点亮「提取」按钮）。
      e.preventDefault();
      // 与原生滚动条一致：点按/拖动滚动条时收起已有的文字选区，
      // 同时让 selectionchange 同步更新「提取」按钮状态。
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        sel.removeAllRanges();
      }
      const totalSize = virtualizer.getTotalSize();
      const maxScroll = Math.max(0, totalSize - el.clientHeight);
      if (maxScroll <= 0) {
        return;
      }
      const trackH = track.clientHeight;
      const thumbH = thumbRef.current?.offsetHeight ?? 24;
      const travel = Math.max(1, trackH - thumbH);
      const trackTop = track.getBoundingClientRect().top;
      const count = filterActiveRef.current ? lines.length : (totalLinesRef.current ?? 0);
      // thumb 比例 f → 目标行（行空间映射）→ 虚拟偏移。
      const fToOffset = (f: number): number => {
        const clamped = Math.max(0, Math.min(1, f));
        const line = Math.round(clamped * Math.max(0, count - 1));
        const off = virtualizer.getOffsetForIndex(line, "start");
        return off ? off[0] : clamped * maxScroll;
      };
      const onThumb = (e.target as HTMLElement).classList.contains("vthumb");
      // 拖动/点跳 = 主动离开尾部：关闭跟随（置底按钮可恢复）。
      setFollowTail(false);
      // 进入滚动条交互：给整个列表子树挂 .dragging-scroll
      // （user-select:none !important），交互期间正文不存在可选中的锚点，
      // 多选从根源上无法发起；直到 pointerup/pointercancel 才摘除。
      draggingScrollbarRef.current = true;
      wrapRef.current?.classList.add("dragging-scroll");
      if (onThumb) {
        // 捕获指针：即使拖出窗口外松开，也能收到 pointerup，
        // 避免 thumb 卡在「拖动态」（窗口级监听拿不到窗口外的事件）。
        try {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          /* 捕获失败不影响拖动（窗口级 move/up 监听兜底） */
        }
      }
      // 拖 thumb：thumb 中心跟随鼠标，内容按行空间映射联动。
      const onMove = (ev: PointerEvent) => {
        if (!onThumb) {
          return;
        }
        const f = Math.max(0, Math.min(1, (ev.clientY - trackTop - thumbH / 2) / travel));
        applyVirtualTopRef.current(fToOffset(f), "user");
        // thumb 直接按鼠标位置定位（行空间 roundtrip 的亚像素误差不反馈到手上）。
        if (thumbRef.current) {
          thumbRef.current.style.top = `${Math.round(f * travel)}px`;
        }
        // 兜底：个别 WebView2 版本若仍在拖动中形成了选区，立即收起。
        const selNow = document.getSelection();
        if (selNow && !selNow.isCollapsed) {
          selNow.removeAllRanges();
        }
      };
      const onUp = (ev: PointerEvent) => {
        const th = thumbRef.current;
        if (th && th.hasPointerCapture(ev.pointerId)) {
          th.releasePointerCapture(ev.pointerId);
        }
        draggingScrollbarRef.current = false;
        wrapRef.current?.classList.remove("dragging-scroll");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      if (!onThumb) {
        // 点轨道：把 thumb 中心定位到点击处（按行空间绝对跳转）。
        const clickY = e.clientY - trackTop;
        const f = Math.max(0, Math.min(1, (clickY - thumbH / 2) / travel));
        applyVirtualTopRef.current(fToOffset(f), "user");
      }
    },
    [virtualizer, lines.length]
  );

  const toggleWrapLines = useCallback((next: boolean) => {
    // 先同步清空行高缓存，再切换 CSS：
    // setWrapLines 触发 DOM 变化后，ResizeObserver 会用真实高度重新填充缓存。
    // 若反过来（先切换、rAF 里再 measure），measure 会晚于 ResizeObserver 回调，
    // 把刚测好的真实高度清掉且无新 resize 触发重测，行停留在估算值上 → 重叠。
    virtualizer.measure();
    setWrapLines(next);
  }, [virtualizer]);

  const toggleAutoRefresh = useCallback(
    async (next: boolean) => {
      setAutoRefresh(next);
      // 仅旧窗口模型（过滤态）需要恢复过滤；稀疏模型的事件本就全量。
      if (next && filterActiveRef.current) {
        try {
          const keywords = tokenizeKeywordInput(keywordInput);
          const regex = regexInput.trim() || null;
          await invoke("set_filter", { tabId, keywords, regex, caseSensitive });
        } catch {
          /* 静默失败 */
        }
      }
    },
    [tabId, keywordInput, regexInput, caseSensitive]
  );

  const applyFilter = useCallback(
    async (caseOverride?: boolean) => {
      const keywords = tokenizeKeywordInput(keywordInput);
      const regex = regexInput.trim() || null;
      // caseOverride 由大小写开关立即重扫时传入；否则用当前状态值。
      const cs = caseOverride ?? caseSensitive;
      const hasSpec = keywords.length > 0 || regex != null;
      if (!hasSpec && !filterActiveRef.current) {
        return; // 稀疏且无过滤条件：无需操作
      }
      try {
        if (!hasSpec) {
          // 清空过滤：回到稀疏模型，锚定在当前视口位置（保持阅读位置）。
          const items = virtualizer.getVirtualItems();
          const first = items.length > 0 ? lines[items[0].index] : undefined;
          const anchorLine = first?.file_line ?? 1;
          await invoke("set_filter", { tabId, keywords, regex, caseSensitive: cs });
          setFilterActive(false);
          setSegments(new Map());
          setJumpRequest({ target: Math.max(0, anchorLine - 1) });
        } else if (!filterActiveRef.current) {
          // 稀疏 → 旧窗口：先按当前锚点物化跳转窗口（后端 all_lines），再应用过滤。
          const items = virtualizer.getVirtualItems();
          const anchor = items.length > 0 ? items[0].index + 1 : 1;
          const j = await invoke<JumpPayload>("jump_to_line", { tabId, lineNo: anchor });
          const matched = await invoke<LogLine[]>("set_filter", {
            tabId,
            keywords,
            regex,
            caseSensitive: cs,
          });
          setLines(clampFrontLines(matched));
          setHasMoreHistory(j.has_more);
          setFilterActive(true);
          setFollowTail(false);
          const targetIdx = matched.findIndex((l) => l.file_line >= anchor);
          setJumpRequest({ target: targetIdx >= 0 ? targetIdx : Math.max(matched.length - 1, 0) });
        } else {
          // 旧窗口模型内更新过滤：返回值即重扫结果（log-lines reset 事件与之等价）。
          const matched = await invoke<LogLine[]>("set_filter", {
            tabId,
            keywords,
            regex,
            caseSensitive: cs,
          });
          setLines(clampFrontLines(matched));
        }
      } catch {
        /* 静默失败 */
      }
    },
    [tabId, keywordInput, regexInput, caseSensitive, lines, virtualizer]
  );

  /** 关键词大小写开关：过滤已生效时立即用新设置重扫；
   *  未生效时仅记录偏好，下次点击「过滤」时生效。 */
  const toggleCaseSensitive = useCallback(() => {
    const next = !caseSensitive;
    setCaseSensitive(next);
    if (filterActiveRef.current) {
      void applyFilter(next);
    }
  }, [caseSensitive, applyFilter]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      applyFilter();
    }
  };

  // 跳转执行：lineNo 为文件行号（1-based；0 = 最后一行）。
  // 后端定位并加载窗口，整体替换视图；过滤条件继续生效，
  // 向上滚动仍可加载更早历史。
  // 返回值：null = 成功；字符串 = 错误信息（供跳转模态框显示）。
  const performJump = useCallback(
    async (lineNo: number): Promise<string | null> => {
      if (jumping) {
        return null;
      }
      setJumping(true);
      try {
        // 注意：Tauri 把 Rust 参数 snake_case 自动映射为 camelCase，
        // line_no 对应 IPC 键 lineNo（其余命令同理：tab_id → tabId）。
        const res = await invoke<JumpPayload>("jump_to_line", { tabId, lineNo });
        // 先关闭尾部跟随：避免下一次追加把视图拉回尾部（与跳转的阅读场景兼容）。
        setFollowTail(false);
        setTotalLines(res.total_lines);
        if (filterActiveRef.current) {
          setLines(clampFrontLines(res.lines));
          setHasMoreHistory(res.has_more);
          const target = Math.min(
            Math.max(res.target_index, 0),
            Math.max(res.lines.length - 1, 0)
          );
          setJumpRequest({ target });
        } else {
          // 稀疏模型：窗口行合并进段缓存，目标定位用文件行号。
          setSegments((prev) => mergeSegments(prev, res.lines));
          const abs = (lineNo === 0 ? res.total_lines : lineNo) - 1;
          setJumpRequest({ target: Math.max(0, Math.min(abs, Math.max(res.total_lines - 1, 0))) });
        }
        return null;
      } catch (e) {
        return String(e);
      } finally {
        setJumping(false);
      }
    },
    [tabId, jumping]
  );

  // 打开跳转模态框。
  const openJumpModal = useCallback(() => {
    setJumpError(null);
    setJumpOpen(true);
  }, []);

  // 取消跳转：收起模态框并清空输入。
  const cancelJump = useCallback(() => {
    setJumpOpen(false);
    setJumpError(null);
    setJumpInput("");
  }, []);

  // 模态框内确认：校验行号（≥1 整数、不超过总行数），失败显示原因，
  // 成功则收起模态框。后端校验兜底（文件为空/行号超限等）。
  const confirmJump = useCallback(async () => {
    const raw = jumpInput.trim();
    const n = Number(raw);
    if (raw === "" || !Number.isInteger(n) || n < 1) {
      setJumpError(t.invalidLine);
      return;
    }
    if (totalLines != null && n > totalLines) {
      setJumpError(t.jumpOutOfRange(totalLines));
      return;
    }
    setJumpError(null);
    const err = await performJump(n);
    if (err == null) {
      setJumpOpen(false);
      setJumpInput("");
    } else {
      setJumpError(t.jumpFailed(err));
    }
  }, [jumpInput, totalLines, performJump, t]);

  // 模态框输入框按键：Enter 确认，Escape 取消。
  const onJumpKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      void confirmJump();
    } else if (e.key === "Escape") {
      cancelJump();
    }
  };

  // 置顶：文件头已加载则直接滚动（保留已加载内容），否则跳转到第 1 行。
  const gotoTop = useCallback(() => {
    setFollowTail(false);
    if (!filterActiveRef.current) {
      // 稀疏：滚动条映射全文件，直接滚到第 0 行即可，块按需加载。
      virtualizer.scrollToIndex(0, { align: "start" });
      ensureVisibleBlocks();
      flashLine(segLineAt(segmentsRef.current, 0)?.file_offset);
      return;
    }
    if (lines[0]?.file_line === 1) {
      virtualizer.scrollToIndex(0, { align: "start" });
      flashLine(lines[0]?.file_offset);
    } else {
      void performJump(1);
    }
  }, [lines, virtualizer, performJump, flashLine, ensureVisibleBlocks]);

  // 置底：已加载到文件尾则直接滚动并恢复跟随，否则跳转到最后一行。
  const gotoBottom = useCallback(() => {
    if (!filterActiveRef.current) {
      // 稀疏：滚到文件末行，恢复尾部跟随。
      setFollowTail(true);
      virtualizer.scrollToEnd();
      ensureVisibleBlocks();
      return;
    }
    const last = lines[lines.length - 1];
    if (totalLines != null && last && last.file_line === totalLines) {
      setFollowTail(true);
      virtualizer.scrollToEnd();
      flashLine(last.file_offset);
    } else {
      void performJump(0).then(() => setFollowTail(true));
    }
  }, [lines, totalLines, virtualizer, performJump, flashLine, ensureVisibleBlocks]);

  // 复制一行文本到剪贴板。
  const copyLine = useCallback(async (text: string) => {
    await copyTextToClipboard(text);
  }, []);

  // 构建「按 file_offset → LogLine」的查找表：合并旧窗口模型 lines 与稀疏段缓存，
  // 供选中行正文提取使用（稀疏模型下远离视口的块可能被淘汰，此时只能取已加载行）。
  const loadedLinesById = useMemo(() => {
    const map = new Map<number, LogLine>();
    for (const l of lines) {
      if (l != null && Number.isFinite(l.file_offset)) {
        map.set(l.file_offset, l);
      }
    }
    for (const block of segments.values()) {
      for (const l of block) {
        if (l != null && Number.isFinite(l.file_offset)) {
          map.set(l.file_offset, l);
        }
      }
    }
    return map;
  }, [lines, segments]);

  // 记录最近一次「非折叠文字选区」所在的列表容器及其选中的 offset 集合。
  // 点选「查看正文」按钮会转移焦点、可能清空 window.getSelection()，
  // 因此用 selectionchange 实时把选区离线保存，点击时无需再读实时选区。
  const lastSelectionRef = useRef<Set<number> | null>(null);
  // 与 ref 同步的 state 镜像：驱动「查看正文」按钮的启用状态。
  const [hasSelection, setHasSelection] = useState(false);
  useEffect(() => {
    const onSelChange = () => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        lastSelectionRef.current = null;
        setHasSelection(false);
        return;
      }
      const container = listRef.current;
      if (!container) {
        return;
      }
      const offsets = new Set<number>();
      let contained = false;
      for (let i = 0; i < sel.rangeCount; i++) {
        const range = sel.getRangeAt(i);
        if (!container.contains(range.commonAncestorContainer)) {
          continue; // 选区不在日志列表内（如选中了输入框文字）
        }
        contained = true;
        container.querySelectorAll<HTMLElement>("[data-offset]").forEach((el) => {
          const off = Number(el.dataset.offset);
          if (Number.isFinite(off) && range.intersectsNode(el)) {
            offsets.add(off);
          }
        });
      }
      lastSelectionRef.current = contained ? offsets : null;
      setHasSelection(contained && offsets.size > 0);
    };
    document.addEventListener("selectionchange", onSelChange);
    return () => document.removeEventListener("selectionchange", onSelChange);
  }, []);

  // 打开正文查看模态框：优先取「最近一次拖选的多行选区」，否则取「最近一次点选的行」。
  const openContentViewer = useCallback(() => {
    const offsets = lastSelectionRef.current;
    let selected: LogLine[] = [];

    if (offsets && offsets.size > 0) {
      selected = [...offsets]
        .map((off) => loadedLinesById.get(off))
        .filter((l): l is LogLine => l != null)
        .sort((a, b) => a.file_offset - b.file_offset);
    }
    // 无有效多行选区 → 退回最近一次点选的行。
    if (selected.length === 0 && lastClickedLine) {
      // 优先取当前缓存中该 offset 的最新文本（如已重载）；失效则用点选快照。
      selected = [loadedLinesById.get(lastClickedLine.file_offset) ?? lastClickedLine];
    }

    if (selected.length === 0) {
      return; // 无选中行：静默（tooltip 已提示用法）
    }
    setViewerLines(selected);
  }, [lastClickedLine, loadedLinesById]);

  // 复制正文查看器当前显示的全文。
  const copyViewerText = useCallback(async () => {
    if (!viewerLines) {
      return;
    }
    const text = viewerLines.map((l) => l.text).join("\n");
    try {
      await copyTextToClipboard(text);
      setViewerFeedback("ok");
    } catch {
      setViewerFeedback("err");
    }
    window.setTimeout(() => setViewerFeedback("idle"), 1200);
  }, [viewerLines]);

  // 点击行：记为最近一次点选（单行查看正文的依据）。
  const handleRowClick = useCallback((line: LogLine) => {
    setLastClickedLine(line);
  }, []);

  // 关闭正文查看器。
  const closeContentViewer = useCallback(() => {
    setViewerLines(null);
    setViewerFeedback("idle");
    setModalSize({ width: defaultModalWidth(), height: defaultModalHeight() });
  }, []);

  // 预设尺寸按钮：快速设置模态框大小。
  // presets: 'small' | 'medium' | 'large' 按默认宽度档位设置；'max' 把当前宽度翻倍。
  const applyModalPreset = useCallback((preset: "small" | "medium" | "large" | "max") => {
    const baseW = defaultModalWidth();
    const baseH = defaultModalHeight();
    let next: { width: number; height: number };
    switch (preset) {
      case "small":
        next = { width: Math.round(baseW * 0.55), height: Math.round(baseH * 0.6) };
        break;
      case "medium":
        next = { width: baseW, height: baseH };
        break;
      case "large":
        next = { width: Math.round(baseW * 1.5), height: baseH };
        break;
      case "max":
        // 宽度设为当前的 2 倍（高度不变）。
        next = {
          width: Math.round(modalSizeRef.current.width * 2),
          height: modalSizeRef.current.height,
        };
        break;
    }
    setModalSize({
      width: Math.max(MODAL_MIN_W, Math.min(next.width, window.innerWidth - 16)),
      height: Math.max(MODAL_MIN_H, Math.min(next.height, window.innerHeight - 16)),
    });
  }, []);

  // 模态框拖拽调整大小：把手（右下角/右边/下边）按下后跟踪指针移动更新尺寸。
  const onModalResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, dirs: { x: 0 | 1 | -1; y: 0 | 1 | -1 }) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = modalSizeRef.current.width;
      const startH = modalSizeRef.current.height;
      const onMove = (ev: PointerEvent) => {
        const dw = (ev.clientX - startX) * dirs.x;
        const dh = (ev.clientY - startY) * dirs.y;
        setModalSize({
          width: Math.round(Math.max(MODAL_MIN_W, startW + dw)),
          height: Math.round(Math.max(MODAL_MIN_H, startH + dh)),
        });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    []
  );

  // 复制当前视图：旧窗口模型复制 lines（过滤后的已加载视图）；
  // 稀疏模型复制段缓存中已加载的行（按文件行号顺序）。不带头行号。
  const copyViewText = useCallback(async () => {
    let text: string;
    if (filterActiveRef.current) {
      text = lines.map((l) => l.text).join("\n");
    } else {
      const blocks = [...segmentsRef.current.keys()].sort((a, b) => a - b);
      const parts: string[] = [];
      for (const b of blocks) {
        const block = segmentsRef.current.get(b)!;
        for (const l of block) {
          if (l) {
            parts.push(l.text);
          }
        }
      }
      text = parts.join("\n");
    }
    await copyTextToClipboard(text);
    return text;
  }, [lines]);

  // 激活时向 App 注册复制函数（供右上角按钮调用）。
  useEffect(() => {
    if (active) {
      registerCopy(tabId, copyViewText);
      return () => registerCopy(tabId, null);
    }
  }, [active, tabId, copyViewText, registerCopy]);

  // 激活时把文件总行数实时同步给 App（窗口右上角显示）。
  useEffect(() => {
    if (active) {
      reportTotal(tabId, totalLines);
      return () => reportTotal(tabId, null);
    }
  }, [active, tabId, totalLines, reportTotal]);

  return (
    <div className="tab-content">
      <div className="toolbar">
        <span className={`tab-path${openError ? " open-error" : ""}`} title={openError ?? path}>
          {openError ? <span className="path-warn">⚠ </span> : null}
          {path || t.pathPlaceholder}
        </span>
        <button className="tab-close" onClick={onClose} title={t.closeTabToolbarTitle}>
          ✕
        </button>
        <span className="toolbar-spacer" />
        <label className="follow">
          <input type="checkbox" checked={followTail} onChange={(e) => setFollowTail(e.target.checked)} />
          {t.followTail}
        </label>
        <label className="follow">
          <input type="checkbox" checked={autoRefresh} onChange={(e) => toggleAutoRefresh(e.target.checked)} />
          {t.autoRefresh}
        </label>
        <label className="follow">
          <input type="checkbox" checked={wrapLines} onChange={(e) => toggleWrapLines(e.target.checked)} />
          {t.wrapLines}
        </label>
        <button onClick={gotoTop} title={t.gotoTopTitle}>
          {t.gotoTop}
        </button>
        <button onClick={gotoBottom} title={t.gotoBottomTitle}>
          {t.gotoBottom}
        </button>
        <button onClick={openJumpModal} title={t.jumpTitle}>
          {t.jump}
        </button>
      </div>

      <div className="filterbar">
        <input
          className="keyword"
          value={keywordInput}
          onChange={(e) => setKeywordInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t.keywordPlaceholder}
        />
        <button
          className={`case-btn${caseSensitive ? " on" : ""}`}
          onClick={toggleCaseSensitive}
          title={caseSensitive ? t.keywordCaseOnTitle : t.keywordCaseOffTitle}
          aria-pressed={caseSensitive}
        >
          <svg width="18" height="13" viewBox="0 0 18 13" aria-hidden="true">
            <text
              x="9"
              y="10"
              textAnchor="middle"
              fontSize="10.5"
              fontWeight="700"
              fill="currentColor"
              fontFamily="inherit"
            >
              Aa
            </text>
            {/* 忽略大小写时给 Aa 加删除线；开启区分大小写时无删除线 */}
            {!caseSensitive && (
              <line x1="3" y1="12" x2="15" y2="12" stroke="currentColor" strokeWidth="1" />
            )}
          </svg>
        </button>
        <input
          className="regex"
          value={regexInput}
          onChange={(e) => setRegexInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t.regexPlaceholder}
        />
        <input
          className="highlight"
          value={highlightInput}
          onChange={(e) => setHighlightInput(e.target.value)}
          placeholder={t.highlightPlaceholder}
        />
        <button onClick={() => void applyFilter()}>{t.applyFilter}</button>
        <button
          className="view-body-btn"
          onClick={openContentViewer}
          disabled={!lastClickedLine && !hasSelection}
          title={t.viewBodyTitle}
        >
          {t.viewBody}
        </button>
        <span className="count">
          {totalLines != null
            ? t.countLinesOfTotal(filterActive ? lines.length : segLoadedCount(segments), totalLines)
            : t.countLines(lines.length)}
        </span>
      </div>

      <div className="list-wrap" ref={wrapRef}>
        <div className={`list ${wrapLines ? "wrap" : "nowrap"}`} ref={listRef}>
          <div
            className="list-inner"
            ref={innerRef}
            style={{
              height: totalSizeUi,
              width: wrapLines ? "100%" : "max-content",
              minWidth: "100%",
              position: "relative",
              transform: `translateY(${-scrollOffsetUi}px)`,
            }}
          >
          {virtualizer.getVirtualItems().map((vi) => {
            const line = filterActive ? lines[vi.index] : segLineAt(segments, vi.index);
            if (!line) {
              // 稀疏模型：未加载区域渲染占位行。行高显式固定为估算值
              // （与 estimateSize 同源），实测不改变总高 → 滚动条稳定。
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  className={`row placeholder ${wrapLines ? "wrap" : "nowrap"}`}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: wrapLines ? "100%" : "max-content",
                    minWidth: "100%",
                    height: `${placeholderHeight(vi.index)}px`,
                    overflow: "hidden",
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <span className="lineno">{vi.index + 1}</span>
                  <span className="text">⋯</span>
                </div>
              );
            }
            const highlighted = highlightOffsets.has(line.file_offset);
            // 用截断后的显示文本渲染（与估算一致）；复制按钮仍复制完整原文。
            const displayText = displayTextOf(line.text, lang);
            const truncated = displayText !== line.text;
            const textParts = highlightMatcher
              ? splitByMatcher(displayText, highlightMatcher)
              : [displayText];
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                data-offset={line.file_offset}
                ref={virtualizer.measureElement}
                className={`row ${wrapLines ? "wrap" : "nowrap"}${highlighted ? " highlight" : ""}`}
                onClick={() => handleRowClick(line)}
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
                  title={t.copyLineTitle}
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
                <span className="lineno">{line.file_line ?? vi.index + 1}</span>
                <span className={`text${truncated ? " truncated" : ""}`}>
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
        {maxScrollUi > 0 ? (
          <div
            className="vscrollbar"
            ref={trackRef}
            onPointerDown={onVScrollbarPointerDown}
            // 兼容鼠标事件层再取消一次 mousedown 默认行为（含发起文字选区），
            // 防住不遵守 pointerdown 取消抑制的旧 WebView2 版本。
            onMouseDown={(e) => e.preventDefault()}
          >
            <div
              className="vthumb"
              ref={thumbRef}
              style={{ top: `${thumbTopUi}px`, height: `${thumbHUi}px` }}
            />
          </div>
        ) : null}
      </div>

      {viewerLines ? (
        <div className="body-modal-overlay" onClick={closeContentViewer}>
          <div
            className="body-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            style={{
              width: Math.min(modalSize.width, window.innerWidth - 16),
              height: Math.min(modalSize.height, window.innerHeight - 16),
            }}
          >
            <div className="body-modal-header">
              <span className="body-modal-title">{t.viewBody}</span>
              <span className="body-modal-count">{t.viewBodyCount(viewerLines.length)}</span>
              <span className="body-modal-spacer" />
              <button
                className="body-modal-btn body-modal-size-btn"
                onClick={() => applyModalPreset("small")}
                title={t.viewBodySizeSmall}
              >
                {t.viewBodySizeSmall}
              </button>
              <button
                className="body-modal-btn body-modal-size-btn"
                onClick={() => applyModalPreset("medium")}
                title={t.viewBodySizeMedium}
              >
                {t.viewBodySizeMedium}
              </button>
              <button
                className="body-modal-btn body-modal-size-btn"
                onClick={() => applyModalPreset("large")}
                title={t.viewBodySizeLarge}
              >
                {t.viewBodySizeLarge}
              </button>
              <button
                className="body-modal-btn body-modal-size-btn"
                onClick={() => applyModalPreset("max")}
                title={t.viewBodySizeMax}
              >
                {t.viewBodySizeMax}
              </button>
              <button
                className="body-modal-btn"
                onClick={() => void copyViewerText()}
                title={t.copyViewTitle}
              >
                {viewerFeedback === "ok"
                  ? t.copyViewOk
                  : viewerFeedback === "err"
                    ? t.copyViewErr
                    : t.viewBodyCopy}
              </button>
              <button className="body-modal-btn" onClick={closeContentViewer} title={t.viewBodyClose}>
                {t.viewBodyClose}
              </button>
            </div>
            <div className="body-modal-body">
              {viewerLines.map((l) => (
                <div className="body-modal-line" key={l.file_offset}>
                  <span className="body-modal-lineno">{l.file_line}</span>
                  <span className="body-modal-text">{l.text}</span>
                </div>
              ))}
            </div>
            <div
              className="body-modal-resizer resizer-e"
              onPointerDown={(e) => onModalResizeStart(e, { x: 1, y: 0 })}
            />
            <div
              className="body-modal-resizer resizer-s"
              onPointerDown={(e) => onModalResizeStart(e, { x: 0, y: 1 })}
            />
            <div
              className="body-modal-resizer resizer-se"
              onPointerDown={(e) => onModalResizeStart(e, { x: 1, y: 1 })}
            />
          </div>
        </div>
      ) : null}

      {jumpOpen ? (
        <div
          className="body-modal-overlay"
          onClick={cancelJump}
          onKeyDown={(e) => {
            // 焦点在输入框之外（如按钮）时也能 Esc 取消。
            if (e.key === "Escape") {
              cancelJump();
            }
          }}
        >
          <div
            className="jump-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t.jumpModalTitle}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="jump-modal-title">{t.jumpModalTitle}</div>
            <input
              ref={jumpInputRef}
              className="jump-modal-input"
              value={jumpInput}
              onChange={(e) => {
                setJumpInput(e.target.value);
                setJumpError(null);
              }}
              onKeyDown={onJumpKeyDown}
              placeholder={
                totalLines != null ? t.jumpPlaceholderRange(totalLines) : t.jumpPlaceholder
              }
              inputMode="numeric"
              spellCheck={false}
            />
            {jumpError != null ? <div className="jump-modal-error">{jumpError}</div> : null}
            <div className="jump-modal-actions">
              <button
                className="body-modal-btn jump-cancel"
                onClick={cancelJump}
                disabled={jumping}
                title={t.jumpCancel}
              >
                {t.jumpCancel}
              </button>
              <button
                className="body-modal-btn"
                onClick={() => void confirmJump()}
                disabled={jumping}
                title={t.jumpConfirm}
              >
                {jumping ? "…" : t.jumpConfirm}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function App() {
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  // 文件拖拽进行中：显示全屏放置提示遮罩。
  const [dragActive, setDragActive] = useState(false);

  // ---- 最近打开记录（首行最左侧历史下拉） ----
  const [recentPaths, setRecentPaths] = useState<string[]>(() => readRecentPaths());
  const [recentOpen, setRecentOpen] = useState(false);
  // 下拉菜单的固定定位坐标（展开时从图标矩形读取；tabbar 是滚动容器，
  // 菜单经 portal 渲染到 body 上避免被 overflow 裁剪）。
  const [recentMenuPos, setRecentMenuPos] = useState<{ left: number; top: number } | null>(null);
  const recentBtnRef = useRef<HTMLButtonElement>(null);
  const recentMenuRef = useRef<HTMLDivElement>(null);

  // ---- 文件记忆：保存当前标签页（在恢复完成前不写入，避免空列表覆盖存档） ----
  const restoredRef = useRef(false);

  // 保存：任何标签变化（打开/关闭/切换激活）都写入 localStorage。
  useEffect(() => {
    if (!restoredRef.current) {
      return;
    }
    try {
      localStorage.setItem(
        "lv-tabs",
        JSON.stringify({
          paths: tabs.map((t) => t.path),
          active: tabs.findIndex((t) => t.id === activeTabId),
        })
      );
    } catch {
      /* localStorage 不可用时静默 */
    }
  }, [tabs, activeTabId]);

  // 最近打开记录持久化（仅保存路径，不做任何文件系统检查）。
  useEffect(() => {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recentPaths));
    } catch {
      /* localStorage 不可用时静默 */
    }
  }, [recentPaths]);

  // 历史下拉展开时：点击菜单外任意处 / 按 Esc / 窗口尺寸变化时收起。
  useEffect(() => {
    if (!recentOpen) {
      return;
    }
    const onDown = (e: MouseEvent) => {
      const menu = recentMenuRef.current;
      const btn = recentBtnRef.current;
      const target = e.target as Node;
      // 图标按钮自身负责 toggle（否则 mousedown 先关、click 又开，开关失灵）。
      if (btn && btn.contains(target)) {
        return;
      }
      if (menu && !menu.contains(target)) {
        setRecentOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setRecentOpen(false);
      }
    };
    const onResize = () => setRecentOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [recentOpen]);

  // ---- client_cfg 表格数据（.bin tab 的解析结果，key 为 tabId） ----
  const [cfgTables, setCfgTables] = useState<Record<string, ClientCfgTable>>({});

  /** 解析一个 client_cfg bin：成功存表数据，失败标记到该 tab。 */
  const parseCfg = useCallback(
    async (tabId: string, binPath: string, slotsPath?: string) => {
      try {
        const table = await invoke<ClientCfgTable>("parse_client_cfg_bin", {
          path: binPath,
          slotsPath: slotsPath ?? null,
        });
        setCfgTables((prev) => ({ ...prev, [tabId]: table }));
        setTabs((prev) =>
          prev.map((t) => (t.id === tabId ? { ...t, openError: undefined } : t))
        );
      } catch (e) {
        setTabs((prev) =>
          prev.map((t) => (t.id === tabId ? { ...t, openError: String(e) } : t))
        );
      }
    },
    []
  );

  /** 手动选择 cfg_table_slots.json 后重新解析指定 tab。 */
  const pickCfgSchema = useCallback(
    async (tabId: string, binPath: string) => {
      try {
        const selected = await open({
          multiple: false,
          filters: [{ name: "cfg_table_slots.json", extensions: ["json"] }],
        });
        if (typeof selected === "string") {
          await parseCfg(tabId, binPath, selected);
        }
      } catch (e) {
        console.error("pickCfgSchema failed", e);
      }
    },
    [parseCfg]
  );

  // 恢复：挂载时读上次会话，重建标签页并重新打开文件（默认全部按文本打开）。
  useEffect(() => {
    const saved = readSavedTabs();
    restoredRef.current = true; // 先标记完成，避免后续保存被跳过
    if (!saved || saved.paths.length === 0) {
      return;
    }
    // 历史存档可能有重复路径（旧版本/异常场景），按 Windows 大小写不敏感去重。
    const seen = new Set<string>();
    const list: TabInfo[] = [];
    for (const p of saved.paths) {
      const key = p.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const id = nextTabId();
      list.push({ id, title: p.split(/[\\/]/).pop() || p, path: p });
    }
    setTabs(list);
    setActiveTabId(list[saved.active]?.id ?? list[list.length - 1]?.id ?? null);
    for (const t of list) {
      // 逐个打开；文件已删除等失败情况记录到 tab，界面显示 ⚠ 提示。
      void invoke("open_log_file", { tabId: t.id, path: t.path }).catch((e) => {
        setTabs((prev) =>
          prev.map((x) => (x.id === t.id ? { ...x, openError: String(e) } : x))
        );
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 主题（dark/light），持久化到 localStorage。
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      return localStorage.getItem("lv-theme") === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });

  // 日志字体大小（10–20px），持久化。
  const [fontSize, setFontSize] = useState(() => {
    try {
      const v = Number(localStorage.getItem("lv-fontsize"));
      return v >= 10 && v <= 20 ? v : 12;
    } catch {
      return 12;
    }
  });

  // 界面语言（zh/en），持久化；默认中文。
  const [lang, setLang] = useState<Lang>(() => {
    try {
      return localStorage.getItem("lv-lang") === "en" ? "en" : "zh";
    } catch {
      return "zh";
    }
  });

  const appT = MESSAGES[lang];

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("lv-theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem("lv-fontsize", String(fontSize));
    } catch {
      /* ignore */
    }
  }, [fontSize]);

  useEffect(() => {
    document.documentElement.lang = lang;
    try {
      localStorage.setItem("lv-lang", lang);
    } catch {
      /* ignore */
    }
  }, [lang]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  // ---- 窗口「始终置顶」 ----
  // 后端 toggle_always_on_top 返回权威结果，本地 UI 状态据此回滚，避免窗口错配。
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const toggleAlwaysOnTop = useCallback(() => {
    void invoke<boolean>("toggle_always_on_top")
      .then((v) => setAlwaysOnTop(v))
      .catch(() => {
        /* 后端不可用（如 dev 浏览器）时静默忽略 */
      });
  }, []);

  const toggleLang = useCallback(() => {
    setLang((l) => (l === "zh" ? "en" : "zh"));
  }, []);

  const changeFontSize = useCallback((delta: number) => {
    setFontSize((f) => Math.min(20, Math.max(10, f + delta)));
  }, []);

  // ---- 右上角「复制当前视图」按钮 ----
  // 活动 tab 通过 registerCopy 注册自己的复制函数；
  // 注销时仅清除「仍指向本 tab」的注册，避免切换 tab 时误清新 tab 的注册。
  const copyViewRef = useRef<{ tabId: string; fn: () => Promise<string> } | null>(null);
  const [copyReady, setCopyReady] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<"idle" | "ok" | "err">("idle");

  const registerCopy = useCallback(
    (tabId: string, fn: (() => Promise<string>) | null) => {
      if (fn) {
        copyViewRef.current = { tabId, fn };
      } else if (copyViewRef.current?.tabId === tabId) {
        copyViewRef.current = null;
      }
      setCopyReady(copyViewRef.current != null);
    },
    []
  );

  // ---- 右上角「文件总行数」显示 ----
  // 活动 tab 通过 reportTotal 实时上报；注销时仅清除「仍指向本 tab」的上报。
  const [activeTotal, setActiveTotal] = useState<number | null>(null);
  const totalTabRef = useRef<string | null>(null);
  const reportTotal = useCallback((tabId: string, total: number | null) => {
    if (total != null) {
      totalTabRef.current = tabId;
      setActiveTotal(total);
    } else if (totalTabRef.current === tabId) {
      totalTabRef.current = null;
      setActiveTotal(null);
    }
  }, []);

  const handleCopyView = useCallback(async () => {
    const reg = copyViewRef.current;
    if (!reg) {
      return;
    }
    try {
      await reg.fn();
      setCopyFeedback("ok");
    } catch {
      setCopyFeedback("err");
    }
    window.setTimeout(() => setCopyFeedback("idle"), 1200);
  }, []);

  // 打开新文件：新建一个 tab（默认文本视图；MemoryPack 表格视图由用户手动切换）。
  // 同路径（Windows 大小写不敏感）已打开且未失败时直接激活，不重复打开。
  const tabsRef = useRef<TabInfo[]>([]);
  tabsRef.current = tabs;

  /** 打开指定路径（对话框选中后 / 自动化钩子 / 会话恢复共用）。 */
  const openPath = useCallback(async (selected: string) => {
    const key = selected.toLowerCase();
    const existing = tabsRef.current.find((t) => t.path.toLowerCase() === key && !t.openError);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const id = nextTabId();
    const name = selected.split(/[\\/]/).pop() || selected;
    // 记录到最近打开历史（去重、上限 10 条；不做存在性检查）。
    setRecentPaths((prev) => pushRecentPath(prev, selected));
    // 先建 tab，再让后端打开文件。
    setTabs((prev) => [...prev, { id, title: name, path: selected }]);
    setActiveTabId(id);
    try {
      await invoke("open_log_file", { tabId: id, path: selected });
    } catch (e) {
      // 打开失败：错误标记到该 tab（工具栏显示 ⚠，悬停看原因）。
      setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, openError: String(e) } : t)));
    }
  }, []);

  /** 切换指定 tab 的视图模式；切到表格时触发 client_cfg 解析。 */
  const switchViewMode = useCallback(
    (tabId: string, mode: "text" | "cfg", binPath: string) => {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? { ...t, viewMode: mode, openError: mode === "cfg" ? undefined : t.openError }
            : t
        )
      );
      if (mode === "cfg") {
        void parseCfg(tabId, binPath);
      }
    },
    [parseCfg]
  );

  // 文件拖拽打开：监听 Tauri 原生拖放事件（Windows 上走 WebView2 原生 DnD，
  // 无需 HTML5 DataTransfer，可直接拿到文件系统路径）。
  // enter/over 显示全屏遮罩；drop 为每个拖入的文件新建 tab 打开；leave 隐藏遮罩。
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const type = event.payload.type;
        if (type === "enter" || type === "over") {
          setDragActive(true);
        } else if (type === "leave") {
          setDragActive(false);
        } else if (type === "drop") {
          setDragActive(false);
          for (const p of event.payload.paths) {
            void openPath(p);
          }
        }
      })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [openPath]);

  const handleOpen = useCallback(async () => {
    setOpening(true);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: appT.openDialogName, extensions: ["log", "txt", "bin", "*"] }],
      });
      if (typeof selected === "string") {
        await openPath(selected);
      }
    } catch (e) {
      console.error(appT.openFailed, e);
    } finally {
      setOpening(false);
    }
  }, [appT, openPath]);

  /** 历史下拉的开关：展开时从图标矩形读取坐标（portal 定位用）。 */
  const toggleRecentMenu = useCallback(() => {
    if (recentOpen) {
      setRecentOpen(false);
      return;
    }
    const r = recentBtnRef.current?.getBoundingClientRect();
    setRecentMenuPos(r ? { left: r.left, top: r.bottom } : { left: 0, top: 0 });
    setRecentOpen(true);
  }, [recentOpen]);

  /** 历史菜单选中一项：同路径的 tab 已打开（且打开成功）→ 激活它，不新建；
   *  否则走常规打开流程。Windows 路径大小写不敏感，按小写比较。 */
  const openRecent = useCallback(
    (path: string) => {
      setRecentOpen(false);
      const key = path.toLowerCase();
      const existing = tabs.find((t) => t.path.toLowerCase() === key && !t.openError);
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }
      void openPath(path);
    },
    [tabs, openPath]
  );

  /** 单独删除一条历史记录（菜单保持展开，便于连续删除）。 */
  const removeRecent = useCallback((path: string) => {
    const key = path.toLowerCase();
    setRecentPaths((prev) => prev.filter((p) => p.toLowerCase() !== key));
  }, []);

  // 自动化/调试钩子：绕过系统文件对话框直接打开文件（供 E2E 测试驱动 UI）。
  useEffect(() => {
    const w = window as unknown as { __lvOpenPath?: (path: string) => void };
    w.__lvOpenPath = (path: string) => {
      void openPath(path);
    };
    return () => {
      delete w.__lvOpenPath;
    };
  }, [openPath]);

  // 启动参数传入的文件（“用 LogLens 打开”入口）：挂载后逐个打开。
  useEffect(() => {
    void invoke<string[]>("get_startup_paths")
      .then((paths) => {
        for (const p of paths) {
          void openPath(p);
        }
      })
      .catch(() => {
        /* 后端不可用（如 dev 浏览器）时静默忽略 */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeTab = useCallback(
    (id: string) => {
      // 无论文本还是表格视图，后端会话都要清理。
      void invoke("close_tab", { tabId: id });
      setCfgTables((prev) => {
        if (!(id in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[id];
        return next;
      });
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

  /** 当前激活 tab 及其视图模式（右上角「表格/文本」切换图标用）。 */
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeIsCfg = activeTab?.viewMode === "cfg";

  return (
    <div
      className="loglens"
      style={{ "--log-font-size": `${fontSize}px` } as React.CSSProperties}
    >
      <div className="tabbar">
        <button
          className="recent-btn"
          ref={recentBtnRef}
          onClick={toggleRecentMenu}
          title={appT.recentTitle}
          aria-haspopup="menu"
          aria-expanded={recentOpen}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" />
            <path d="M8 4.5V8l2.5 1.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
          </svg>
        </button>
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
                title={appT.closeTabTitle}
              >
                ✕
              </button>
            </div>
          ))}
          <button className="tab-add" onClick={handleOpen} disabled={opening} title={appT.openTabTitle}>
            {opening ? "…" : appT.openTab}
          </button>
        </div>
        <div className="tabbar-right">
          <span className="total-lines" title={appT.totalLinesTitle}>
            {activeTotal != null ? appT.countLines(activeTotal) : ""}
          </span>
          <button
            className="icon-btn"
            onClick={() => changeFontSize(-1)}
            title={appT.fontSizeSmaller}
            disabled={fontSize <= 10}
          >
            A-
          </button>
          <span className="font-label">{fontSize}px</span>
          <button
            className="icon-btn"
            onClick={() => changeFontSize(1)}
            title={appT.fontSizeBigger}
            disabled={fontSize >= 20}
          >
            A+
          </button>
          <button
            className={`icon-btn cfg-toggle${activeIsCfg ? " on" : ""}`}
            onClick={() => {
              if (activeTab) {
                switchViewMode(activeTab.id, activeIsCfg ? "text" : "cfg", activeTab.path);
              }
            }}
            disabled={!activeTab}
            aria-pressed={activeIsCfg}
            title={activeIsCfg ? appT.cfgBackTextTitle : appT.cfgViewTitle}
          >
            {activeIsCfg ? (
              /* 文本视图图标：多行文字 */
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M3 4h10M3 8h10M3 12h6" stroke="currentColor" strokeWidth="1.3" />
              </svg>
            ) : (
              /* 表格视图图标：网格 */
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <rect x="2.5" y="3.5" width="11" height="9" rx="1" stroke="currentColor" strokeWidth="1.2" />
                <path d="M2.5 6.5h11M2.5 9.5h11M6.2 3.5v9M9.8 3.5v9" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            )}
          </button>
          <button
            className="icon-btn copy-view"
            onClick={() => void handleCopyView()}
            disabled={!copyReady}
            title={
              copyFeedback === "ok"
                ? appT.copyViewOk
                : copyFeedback === "err"
                  ? appT.copyViewErr
                  : appT.copyViewTitle
            }
          >
            {copyFeedback === "ok" ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M2.5 8.5L6 12L13.5 4" stroke="currentColor" strokeWidth="1.6" />
              </svg>
            ) : copyFeedback === "err" ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M8 3V9" stroke="currentColor" strokeWidth="1.6" />
                <circle cx="8" cy="12" r="1" fill="currentColor" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <rect x="5.5" y="5.5" width="9" height="9" rx="1" stroke="currentColor" strokeWidth="1.2" />
                <path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" stroke="currentColor" strokeWidth="1.2" fill="none" />
              </svg>
            )}
          </button>
          <button
            className="icon-btn lang-toggle"
            onClick={toggleLang}
            title={appT.switchLangTitle(lang)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" />
              <path d="M2 8h12M8 2c-4.5 3-4.5 9 0 12M8 2c4.5 3 4.5 9 0 12" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
          <button
            className="icon-btn always-on-top"
            onClick={toggleAlwaysOnTop}
            title={alwaysOnTop ? appT.alwaysOnTopOn : appT.alwaysOnTopOff}
            aria-pressed={alwaysOnTop}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M5.5 10V5.5a2.5 2.5 0 0 1 5 0V10"
                stroke="currentColor"
                strokeWidth="1.3"
                fill="none"
              />
              <path d="M8 10v3" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          </button>
          <button
            className="icon-btn"
            onClick={toggleTheme}
            title={theme === "dark" ? appT.switchToLight : appT.switchToDark}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
        </div>
      </div>

      {recentOpen && recentMenuPos
        ? createPortal(
            <div
              className="recent-menu"
              ref={recentMenuRef}
              role="menu"
              style={{ position: "fixed", left: recentMenuPos.left, top: recentMenuPos.top }}
            >
              {recentPaths.length === 0 ? (
                <div className="recent-empty">{appT.recentEmpty}</div>
              ) : (
                recentPaths.map((p) => {
                  const name = p.split(/[\\/]/).pop() || p;
                  return (
                    <div key={p.toLowerCase()} className="recent-item" role="menuitem" title={p}>
                      <button className="recent-open" onClick={() => openRecent(p)}>
                        <span className="recent-name">{name}</span>
                        <span className="recent-path">{p}</span>
                      </button>
                      <button
                        className="recent-del"
                        onClick={() => removeRecent(p)}
                        title={appT.recentDeleteTitle}
                      >
                        ✕
                      </button>
                    </div>
                  );
                })
              )}
            </div>,
            document.body
          )
        : null}

      {tabs.length > 0 ? (
        <>
          {tabs.map((t) => (
            <div
              key={t.id}
              className="tab-panel"
              style={{ display: t.id === activeTabId ? "flex" : "none" }}
            >
              {t.viewMode === "cfg" ? (
                <CfgTableTab
                  tabId={t.id}
                  path={t.path}
                  data={cfgTables[t.id] ?? null}
                  error={t.openError}
                  active={t.id === activeTabId}
                  fontSize={fontSize}
                  uiLang={lang}
                  onPickSchema={() => void pickCfgSchema(t.id, t.path)}
                  registerCopy={registerCopy}
                  reportTotal={reportTotal}
                />
              ) : (
                <LogTab
                  tabId={t.id}
                  path={t.path}
                  openError={t.openError}
                  active={t.id === activeTabId}
                  fontSize={fontSize}
                  lang={lang}
                  onClose={() => closeTab(t.id)}
                  registerCopy={registerCopy}
                  reportTotal={reportTotal}
                />
              )}
            </div>
          ))}
        </>
      ) : (
        <div className="empty">
          <p>{appT.noFileOpened}</p>
          <button className="open-first" onClick={handleOpen} disabled={opening}>
            {opening ? appT.opening : appT.openFirst}
          </button>
        </div>
      )}

      {dragActive ? (
        <div className="drop-overlay">
          <div className="drop-overlay-box">{appT.dropToOpen}</div>
        </div>
      ) : null}
    </div>
  );
}
