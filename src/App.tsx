import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { CfgTableTab, type ClientCfgTable } from "./CfgTableTab";
import { copyTextToClipboard } from "./clipboard";
import { isMarkdownPath } from "./markdown/paths.ts";
import {
  SettingsModal,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  applyFontSettings,
  clampFontSize,
  readSettings,
  writeSettings,
  type AppSettings,
} from "./settings";
import {
  AUTO_ID,
  EncodingModal,
  StatusBar,
  detectEncoding,
  fetchTabEncoding,
  type EncodingInfo,
} from "./statusbar";
import {
  APP_BODY_VIEWS,
  BodyViewHost,
  BodyViewRegistry,
  FileMissingView,
  OpenErrorView,
  classifyOpenError,
  useBodyViewEffects,
  type AppBodyViewId,
  type BodyViewProps,
  type OpenErrorInfo,
  type ViewLang,
  type ViewMode,
} from "./views";
import type { MdDoc } from "./views/MarkdownView";
import "./App.css";

/**
 * Markdown 预览页**按需加载**。
 *
 * 这一页带着 marked + KaTeX + highlight.js（约 600 KB JS，外加 KaTeX 的全部字体），
 * 而绝大多数会话根本不会打开 .md 文件。用 `lazy` + 动态 import 把它切成独立 chunk：
 * 文本视图的启动路径（解析 JS、拉字体）完全不受影响，代价只是第一次切到
 * Markdown 时多一次本地 chunk 加载（毫秒级，页面内已有「渲染中…」占位）。
 *
 * 注意：`src/views/index.ts` 因此**不导出** MarkdownView（否则这里就退化回静态依赖）。
 */
const LazyMarkdownView = lazy(() =>
  import("./views/MarkdownView").then((m) => ({ default: m.MarkdownView }))
);

/** 一行日志（与后端 LogLine 对应）。 */
interface LogLine {
  /** 稳定行标识（后端单调分配；历史行为负数）。必须全局唯一：用作 React key
   *  与虚拟滚动测量缓存的 key，碰撞会导致相邻行重叠。 */
  file_offset: number;
  /** 该行在文件中的真实行号（1-based）。行号列优先显示它。 */
  file_line: number;
  text: string;
}

/** 后端 search_lines 命令的单条命中（与 Rust SearchHit 对应）。 */
interface SearchHit {
  /** 命中所处的文件行号（1-based）。 */
  file_line: number;
  /** 命中在**原始行文本**中的字符偏移（用于定位当前命中并加重高亮）。 */
  offset: number;
}

/** 后端 search_lines 命令的返回负载（与 Rust SearchPage 对应）。 */
interface SearchPage {
  hits: SearchHit[];
  /** true = 已扫到搜索范围末尾；false = 触发 10 万命中封顶，后面可能还有。 */
  complete: boolean;
  /** 搜索范围总行数（过滤态 = 过滤后行数；否则 = 文件总行数）。 */
  scope_total: number;
}

/** 单次前向搜索回传的命中数上限（与后端 SEARCH_HIT_CAP 保持一致）。 */
const SEARCH_HIT_CAP = 100_000;

/** 后端 log-lines 事件负载（带 tab_id）。 */
interface LinesPayload {
  tab_id: string;
  lines: LogLine[];
  reset: boolean;
  /**
   * 暂停跟随时是否仍要应用这批（仅 `reset = true` 时有意义）。
   *
   * `true` = 用户动作引起的会话重建（打开文件 / 换编码）：必须生效，否则正文
   * 永远停在旧编码上且不会自愈。`false` = 实时批次（追加 / 轮转 / 过滤重扫）：
   * 暂停跟随时按设计丢弃。见 Rust `LinesPayload::apply_when_paused`。
   */
  apply_when_paused?: boolean;
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
  /** 当前视图模式：默认文本（日志）；.md/.markdown 打开时自动进 Markdown 预览，
   *  用户也可手动切换文本 / 表格 / Markdown（见 views/app-body-views.ts）。 */
  viewMode?: ViewMode;
  /**
   * 打开本 tab 时要跳转到的锚点（`other.md#sec` 这类跨文档链接带入）。
   *
   * 放在 tab 状态里而不是「渲染时读的 ref 表」：锚点是**一次性的指令**，
   * 需要一次状态更新把它送到目标页面（ref 表在「目标 tab 恰好已是激活态」等
   * 边界下不会触发重渲染，锚点就悄悄丢了）；页面消费后再写回 undefined。
   */
  anchor?: string;
  /**
   * 是否已为该 tab 建立过**文本 tail 会话**（open_log_file）。
   *
   * Markdown / 表格视图直接打开的 tab 不走文本会话，切回文本视图时要补一次
   * `open_log_file`，否则正文是空的（文本视图只 `get_lines`，不会自己开文件）。
   * 反过来也不能无条件补：`open_log_file` 会清空会话并重启一个 tail 线程
   * （见 state.rs 的 start_watching_for_session），对已打开的 tab 重复调用
   * 会把已加载内容清掉、还会多留一个 watcher。
   */
  textOpened?: boolean;
  /** 打开失败（如恢复上次会话时文件已被删除）时的错误信息；成功打开为 undefined。 */
  openError?: string;
  /** 表格视图解析用的 schema 文件路径（手动指定）；null/undefined = 尚未选择。 */
  slotsPath?: string | null;
  /**
   * 本 tab 的文本编码**选择**（`auto` 或目录 id，见 `src/statusbar/encoding.ts`）。
   *
   * 存「选择」而不是「探测结果」：选了 `auto` 的 tab 重新打开时要重新探测
   * （文件可能被别的工具改写成了另一种编码），只有用户手动指定的才固化下来。
   * 表格视图（二进制）不适用，恒为 undefined。
   */
  encoding?: string;
}

/** 文件 tab 右键菜单的展开状态：目标 tab + 光标坐标（portal fixed 定位用）。 */
interface TabMenuState {
  tabId: string;
  x: number;
  y: number;
}

/** 拖拽手势的待定状态（pointerdown 记录，移动超过阈值才升级为真正拖拽）。 */
interface PendingTabDrag {
  tabId: string;
  pointerId: number;
  startX: number;
  startY: number;
  /** 指针相对源 tab 左上角的横向偏移（ghost 锚定，拖动中不跳变）。 */
  offsetX: number;
  /** 源 tab 的起始矩形（ghost 顶边/宽高）。 */
  rect: { top: number; width: number; height: number };
  /** 源 tab 在手势开始时的下标。 */
  from: number;
}

/** tab 拖拽进行中的状态（ghost 坐标 + 插入目标位置）。 */
interface TabDragState {
  tabId: string;
  pointerId: number;
  /** ghost 左上角 fixed 坐标。 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 插入指示线在 .tabs 容器内的横坐标。 */
  indicatorX: number;
  /** 插入目标：在含源 tab 的序列里插到该下标之前（== tabs.length 表示末尾）。 */
  target: number;
  /** 源 tab 在手势开始时的下标。 */
  from: number;
}

// ==================== 文件记忆（重启恢复上次打开的文件） ====================

/** localStorage 中保存的标签页列表。 */
interface SavedTabs {
  paths: string[];
  /** 上次激活的 tab 下标。 */
  active: number;
  /** 每个 tab 选择的 schema 文件路径（与 paths 下标对齐；null = 自动定位）。 */
  schemas?: (string | null)[];
  /** 每个 tab 的视图模式（与 paths 下标对齐；null/缺失 = 按扩展名推断）。 */
  modes?: (ViewMode | null)[];
  /**
   * 每个 tab 的编码选择（与 paths 下标对齐；null/缺失 = 自动探测）。
   * 只记用户手动指定的编码：`auto` 的 tab 存 null，下次打开重新探测。
   */
  encodings?: (string | null)[];
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
    const schemas = Array.isArray(v.schemas)
      ? v.schemas.slice(0, paths.length).map((s) =>
          typeof s === "string" && s.length > 0 ? s : null
        )
      : undefined;
    // 老存档没有 modes 字段：留给下方按扩展名推断（Markdown 文件仍会自动进预览）。
    const modes = Array.isArray(v.modes)
      ? v.modes.slice(0, paths.length).map((m) =>
          m === "text" || m === "cfg" || m === "md" ? m : null
        )
      : undefined;
    // 编码同理：老存档没有 encodings 字段，null 即「自动探测」。
    const encodings = Array.isArray(v.encodings)
      ? v.encodings.slice(0, paths.length).map((e) =>
          typeof e === "string" && e.length > 0 ? e : null
        )
      : undefined;
    return {
      paths,
      active: typeof v.active === "number" ? v.active : paths.length - 1,
      schemas,
      modes,
      encodings,
    };
  } catch {
    return null;
  }
}

/** 按扩展名推断默认视图模式：Markdown 文件直接进预览，其余按文本日志打开。 */
function defaultViewModeFor(path: string): ViewMode {
  return isMarkdownPath(path) ? "md" : "text";
}

/** 读取 Markdown 文件的大小上限（字节）。
 *
 * 后端默认上限是 4 MiB，这里主动收窄到 2 MiB：整篇 Markdown 要在主线程解析并排版，
 * 更大的文件会让切页明显卡顿，而「截断预览 + 横幅提示」比卡住的界面诚实得多。
 * 需要看全文时切到文本视图（那边是稀疏读取，不吃这个上限）。 */
const MD_MAX_BYTES = 2 * 1024 * 1024;

// ==================== schema 文件记录（表格视图解析用） ====================
//
// schema 文件（cfg_table_slots.json）作为应用「记录数据」的一部分保存：
// 用户可以保存多个 schema 文件路径，在视图模式模态框里为当前 tab 选择
// 使用哪一个；不再依赖固定/硬编码的 schema 路径（未选择时回退自动定位）。

/** schema 记录条数上限。 */
const SCHEMA_MAX = 20;
/** localStorage 键。 */
const SCHEMA_KEY = "lv-schemas";

/** 读取 schema 文件记录（无数据/损坏时返回空列表）。 */
function readSchemaPaths(): string[] {
  try {
    const raw = localStorage.getItem(SCHEMA_KEY);
    if (!raw) {
      return [];
    }
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) {
      return [];
    }
    return v
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .slice(0, SCHEMA_MAX);
  } catch {
    return [];
  }
}

/** 把一条 schema 路径插入记录头部：Windows 大小写不敏感去重，截断到上限。 */
function pushSchemaPath(list: string[], path: string): string[] {
  const key = path.toLowerCase();
  return [path, ...list.filter((p) => p.toLowerCase() !== key)].slice(0, SCHEMA_MAX);
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
 * 关键词框视为「一个完整短语」匹配（空格是短语的一部分）；
 * 多条件 OR 请切到正则模式输入，例如 `error|warn`。
 */
function tokenizeKeywordInput(input: string): string[] {
  const trimmed = input.trim();
  return trimmed ? [trimmed] : [];
}

/**
 * 过滤模式。关键词与正则是「互斥」的两种需求：同一时刻只有一种生效，
 * 二者共享过滤栏上的同一个输入位（默认关键词模式）。
 * 每种模式各自记住上一次的输入，切换回来时原样恢复，便于来回对比结果。
 */
type FilterMode = "keyword" | "regex";

/**
 * 把当前模式 + 当前输入解析为后端 FilterSpec 的载荷。
 * 只填当前模式对应的那个字段，另一字段显式置空 —— 由这里保证两模式互斥。
 */
function buildFilterPayload(mode: FilterMode, rawInput: string): {
  keywords: string[];
  regex: string | null;
} {
  if (mode === "regex") {
    const value = rawInput.trim();
    return { keywords: [], regex: value ? value : null };
  }
  return { keywords: tokenizeKeywordInput(rawInput), regex: null };
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

// ==================== 多语言（zh / en） ====================

/** 界面语言。与正文页面框架共用同一联合类型（`src/views/body-view.ts`），避免两处漂移。 */
type Lang = ViewLang;

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
  filterModeKeyword: string;
  filterModeRegex: string;
  filterModeSwitchTitle: string;
  search: string;
  searchTitle: string;
  searchPlaceholder: string;
  searchCaseTitle: string;
  searchWholeWordTitle: string;
  searchNextTitle: string;
  searchPrevTitle: string;
  searchCloseTitle: string;
  searchScanning: string;
  searchNoResults: string;
  searchGo: string;
  searchGoTitle: string;
  searchDirtyHint: string;
  searchFilteredScope: string;
  searchFileScope: string;
  searchCappedHint: string;
  searchScopeFiltered: (n: number) => string;
  searchScopeFile: (n: number) => string;
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
  /** 总菜单里的语言项文案（用当前界面语言书写，如「语言：中文」）。 */
  menuLangTitle: string;
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
  viewModeButtonTitle: string;
  viewModeModalTitle: string;
  viewModeTextName: string;
  viewModeTextDesc: string;
  viewModeCfgName: string;
  viewModeCfgDesc: string;
  viewModeMdName: string;
  viewModeMdDesc: string;
  viewModeCurrent: string;
  viewModeSchemaTitle: string;
  viewModeSchemaAdd: string;
  viewModeSchemaRemove: string;
  viewModeSchemaEmpty: string;
  viewModeSchemaRequired: string;
  tabMenuReveal: string;
  tabMenuCopyPath: string;
  tabMenuCopyPathOk: string;
  aboutTitle: string;
  aboutClose: string;
  aboutVersionLabel: string;
  aboutDesc: string;
  aboutTech: string;
  /** 总菜单里的设置项文案。 */
  settingsTitle: string;
  /** 工具栏齿轮按钮的悬浮提示 / aria。 */
  settingsOpenTitle: string;
  winMinimize: string;
  winMaximize: string;
  winRestore: string;
  winClose: string;
  menuTitle: string;
  menuExit: string;
  /** 状态栏的编码按钮：打开编码弹窗的悬浮提示（按钮自身文案由 StatusBar 负责）。 */
  encodingTitle: string;
  /** 编码弹窗的应用失败（文件此时可能已被删除）。 */
  encodingFailed: (e: string) => string;
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
    regexPlaceholder: "正则（多条件 OR 如 error|warn）",
    filterModeKeyword: "关键词",
    filterModeRegex: "正则",
    filterModeSwitchTitle: "点击切换过滤模式：关键词 / 正则（二者互斥，共用同一输入框）",
    search: "搜索",
    searchTitle: "在正文中搜索（Ctrl+F）",
    searchPlaceholder: "查找",
    searchCaseTitle: "区分大小写",
    searchWholeWordTitle: "全字匹配",
    searchNextTitle: "下一个匹配（Enter）",
    searchPrevTitle: "上一个匹配（Shift+Enter）",
    searchCloseTitle: "关闭搜索（Esc）",
    searchScanning: "搜索中…",
    searchNoResults: "无结果",
    searchGo: "查找",
    searchGoTitle: "查找（Enter）",
    searchDirtyHint: "按 Enter 查找",
    searchFilteredScope: "搜索范围：过滤后的行",
    searchFileScope: "搜索范围：整个文件",
    searchCappedHint: "已达到显示上限，按 Enter 继续向后搜索",
    searchScopeFiltered: (n) => `过滤后 ${n} 行`,
    searchScopeFile: (n) => `全文件 ${n} 行`,
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
    menuLangTitle: "语言：中文",
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
    viewModeButtonTitle: "切换视图模式",
    viewModeModalTitle: "选择视图模式",
    viewModeTextName: "文本视图",
    viewModeTextDesc: "以日志文本方式查看：tail-follow 实时跟随、关键词/正则过滤、高亮与稀疏虚拟滚动。",
    viewModeCfgName: "表格视图",
    viewModeCfgDesc:
      "以 client_cfg 配置表格式解析当前文件。数据为 MemoryPack 二进制序列化格式，解析依赖表结构描述文件 cfg_table_slots.json。",
    viewModeMdName: "Markdown 预览",
    viewModeMdDesc:
      "按文档排版渲染当前文件：支持表格、任务列表、代码高亮与 LaTeX 公式（$…$ / $$…$$），并带大纲与页内查找。图片以占位符显示（本地图片可在资源管理器中定位）。",
    viewModeCurrent: "当前",
    viewModeSchemaTitle: "Schema 文件（表格解析用）",
    viewModeSchemaAdd: "添加 schema 文件…",
    viewModeSchemaRemove: "移除该记录",
    viewModeSchemaEmpty: "尚未保存 schema 文件",
    viewModeSchemaRequired: "请先选择或添加 schema 文件",
    tabMenuReveal: "在文件浏览器中打开",
    tabMenuCopyPath: "复制路径",
    tabMenuCopyPathOk: "已复制路径",
    aboutTitle: "关于 LogLens",
    aboutClose: "关闭",
    aboutVersionLabel: "版本",
    aboutDesc: "大日志实时查看器：tail-follow 实时跟随、关键词/正则过滤、稀疏虚拟滚动，流畅浏览千万行级日志。",
    aboutTech: "Tauri 2 · React · Rust",
    settingsTitle: "设置…",
    settingsOpenTitle: "设置（字体 / 外观）",
    winMinimize: "最小化",
    winMaximize: "最大化",
    winRestore: "还原",
    winClose: "关闭",
    menuTitle: "菜单",
    menuExit: "退出程序",
    encodingTitle: "文件编码",
    encodingFailed: (e) => `切换编码失败: ${e}`,
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
    regexPlaceholder: "Regex (OR conditions like error|warn)",
    filterModeKeyword: "Keyword",
    filterModeRegex: "Regex",
    filterModeSwitchTitle: "Click to switch filter mode: Keyword / Regex (mutually exclusive, same input box)",
    search: "Find",
    searchTitle: "Search in the content (Ctrl+F)",
    searchPlaceholder: "Find",
    searchCaseTitle: "Match case",
    searchWholeWordTitle: "Match whole word",
    searchNextTitle: "Next match (Enter)",
    searchPrevTitle: "Previous match (Shift+Enter)",
    searchCloseTitle: "Close search (Esc)",
    searchScanning: "Searching…",
    searchNoResults: "No results",
    searchGo: "Find",
    searchGoTitle: "Find (Enter)",
    searchDirtyHint: "Press Enter to find",
    searchFilteredScope: "Scope: filtered lines",
    searchFileScope: "Scope: whole file",
    searchCappedHint: "Display cap reached; press Enter to keep searching forward",
    searchScopeFiltered: (n) => `${n} filtered lines`,
    searchScopeFile: (n) => `${n} lines in file`,
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
    menuLangTitle: "Language: English",
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
    viewModeButtonTitle: "Switch view mode",
    viewModeModalTitle: "Select view mode",
    viewModeTextName: "Text view",
    viewModeTextDesc: "View the file as log text: tail-follow live updates, keyword/regex filtering, highlighting and sparse virtual scrolling.",
    viewModeCfgName: "Table view",
    viewModeCfgDesc: "Parse the current file as a client_cfg config table. The data uses the MemoryPack binary serialization format; parsing requires the cfg_table_slots.json schema description.",
    viewModeMdName: "Markdown preview",
    viewModeMdDesc:
      "Render the file as a document: tables, task lists, syntax-highlighted code and LaTeX math ($…$ / $$…$$), plus an outline and in-page find. Images show as placeholders (local ones can be revealed in File Explorer).",
    viewModeCurrent: "Current",
    viewModeSchemaTitle: "Schema files (for table parsing)",
    viewModeSchemaAdd: "Add schema file…",
    viewModeSchemaRemove: "Remove this entry",
    viewModeSchemaEmpty: "No schema files saved",
    viewModeSchemaRequired: "Select or add a schema file first",
    tabMenuReveal: "Reveal in File Explorer",
    tabMenuCopyPath: "Copy path",
    tabMenuCopyPathOk: "Path copied",
    aboutTitle: "About LogLens",
    aboutClose: "Close",
    aboutVersionLabel: "Version",
    aboutDesc: "A realtime large-log viewer: tail-follow, keyword/regex filtering and sparse virtual scrolling for logs with millions of lines.",
    aboutTech: "Tauri 2 · React · Rust",
    settingsTitle: "Settings…",
    settingsOpenTitle: "Settings (fonts / appearance)",
    winMinimize: "Minimize",
    winMaximize: "Maximize",
    winRestore: "Restore",
    winClose: "Close",
    menuTitle: "Menu",
    menuExit: "Exit",
    encodingTitle: "File encoding",
    encodingFailed: (e) => `Failed to change encoding: ${e}`,
  },
};

/** 解析高亮关键词输入：空格分隔多个关键词。 */
function parseHighlightKeywords(input: string): string[] {
  return input
    .split(/\s+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

/** 高亮片段的两种类型：普通文本 | 命中关键词（携带关键词索引用于取色） |
 *  搜索命中（isCurrent 标记当前跳转到的那一处，用更重的颜色强调）。 */
type HighlightPart =
  | string
  | { kw: string; colorIndex: number }
  | { find: string; isCurrent: boolean };

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

/** 搜索匹配器：字符串匹配（非正则），支持大小写敏感与全字匹配。 */
interface SearchMatcher {
  term: string;
  caseSensitive: boolean;
  wholeWord: boolean;
}

/**
 * 全字匹配的边界判断：命中片段两侧不能紧邻「词字符」。
 * 用 Unicode 属性（\p{L}\p{N}_）而不是 ASCII 判断，中文/日文等非 ASCII 文本
 * 才能得到正确边界（否则「错误err」也会被判成独立单词）。
 */
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string): boolean {
  return ch.length > 0 && WORD_CHAR_RE.test(ch);
}

/**
 * 在一行文本里找出搜索词的所有命中位置（返回 [start, end) 的 UTF-16 下标）。
 * 与后端保持一致：大小写不敏感时按 ASCII 折叠比较，不做 Unicode 大小写折叠。
 */
function findSpans(text: string, m: SearchMatcher): [number, number][] {
  if (!m.term) {
    return [];
  }
  const needle = m.caseSensitive ? m.term : m.term.toLowerCase();
  const hay = m.caseSensitive ? text : text.toLowerCase();
  const spans: [number, number][] = [];
  let i = 0;
  while (i <= hay.length - needle.length) {
    const at = hay.indexOf(needle, i);
    if (at < 0) {
      break;
    }
    const end = at + needle.length;
    if (!m.wholeWord || (!isWordChar(text.charAt(at - 1)) && !isWordChar(text.charAt(end)))) {
      spans.push([at, end]);
    }
    i = at + 1; // 允许重叠命中（aaaa 里搜 aa）
  }
  return spans;
}

/**
 * 把一行文本切分为「搜索命中 / 关键词命中 / 普通文本」交替的片段。
 * 搜索命中优先：关键词高亮只作用于搜索命中之间的空隙，避免两套高亮互相打断。
 */
function splitLineBySearch(
  text: string,
  matcher: SearchMatcher | null,
  currentCharOffset: number | null
): HighlightPart[] {
  const spans = matcher ? findSpans(text, matcher) : [];
  if (spans.length === 0) {
    return [text];
  }
  const out: HighlightPart[] = [];
  let cursor = 0;
  for (const [s, e] of spans) {
    if (s > cursor) {
      out.push(text.slice(cursor, s));
    }
    out.push({ find: text.slice(s, e), isCurrent: currentCharOffset != null && s === currentCharOffset });
    cursor = e;
  }
  if (cursor < text.length) {
    out.push(text.slice(cursor));
  }
  return out;
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

/**
 * 带搜索高亮的切分：搜索命中优先成段，其余部分再交给关键词匹配器上色。
 * 这样两套高亮可以共存而不会把对方切断。
 */
function splitWithSearchAndKeywords(
  text: string,
  search: SearchMatcher | null,
  currentCharOffset: number | null,
  keywords: HighlightMatcher | null
): HighlightPart[] {
  const searchParts = splitLineBySearch(text, search, currentCharOffset);
  const hasSearchHit = searchParts.some((p) => typeof p !== "string");
  if (!hasSearchHit) {
    // 没有搜索命中：等价于原来的纯关键词切分。
    return keywords ? splitByMatcher(text, keywords) : [text];
  }
  if (!keywords) {
    return searchParts;
  }
  const out: HighlightPart[] = [];
  for (const part of searchParts) {
    if (typeof part === "string") {
      out.push(...splitByMatcher(part, keywords));
    } else {
      out.push(part);
    }
  }
  return out;
}

/** 文本日志页面的专属属性（公共属性见 `BodyViewProps`）。 */
interface LogTabProps extends BodyViewProps {
  /** 打开失败信息（恢复会话时文件已不存在等）。正常情况下打开失败会由状态页面
   *  整体接管（见下方 bodyViews 注册表），这里保留 ⚠ 提示作为兜底。 */
  openError?: string;
  /** 当前视图模式；工具栏最左侧的图标按钮据此显示「切换到哪种视图」。 */
  viewMode: ViewMode;
}

/** 单个日志 tab：独立的状态（行、过滤、滚动、高亮）与事件监听。 */
function LogTab(props: LogTabProps) {
  // registerCopy / reportTotal 由公共生命周期 hook 直接从 props 取，这里不重复解构。
  const {
    tabId,
    path,
    openError,
    active,
    fontSize,
    lang,
    viewMode,
    onSwitchViewMode,
    onClose,
  } = props;
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
  // ---- 过滤：关键词 / 正则两种互斥模式，共用过滤栏上的同一个输入位 ----
  // 默认关键词模式；两模式各自记住自己的输入，切换回来原样恢复。
  const [filterMode, setFilterMode] = useState<FilterMode>("keyword");
  const [filterKeywordInput, setFilterKeywordInput] = useState("");
  const [filterRegexInput, setFilterRegexInput] = useState("");
  const filterInput = filterMode === "keyword" ? filterKeywordInput : filterRegexInput;
  const filterKeywordInputRef = useRef(filterKeywordInput);
  const filterRegexInputRef = useRef(filterRegexInput);
  const filterModeRef = useRef(filterMode);
  // 这三个 ref 只服务「不能在渲染闭包里读到最新值」的场合，在渲染提交后同步。
  // 过滤主路径不依赖它们：applyFilter 显式接收 mode/rawInput。
  useEffect(() => {
    filterModeRef.current = filterMode;
    filterKeywordInputRef.current = filterKeywordInput;
    filterRegexInputRef.current = filterRegexInput;
  }, [filterMode, filterKeywordInput, filterRegexInput]);
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
  // ---- 正文内搜索（VSCode 风格悬浮框） ----
  // 语义：过滤生效时搜「过滤后的行」，未生效时搜整个文件（后端按 filter 状态决定范围）。
  // 纯前向搜索、不做全局计数：结果是从 from_file_line 起向后扫出的命中窗口。
  const [searchOpen, setSearchOpen] = useState(false);
  /** 输入框里的文本（打字时实时变化，但**不**触发搜索）。 */
  const [searchInput, setSearchInput] = useState("");
  /** 已提交的查询（回车后才更新）—— 搜索、高亮、上下条导航都以它为准。 */
  const [searchQuery, setSearchQuery] = useState("");
  /** 每次「回车提交」自增：驱动搜索 effect，替代「按输入变化搜索」。 */
  const [searchEpoch, setSearchEpoch] = useState(0);
  /** 上次真正发起搜索时的开关组合，用于判断当前开关是否已偏离结果。 */
  const [searchOptionsAtRun, setSearchOptionsAtRun] = useState({ cs: false, ww: false });
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchWholeWord, setSearchWholeWord] = useState(false);
  /** 已扫出的命中窗口（≤ SEARCH_HIT_CAP）。 */
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  /** 当前命中在 searchHits 中的下标；-1 = 尚未定位。 */
  const [searchIndex, setSearchIndex] = useState(-1);
  /** 本次扫描是否已到范围末尾（false = 触发封顶，后面还有命中）。 */
  const [searchComplete, setSearchComplete] = useState(true);
  const [searchBusy, setSearchBusy] = useState(false);
  /** 搜索范围总行数（过滤态 = 命中行数；否则 = 文件总行数）。 */
  const [searchScopeTotal, setSearchScopeTotal] = useState(0);
  /** 搜索无结果提示（区别于「尚未搜索」）。 */
  const [searchEmpty, setSearchEmpty] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchReqIdRef = useRef(0);
  /** 当前停留的命中（行号 + 行内偏移），供正文里「加重高亮」用；null = 无。 */
  const currentHit = searchIndex >= 0 ? searchHits[searchIndex] ?? null : null;
  /** 当前搜索匹配器（供行渲染高亮用）。用**已提交**的查询，打字途中不改高亮。 */
  const searchMatcher = useMemo<SearchMatcher | null>(
    () => (searchQuery ? {
      term: searchQuery,
      caseSensitive: searchOptionsAtRun.cs,
      wholeWord: searchOptionsAtRun.ww,
    } : null),
    [searchQuery, searchOptionsAtRun]
  );
  /** 输入框与已提交查询不一致 => 需要按回车才生效。 */
  const searchDirty =
    searchInput !== searchQuery ||
    searchCaseSensitive !== searchOptionsAtRun.cs ||
    searchWholeWord !== searchOptionsAtRun.ww;
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
  // 同一帧内的多次跳转只落地最后一个目标（供搜索连跳用）。
  // 中间目标没人看得见，却要各自付一次「重渲染 + 行高重测 + 拉块」的代价；
  // 合并后按住回车最多按帧率推进，不会随按键重复率线性变慢。
  const jumpCoalesceRef = useRef<number | null>(null);
  const jumpTo = useCallback((target: number) => {
    if (jumpCoalesceRef.current != null) {
      window.cancelAnimationFrame(jumpCoalesceRef.current);
    }
    jumpCoalesceRef.current = window.requestAnimationFrame(() => {
      jumpCoalesceRef.current = null;
      setJumpRequest({ target });
    });
  }, []);
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
  // 跳转重居中的取消令牌与定时器：连跳时新跳转作废旧链，避免定时器链叠加。
  const recenterTokenRef = useRef(0);
  const recenterTimerRef = useRef<number | null>(null);

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
  /** 落点高亮的删除定时器（单例；连跳时复用，避免定时器堆积）。 */
  const flashTimerRef = useRef<number | null>(null);
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
      // 暂停跟随时丢弃实时批次 —— 但**只丢实时批次**。
      // 「整体替换」里有一类是用户刚做的动作（打开文件、换编码），被暂停开关吞掉的话
      // 正文会永远停在旧结果上且不会自愈（那个事件不会再发第二次）。
      // 哪些批次属于这一类由后端在 `apply_when_paused` 里说清楚，见 LinesPayload。
      if (!autoRefreshRef.current && !event.payload.apply_when_paused) {
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
  /**
   * 高亮落点行约 1s（行渲染后自动套用 .highlight，移除时经 CSS 过渡淡出）。
   *
   * 只保留**最近一次**高亮并复用同一个删除定时器：
   * 搜索连跳时每次跳转都会调用它，若每次各自 add + 各起一个 1s 定时器，
   * 按住回车会在 1 秒后集中触发几十次 Set 重建（每次 O(n) 克隆 + 一次全视图重渲染），
   * 形成明显的帧尖峰。视觉上同一时刻也只需要一个落点高亮。
   */
  const flashLine = useCallback((offset: number | null | undefined) => {
    if (offset == null) {
      return;
    }
    if (flashTimerRef.current != null) {
      window.clearTimeout(flashTimerRef.current);
    }
    setHighlightOffsets(new Set([offset]));
    flashTimerRef.current = window.setTimeout(() => {
      flashTimerRef.current = null;
      setHighlightOffsets((prev) => (prev.size === 0 ? prev : new Set()));
    }, 1000);
  }, []);

  // 未过滤（稀疏）模式下跳转后拉块的防抖定时器：连续连跳期间不逐次拉块，等停下来再拉。
  const jumpBlockFetchRef = useRef<number | null>(null);

  // 跳转定位：在 lines 替换**提交之后**执行（effect 时机保证新视图已在 DOM）。
  // scrollToIndex 的 reconcile 只追「首次计算」的固定偏移，不会按 index 重算；
  // 而视口上方行的首测补偿会持续微调 scrollTop。因此这里做收敛式重居中：
  // 每次按当前实测位置重算居中偏移，偏差 >2px 则重写，居中即停（最多 6 次）。
  // 用户滚动保护：程序写入后 120ms 内的 scroll 事件视为回读；其余视为用户
  // 滚动，之后 500ms 内不再干预。
  //
  // 性能要点（按住回车连续跳转时会暴露）：
  //   1) 写入偏移（applyVirtualTopRef）会经 setScrollOffsetUi 触发一次整视图重渲染，
  //      所以这条重试链**必须可取消**，否则每次跳转都留下自己的定时器链，
  //      几十次连跳会让「重渲染 + 行高重测」互相叠加，表现为明显卡顿。
  //   2) 同一帧内的多次连跳只落地最后一个目标（中间目标没人看得见，却要付全程代价）。
  //   3) 稀疏模式下目标块的拉取也一起防抖，避免连跳时反复抢占 4 个并发位。
  useEffect(() => {
    if (!jumpRequest) {
      return;
    }
    const { target } = jumpRequest;
    const listCount = filterActiveRef.current ? lines.length : (totalLines ?? 0);
    if (target >= 0 && target < listCount) {
      const token = ++recenterTokenRef.current;
      const stillCurrent = () => recenterTokenRef.current === token;
      const attemptRecenter = (left: number) => {
        if (!stillCurrent()) {
          return; // 已被更新的跳转作废
        }
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
        recenterTimerRef.current = window.setTimeout(() => attemptRecenter(left - 1), 250);
      };
      lastProgrammaticWriteRef.current = Date.now();
      virtualizer.scrollToIndex(target, { align: "center" });
      recenterTimerRef.current = window.setTimeout(() => attemptRecenter(6), 250);
      // 高亮落点行 1s（行渲染后自动套用 .highlight，移除时经 CSS 过渡淡出）。
      const targetLine = filterActiveRef.current
        ? lines[target]
        : segLineAt(segmentsRef.current, target);
      flashLine(targetLine?.file_offset);
      // 稀疏：目标所在块优先拉（命中要看得见，不能等防抖），
      // 视口范围的补块与淘汰扫描则防抖到停止连跳之后，避免反复抢并发位。
      if (!filterActiveRef.current) {
        const targetBlock = Math.floor(target / SPARSE_BLOCK_LINES);
        if (
          !inflightRef.current.has(targetBlock) &&
          !blockComplete(segmentsRef.current, targetBlock, totalLines ?? 0)
        ) {
          void fetchBlock(targetBlock);
        }
        if (jumpBlockFetchRef.current != null) {
          window.clearTimeout(jumpBlockFetchRef.current);
        }
        jumpBlockFetchRef.current = window.setTimeout(() => {
          jumpBlockFetchRef.current = null;
          ensureVisibleBlocks();
        }, 150);
      }
    }
    setJumpRequest(null);
    // 清理：新跳转到来时作废旧链、取消在途定时器（防抖的拉块除外，它按 120ms 自行收敛）。
    return () => {
      recenterTokenRef.current += 1;
      if (recenterTimerRef.current != null) {
        window.clearTimeout(recenterTimerRef.current);
        recenterTimerRef.current = null;
      }
    };
  }, [jumpRequest, lines, virtualizer, flashLine, totalLines, ensureVisibleBlocks]);

  // 卸载时清掉可能残留的定时器。
  useEffect(() => () => {
    if (recenterTimerRef.current != null) {
      window.clearTimeout(recenterTimerRef.current);
    }
    if (jumpBlockFetchRef.current != null) {
      window.clearTimeout(jumpBlockFetchRef.current);
    }
    if (flashTimerRef.current != null) {
      window.clearTimeout(flashTimerRef.current);
    }
    if (jumpCoalesceRef.current != null) {
      window.cancelAnimationFrame(jumpCoalesceRef.current);
    }
  }, []);

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

  // thumb 顶部位置 = 像素空间映射：thumb 顶部 = 已滚偏移 / 最大偏移 × 行程，
  // 与原生滚动条语义一致，保证滚到底时 thumb 底边与轨道底边重合。
  // 早期用「行空间映射」（thumb 比例 = 视口首行行号 /（总行数−1））规避行高
  // 估算误差，但视口首行永远不是末行：短日志（内容不足数屏，如 <50 行）滚到底
  // 时 thumb 停在中途，轨道下方留出一段死区（占轨道 20%+，内容越少占比越大），
  // 该区间的滚动已被 clamp 到最大偏移，表现为「滚动条下方有一段空间无法滚动」。
  // thumbH 参数：渲染路径必须传入本次渲染要应用的高度（thumbHUi）——若读 DOM
  // offsetHeight 只能拿到上一次提交的旧高度，高度变化时顶部按旧高计算、底部
  // 按新高落地，thumb 底边会伸出轨道下缘（resize 时实测伸出 4~459px）。
  const computeThumbTop = (v: number, thumbH?: number): number => {
    const track = trackRef.current;
    const thumb = thumbRef.current;
    const el = listRef.current;
    if (!track || !thumb || !el) {
      return 0;
    }
    const h = thumbH ?? thumb.offsetHeight;
    const travel = Math.max(1, track.clientHeight - h);
    const maxScroll = Math.max(0, virtualizer.getTotalSize() - el.clientHeight);
    if (maxScroll <= 0) {
      return 0;
    }
    return Math.round(Math.min(1, v / maxScroll) * travel);
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

  // ---- 自绘垂直滚动条（thumb 比例 ⇔ 像素滚动比例，拖动幅度 = 实际进度） ----
  const totalSizeUi = virtualizer.getTotalSize();
  const clientHUi = listRef.current?.clientHeight ?? 0;
  const maxScrollUi = Math.max(0, totalSizeUi - clientHUi);
  const thumbHUi =
    maxScrollUi > 0
      ? Math.max(24, Math.round(clientHUi * (clientHUi / Math.max(totalSizeUi, 1))))
      : 0;
  // 传入本次渲染要应用的 thumbHUi：顶部与高度同源，thumb 底边不会伸出轨道。
  const thumbTopUi = computeThumbTop(scrollOffsetUi, thumbHUi);

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
      // thumb 比例 f → 虚拟偏移（像素空间反变换，与 computeThumbTop 精确互逆）。
      const fToOffset = (f: number): number => {
        const clamped = Math.max(0, Math.min(1, f));
        return clamped * maxScroll;
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
      // 拖 thumb：thumb 中心跟随鼠标，内容按像素比例联动。
      const onMove = (ev: PointerEvent) => {
        if (!onThumb) {
          return;
        }
        const f = Math.max(0, Math.min(1, (ev.clientY - trackTop - thumbH / 2) / travel));
        applyVirtualTopRef.current(fToOffset(f), "user");
        // thumb 直接按鼠标位置定位（正反映射互逆，亚像素误差不反馈到手上）。
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
        // 点轨道：把 thumb 中心定位到点击处（按像素比例绝对跳转）。
        const clickY = e.clientY - trackTop;
        const f = Math.max(0, Math.min(1, (clickY - thumbH / 2) / travel));
        applyVirtualTopRef.current(fToOffset(f), "user");
      }
    },
    [virtualizer]
  );

  const toggleWrapLines = useCallback((next: boolean) => {
    // 先同步清空行高缓存，再切换 CSS：
    // setWrapLines 触发 DOM 变化后，ResizeObserver 会用真实高度重新填充缓存。
    // 若反过来（先切换、rAF 里再 measure），measure 会晚于 ResizeObserver 回调，
    // 把刚测好的真实高度清掉且无新 resize 触发重测，行停留在估算值上 → 重叠。
    virtualizer.measure();
    setWrapLines(next);
  }, [virtualizer]);

  /** 切换自动刷新：恢复过滤时按「当前模式 + 当前输入」重建过滤条件。 */
  const toggleAutoRefresh = useCallback(
    async (next: boolean) => {
      setAutoRefresh(next);
      // 仅旧窗口模型（过滤态）需要恢复过滤；稀疏模型的事件本就全量。
      if (next && filterActiveRef.current) {
        try {
          const { keywords, regex } = buildFilterPayload(filterMode, filterInput);
          await invoke("set_filter", { tabId, keywords, regex, caseSensitive });
        } catch {
          /* 静默失败 */
        }
      }
    },
    [tabId, caseSensitive, filterMode, filterInput]
  );

  const applyFilter = useCallback(
    async (caseOverride?: boolean, use?: { mode: FilterMode; rawInput: string }) => {
      // 模式与输入由调用方显式给出（或取本次渲染的闭包值），不读可变 ref：
      // 否则「切换模式」这类在同一事件里既改状态又立刻重扫的路径，
      // 会读到尚未同步的旧值，把上一个模式的输入当成新模式的条件用。
      const md = use ? use.mode : filterMode;
      const raw = use ? use.rawInput : filterInput;
      const { keywords, regex } = buildFilterPayload(md, raw);
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
    [tabId, caseSensitive, lines, virtualizer, filterMode, filterInput]
  );

  /**
   * 切换过滤模式（关键词 ⇄ 正则）：二者互斥，共用同一个输入位。
   * 每种模式的输入各自保留（切回来原样恢复）；只要过滤已生效就立即按新模式重扫，
   * 新模式的输入为空时即等于清空过滤、回到稀疏模型。
   */
  const toggleFilterMode = useCallback(() => {
    const next: FilterMode = filterModeRef.current === "keyword" ? "regex" : "keyword";
    // 新模式对应的草稿（各自独立保存，切回来原样恢复）。
    const nextRaw =
      next === "keyword" ? filterKeywordInputRef.current : filterRegexInputRef.current;
    filterModeRef.current = next; // 让同一事件内的后续读取也看到新值
    setFilterMode(next);
    if (filterActiveRef.current) {
      // 显式把新模式的输入交给 applyFilter —— 本事件内状态还没提交，不能靠读状态。
      void applyFilter(undefined, { mode: next, rawInput: nextRaw });
    }
  }, [applyFilter]);

  /** 关键词大小写开关（仅关键词模式生效，正则要区分大小写请写内联 (?i)）：
   *  过滤已生效时立即用新设置重扫；未生效时仅记录偏好，下次点击「过滤」时生效。 */
  const toggleCaseSensitive = useCallback(() => {
    const next = !caseSensitive;
    setCaseSensitive(next);
    // 正则模式不受大小写开关影响，无需重扫。
    if (filterActiveRef.current && filterModeRef.current === "keyword") {
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

  // ==================== 正文内搜索 ====================
  //
  // 与过滤的关系（需求约定）：
  //   - 过滤生效 => 搜索范围是**过滤后的行**（后端扫过滤结果集，scope_total = 命中行数）
  //   - 未过滤   => 搜索范围是**整个文件**（后端从起点流式扫描，不整份载入内存）
  // 前向搜索、不做全局计数：一次调用返回「从起点向后扫出的命中窗口」（封顶 10 万），
  // 因此 UI 显示的是「当前位置 / 本次已扫出数」，不是全局总数。

  /** 命中数显示文本：当前位置 / 已扫出数，并标注是否已扫完该范围。 */
  const searchCountText = (): string => {
    // 打字改了查询但还没回车：结果仍是上一次的，明确提示「尚未生效」。
    if (searchDirty) {
      return searchBusy ? t.searchScanning : t.searchDirtyHint;
    }
    if (!searchQuery) {
      return "";
    }
    if (searchBusy) {
      return t.searchScanning;
    }
    if (searchHits.length === 0) {
      return searchEmpty ? t.searchNoResults : "";
    }
    const capped = !searchComplete || searchHits.length >= SEARCH_HIT_CAP;
    return `${searchIndex + 1}/${searchHits.length}${capped ? "+" : ""}`;
  };

  /** 悬浮框的范围提示：说明这次搜索作用于哪一层（过滤后 / 整个文件）。 */
  const searchScopeText = (): string => {
    if (!searchScopeTotal) {
      return "";
    }
    return filterActive
      ? t.searchScopeFiltered(searchScopeTotal)
      : t.searchScopeFile(searchScopeTotal);
  };

  /**
   * 由命中行号算出虚拟列表的显示 index。
   * 过滤态下 lines 是稠密的「过滤后命中行」，其 file_line 并不等于下标，
   * 需要查表；非过滤态下显示 index 就是 file_line - 1（滚动条映射全文件）。
   */
  const displayIndexOfHit = useCallback(
    (hit: SearchHit): number => {
      if (!filterActiveRef.current) {
        return Math.max(0, hit.file_line - 1);
      }
      const at = lines.findIndex((l) => l.file_line === hit.file_line);
      return at;
    },
    [lines]
  );

  /** 滚动到指定命中并闪光标记；同时把它设为「当前命中」以加重高亮。 */
  const goToHit = useCallback(
    (hit: SearchHit, index: number) => {
      setSearchIndex(index);
      const target = displayIndexOfHit(hit);
      if (target < 0) {
        return; // 目标不在当前视图（过滤条件刚变过），等下一次扫描
      }
      setFollowTail(false);
      // 走合并入口：按住回车连跳时，同一帧内只有最后一个目标会真正落地。
      jumpTo(target);
    },
    [displayIndexOfHit, jumpTo]
  );

  /**
   * 前向搜索：从 `fromLine`（1-based，含）向后扫，结果替换命中窗口。
   * 注意不做防抖：回车/切换开关是离散操作；输入框实时触发由调用方决定何时调用。
   */
  const runSearch = useCallback(
    async (fromLine: number, opts?: { keepIndex?: number }) => {
      const query = searchQuery;
      if (!query) {
        setSearchHits([]);
        setSearchIndex(-1);
        setSearchEmpty(false);
        setSearchComplete(true);
        setSearchScopeTotal(filterActiveRef.current ? lines.length : (totalLines ?? 0));
        return;
      }
      const reqId = ++searchReqIdRef.current;
      setSearchBusy(true);
      try {
        const page = await invoke<SearchPage>("search_lines", {
          tabId,
          query,
          kind: searchWholeWord ? "wholeword" : "substring",
          caseSensitive: searchCaseSensitive,
          fromFileLine: fromLine,
        });
        if (reqId !== searchReqIdRef.current) {
          return; // 有更新的搜索请求，丢弃这次结果
        }
        setSearchHits(page.hits);
        setSearchComplete(page.complete);
        setSearchScopeTotal(page.scope_total);
        setSearchEmpty(page.hits.length === 0);
        if (page.hits.length === 0) {
          setSearchIndex(-1);
          return;
        }
        // 命中窗口刷新后，当前下标回到第一处（keepIndex 用于保留既有位置）。
        const idx = opts?.keepIndex != null && opts.keepIndex < page.hits.length ? opts.keepIndex : 0;
        setSearchIndex(idx);
        goToHit(page.hits[idx], idx);
      } catch {
        if (reqId === searchReqIdRef.current) {
          setSearchHits([]);
          setSearchIndex(-1);
          setSearchEmpty(true);
          setSearchComplete(true);
        }
      } finally {
        if (reqId === searchReqIdRef.current) {
          setSearchBusy(false);
        }
      }
    },
    [tabId, searchQuery, searchCaseSensitive, searchWholeWord, lines.length, totalLines, goToHit]
  );

  /** 当前视口顶部对应的文件行号（1-based）——用户点「下一个」时的前向起点。 */
  const viewportFirstFileLine = useCallback((): number => {
    const items = virtualizer.getVirtualItems();
    const first = items.length > 0 ? items[0].index : 0;
    if (filterActiveRef.current) {
      return lines[first]?.file_line ?? 1;
    }
    return first + 1;
  }, [virtualizer, lines]);

  /** 回车 / 点「下一个」：在当前命中窗口内前进；到窗口末尾且未扫完就续扫下一段。 */
  const searchNext = useCallback(async () => {
    if (!searchQuery) {
      return;
    }
    if (searchIndex + 1 < searchHits.length) {
      goToHit(searchHits[searchIndex + 1], searchIndex + 1);
      return;
    }
    // 窗口已到末尾：已扫完 => 回绕到第一个；未扫完（封顶）=> 从最后一条之后续扫。
    if (searchComplete) {
      if (searchHits.length > 0) {
        goToHit(searchHits[0], 0);
      }
      return;
    }
    const last = searchHits[searchHits.length - 1];
    if (last) {
      await runSearch(last.file_line + 1);
    }
  }, [searchQuery, searchIndex, searchHits, searchComplete, goToHit, runSearch]);

  /** Shift+回车 / 点「上一个」：窗口内后退；到窗口开头就回绕到末尾。 */
  const searchPrev = useCallback(() => {
    if (!searchQuery || searchHits.length === 0) {
      return;
    }
    const next = searchIndex - 1;
    if (next >= 0) {
      goToHit(searchHits[next], next);
    } else {
      const lastIdx = searchHits.length - 1;
      goToHit(searchHits[lastIdx], lastIdx);
    }
  }, [searchQuery, searchHits, searchIndex, goToHit]);

  /** 打开搜索框（Ctrl+F / 工具栏按钮）：聚焦并全选已有查询。 */
  const openSearch = useCallback(() => {
    setSearchOpen(true);
    window.setTimeout(() => searchInputRef.current?.select(), 0);
  }, []);

  /** 关闭搜索框：清空查询与命中，正文恢复无搜索高亮。 */
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchInput("");
    setSearchQuery("");
    setSearchHits([]);
    setSearchIndex(-1);
    setSearchEmpty(false);
    setSearchComplete(true);
  }, []);

  /** 回车提交并搜索；Shift+回车在已提交的命中之间后退。 */
  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        // 后退不重新扫描：直接用上一次的命中窗口（没有则先跑一次）。
        if (searchQuery) {
          searchPrev();
        } else {
          runSearchAt(searchInput, searchCaseSensitive, searchWholeWord);
        }
      } else {
        runSearchAt(searchInput, searchCaseSensitive, searchWholeWord);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSearch();
    }
  };

  /**
   * 一次搜索的扫描起点。
   * 过滤态下命中集通常不大，从文件头扫才能让「上一条/下一条」在两个方向上都有内容；
   * 未过滤态面对整个文件，从当前视口往后扫，符合「从眼下位置往后找」的直觉。
   */
  const searchStartLine = useCallback((): number => {
    return filterActiveRef.current ? 1 : viewportFirstFileLine();
  }, [viewportFirstFileLine]);

  /**
   * 提交并搜索：把输入框内容与当前开关「提交」为生效查询。
   *
   * 搜索**只在回车（或点「下一个/上一个」、切换开关）时触发**，输入框打字不搜 ——
   * 大文件上每次击键都全文件扫描代价太高，且打字途中反复跳转会打乱视线。
   * 因此输入框文本与生效查询分离：打字只改 searchInput，不影响结果与高亮。
   * 若提交的内容与上次完全一致，则退化为「跳到下一个」，让回车既能开始搜索也能连续跳转。
   */
  const runSearchAt = useCallback(
    (rawInput: string, cs: boolean, ww: boolean) => {
      const sameAsCommitted =
        rawInput === searchQuery && cs === searchOptionsAtRun.cs && ww === searchOptionsAtRun.ww;
      // 逐项比较后再写：字面量对象每次都是新引用，直接 set 会让 React 认为「变了」，
      // 于是每次回车都白跑一次重渲染（并让 searchMatcher / 全部可见行的高亮重算）。
      setSearchQuery((prev) => (prev === rawInput ? prev : rawInput));
      setSearchOptionsAtRun((prev) =>
        prev.cs === cs && prev.ww === ww ? prev : { cs, ww }
      );
      if (!rawInput) {
        // 输入被清空：直接清结果，不必再往后端问一趟。
        setSearchHits([]);
        setSearchIndex(-1);
        setSearchEmpty(false);
        setSearchComplete(true);
        return;
      }
      if (sameAsCommitted) {
        void searchNext();
        return;
      }
      setSearchEpoch((n) => n + 1); // 真正的新查询：交给 effect 发起扫描
    },
    [searchQuery, searchOptionsAtRun, searchNext]
  );

  /**
   * 回车提交后执行搜索（由 searchEpoch 驱动）。
   * 用 epoch 而不是监听 searchQuery：这样「过滤状态变化触发的重扫」可以走自己的路径，
   * 不会因为查询文本没变而漏掉或重复跑。
   */
  const searchEpochRef = useRef(0);
  useEffect(() => {
    if (searchEpoch === searchEpochRef.current) {
      return; // 不是一次新的提交
    }
    searchEpochRef.current = searchEpoch;
    if (!searchOpen || !searchQuery) {
      return;
    }
    void runSearch(searchStartLine());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchEpoch]);

  /** Ctrl+F 打开搜索框（Ctrl+F 未被其他快捷键占用）。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        openSearch();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openSearch]);

  /**
   * 过滤状态变化后按新范围重搜：过滤生效时范围变成「过滤后的行」，
   * 关闭过滤时回到整个文件 —— 这就是「兼容 filter 前后」的落点。
   * 这是「环境变了」而非「用户打字」，所以直接重扫，不需要再按回车。
   */
  const prevFilterActiveRef = useRef(filterActiveRef.current);
  useEffect(() => {
    if (prevFilterActiveRef.current === filterActive) {
      return;
    }
    prevFilterActiveRef.current = filterActive;
    if (searchQuery) {
      // 过滤刚生效时 lines 才刚被替换，起点统一用 1（范围已限定在过滤结果内，代价可控）。
      void runSearch(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterActive]);

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

  // 激活时向 App 注册「复制当前视图」与文件总行数（失活 / 卸载时自动注销）。
  // 公共生命周期统一走框架 hook：注销分支只写一遍，所有页面语义一致。
  useBodyViewEffects(props, { copy: copyViewText, total: totalLines });

  return (
    <div className="tab-content">
      <div className="toolbar">
        <button
          className={`icon-btn toolbar-icon view-toggle${viewMode !== "text" ? " on" : ""}`}
          onClick={onSwitchViewMode}
          aria-pressed={viewMode !== "text"}
          title={t.viewModeButtonTitle}
        >
          {viewMode !== "text" ? (
            /* 当前不是文本视图（表格 / Markdown）：图标表示「切回文本」，多行文字 */
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
              <path d="M2.5 3.5h11M2.5 8h11M2.5 12.5h6" stroke="currentColor" strokeWidth="1.55" />
            </svg>
          ) : (
            /* 当前是文本视图：图标表示「还有别的视图」，网格 */
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
              <rect x="1.9" y="2.9" width="12.2" height="10.2" rx="1" stroke="currentColor" strokeWidth="1.45" />
              <path d="M1.9 6.3h12.2M1.9 9.7h12.2M6.1 2.9v10.2M9.9 2.9v10.2" stroke="currentColor" strokeWidth="1.45" />
            </svg>
          )}
        </button>
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
        <button onClick={openSearch} title={t.searchTitle}>
          {t.search}
        </button>
      </div>

      <div className="filterbar">
        <button
          className="mode-btn"
          onClick={toggleFilterMode}
          title={t.filterModeSwitchTitle}
          aria-label={t.filterModeSwitchTitle}
        >
          {filterMode === "keyword" ? t.filterModeKeyword : t.filterModeRegex}
        </button>
        <input
          className={`filter-input ${filterMode}`}
          value={filterInput}
          onChange={(e) => {
            // 只写当前模式的草稿，切换模式时另一份输入保持原值。
            const { value } = e.currentTarget;
            if (filterMode === "keyword") {
              setFilterKeywordInput(value);
            } else {
              setFilterRegexInput(value);
            }
          }}
          onKeyDown={onKeyDown}
          placeholder={filterMode === "keyword" ? t.keywordPlaceholder : t.regexPlaceholder}
        />
        {filterMode === "keyword" && (
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
        )}
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
        {searchOpen && (
          <div className="find-widget" role="search">
            <input
              ref={searchInputRef}
              className="find-input"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder={t.searchPlaceholder}
              aria-label={t.searchTitle}
            />
            <button
              className={`find-toggle${searchCaseSensitive ? " on" : ""}`}
              onClick={() => setSearchCaseSensitive((v) => !v)}
              title={t.searchCaseTitle}
              aria-pressed={searchCaseSensitive}
            >
              Aa
            </button>
            <button
              className={`find-toggle${searchWholeWord ? " on" : ""}`}
              onClick={() => setSearchWholeWord((v) => !v)}
              title={t.searchWholeWordTitle}
              aria-pressed={searchWholeWord}
            >
              ab|
            </button>
            <button
              className={`find-go${searchDirty ? " dirty" : ""}`}
              onClick={() => runSearchAt(searchInput, searchCaseSensitive, searchWholeWord)}
              title={t.searchGoTitle}
            >
              {t.searchGo}
            </button>
            <span className="find-range" title={
              (filterActive ? t.searchFilteredScope : t.searchFileScope)
              + (searchComplete ? "" : " · " + t.searchCappedHint)
            }>
              {searchScopeText()}
            </span>
            <span className="find-count">
              {searchCountText()}
            </span>
            <button
              className="find-nav"
              onClick={() => searchPrev()}
              disabled={searchHits.length === 0}
              title={t.searchPrevTitle}
              aria-label={t.searchPrevTitle}
            >
              ↑
            </button>
            <button
              className="find-nav"
              onClick={() => void searchNext()}
              disabled={searchHits.length === 0}
              title={t.searchNextTitle}
              aria-label={t.searchNextTitle}
            >
              ↓
            </button>
            <button
              className="find-close"
              onClick={closeSearch}
              title={t.searchCloseTitle}
              aria-label={t.searchCloseTitle}
            >
              ✕
            </button>
          </div>
        )}
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
            // 当前命中的加重标记只作用于它所在的那一行（其余命中由搜索匹配器统一标黄）。
            const curOffset =
              currentHit && currentHit.file_line === line.file_line ? currentHit.offset : null;
            const textParts = searchMatcher
              ? splitWithSearchAndKeywords(displayText, searchMatcher, curOffset, highlightMatcher)
              : highlightMatcher
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
                    ) : "find" in part ? (
                      <mark
                        key={i}
                        className={`find-mark${part.isCurrent ? " current" : ""}`}
                      >
                        {part.find}
                      </mark>
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

// ==================== 正文页面注册表（多类页面框架） ====================
//
// 「一个 tab 的正文显示什么」只在两处定义：规则（id / 优先级 / 命中）在
// src/views/app-body-views.ts，渲染实现在下面的 APP_BODY_VIEW_RENDERERS。
// 新增页面 = 写一个组件 + 这两处各加一条，App 的渲染树不用改（步骤见
// docs/body-views.md）。

/** 页面命中判定与渲染所需的 App 侧上下文（当前渲染的快照，每次渲染重建）。 */
interface AppBodyViewCtx {
  /** 目标 tab。 */
  tab: TabInfo;
  /** `tab.openError` 的分类结果（`kind === "none"` = 正常）。 */
  error: OpenErrorInfo;
  /** 表格视图数据（表格页用；null = 尚未解析成功）。 */
  cfg: ClientCfgTable | null;
  /** 表格视图重新选择 schema 文件。 */
  pickSchema: (tabId: string, path: string) => void;
  /** Markdown 全文（Markdown 页用；null = 尚未读到）。 */
  md: MdDoc | null;
  /** 重新读取（文件被外部编辑后手动刷新）。 */
  reloadMd: (tabId: string, path: string) => void;
  /** 重新读取，但仅在内容确实变化时替换正文；返回是否变化（「跟随」轮询用）。 */
  reloadMdIfChanged: (tabId: string, path: string) => Promise<boolean>;
  /** 打开另一个文档（Markdown 页里的相对链接走这里，复用 App 的开文件规则）。 */
  openDoc: (path: string, anchor?: string) => void;
  /** 该 tab 打开时待跳转的锚点（`other.md#sec` 带过来的），已消费则为 null。 */
  anchor: string | null;
  /** 锚点已消费：写回 undefined，避免重渲染时重复跳转。 */
  consumeAnchor: () => void;
  /** 查询文件 mtime/大小（Markdown 页的自动刷新轮询用）。 */
  statFile: (path: string) => Promise<{ mtimeMs: number; size: number }>;
}

/** 本地路径 → asset 协议 URL（Markdown 页里的图片）。 */
function toAssetUrl(path: string): string {
  return convertFileSrc(path);
}

/** 在资源管理器中定位本地文件（Markdown 页里的图片占位与非文档链接）。 */
function revealPath(path: string): void {
  void revealItemInDir(path).catch((e) => {
    console.error("revealItemInDir failed:", path, e);
  });
}

/** 用系统默认浏览器打开外部链接：Tauri 的 WebView 若自己导航，应用页面会被顶掉。 */
function openExternal(url: string): void {
  void openUrl(url).catch((e) => {
    console.error("openUrl failed:", url, e);
  });
}

/**
 * 各页面的渲染实现（与 {@link APP_BODY_VIEWS} 的 id 一一对应）。
 *
 * 页面选择规则（优先级 + 命中）在 `src/views/app-body-views.ts` 里，是纯数据、可单测；
 * 这里只回答「选中的页面怎么渲染」—— 页面专属属性在各自的 render 里组装。
 */
const APP_BODY_VIEW_RENDERERS: Record<
  AppBodyViewId,
  (base: BodyViewProps, ctx: AppBodyViewCtx) => React.ReactNode
> = {
  "file-missing": (base) => <FileMissingView {...base} />,
  "md-view": (base, ctx) => (
    // 懒加载页面必须自带兜底：chunk 还在下载时正文区不能是一片空白。
    <Suspense fallback={<div className="md-notice">loading…</div>}>
      <LazyMarkdownView
        tabId={base.tabId}
        path={base.path}
        active={base.active}
        fontSize={base.fontSize}
        lang={base.lang}
        doc={ctx.md}
        error={ctx.tab.openError}
        onSwitchViewMode={base.onSwitchViewMode}
        registerCopy={base.registerCopy}
        reportTotal={base.reportTotal}
        onReload={() => ctx.reloadMd(ctx.tab.id, ctx.tab.path)}
        // 自动刷新走「变了才换正文」的那条：内容逐字未变（编辑器空保存）时不重排版，
        // 返回值告诉页面该闪「已刷新」还是「无变化」。手动「重新读取」仍走 onReload。
        onReloadIfChanged={() => ctx.reloadMdIfChanged(ctx.tab.id, ctx.tab.path)}
        // 相对链接指向的 Markdown：复用 App 的 openPath（同路径不重复开 tab、
        // 失效路径会落到「文件不存在」状态页），不在页面里自己开 tab。
        onOpenDoc={ctx.openDoc}
        // 本地文件（图片 / 非 Markdown 链接）：在资源管理器中定位。
        // 刻意不用 opener 的 openPath（会交给系统默认程序执行）：那需要额外申请
        // `opener:allow-open-path` 权限，且「点一下文档里的链接就启动本机程序」
        // 是文档视图不该有的能力。
        onOpenLocal={revealPath}
        onOpenUrl={openExternal}
        // 图片走 Tauri 的 asset 协议（后端在读取文档时动态授权了该文档所在目录）
        toAssetUrl={toAssetUrl}
        statFile={ctx.statFile}
        initialAnchor={ctx.anchor}
        onAnchorConsumed={ctx.consumeAnchor}
      />
    </Suspense>
  ),
  "cfg-table": (base, ctx) => (
    <CfgTableTab
      tabId={base.tabId}
      path={base.path}
      data={ctx.cfg}
      error={ctx.tab.openError}
      active={base.active}
      fontSize={base.fontSize}
      uiLang={base.lang}
      onPickSchema={() => ctx.pickSchema(ctx.tab.id, ctx.tab.path)}
      onSwitchViewMode={base.onSwitchViewMode}
      registerCopy={base.registerCopy}
      reportTotal={base.reportTotal}
    />
  ),
  "open-error": (base, ctx) => (
    <OpenErrorView {...base} kind={ctx.error.kind} error={ctx.tab.openError} />
  ),
  "text-log": (base, ctx) => (
    <LogTab {...base} openError={ctx.tab.openError} viewMode={ctx.tab.viewMode ?? "text"} />
  ),
};

/** 页面标题（aria-label / 调试用）。 */
const APP_BODY_VIEW_TITLES: Record<AppBodyViewId, (lang: ViewLang) => string> = {
  "file-missing": (lang) => (lang === "zh" ? "文件不存在" : "File not found"),
  "md-view": (lang) => (lang === "zh" ? "Markdown 预览" : "Markdown preview"),
  "cfg-table": (lang) => (lang === "zh" ? "配置表视图" : "Table view"),
  "open-error": (lang) => (lang === "zh" ? "无法打开" : "Cannot open"),
  "text-log": (lang) => (lang === "zh" ? "文本视图" : "Text view"),
};

/**
 * 正文页面注册表：规则来自 {@link APP_BODY_VIEWS}（纯数据），渲染来自上面的实现表。
 * 「一个 tab 的正文显示什么」只有一个事实来源，App 的渲染树不再出现视图分支。
 */
const bodyViews = new BodyViewRegistry<AppBodyViewCtx>(
  APP_BODY_VIEWS.map((spec) => ({
    id: spec.id,
    priority: spec.priority,
    fallback: spec.fallback,
    title: APP_BODY_VIEW_TITLES[spec.id],
    match: (ctx) => spec.match({ viewMode: ctx.tab.viewMode, error: ctx.error }),
    render: (base, ctx) => APP_BODY_VIEW_RENDERERS[spec.id](base, ctx),
  }))
);

export default function App() {
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  // 文件拖拽进行中：显示全屏放置提示遮罩。
  const [dragActive, setDragActive] = useState(false);

  // ---- 编码（底部状态栏 + 编码弹窗） ----
  //
  // 两份状态，职责不同：
  // - `TabInfo.encoding` 是用户的**选择**（`auto` 或目录 id），随会话存档持久化，
  //   重新打开文件时照它去解析（`auto` 要重新探测，见 TabInfo 的注释）；
  // - `encodings` 是后端**解析出来的结果**（`UTF-8` / `GB18030 BOM`…），只用于显示。
  //
  /** 每个 tab 解析出的编码信息（键为 tabId；null = 尚未探测出/不适用）。 */
  const [encodings, setEncodings] = useState<Record<string, EncodingInfo | null>>({});
  /** 编码弹窗是否展开（目标是当前激活 tab）。 */
  const [encodingOpen, setEncodingOpen] = useState(false);
  /** 正在按新编码重载（状态栏显示提示并禁止重复点）。 */
  const [encodingBusy, setEncodingBusy] = useState(false);
  /** 切换失败的提示（显示在编码弹窗里；切换成功后清空）。 */
  const [encodingError, setEncodingError] = useState<string | null>(null);

  /**
   * 各回调读取「最新 tabs」的稳定入口。
   *
   * 声明在 App 顶部：`loadMd`（Markdown 读取）与 `openTabFile` 都要按 tabId 现取
   * tab 状态（编码选择、视图模式），而它们的引用必须稳定（是下游 effect 的依赖），
   * 不能把 `tabs` 放进依赖数组。
   */
  const tabsRef = useRef<TabInfo[]>([]);
  tabsRef.current = tabs;

  /** 指定 tab 的编码选择（没有/未指定 = `auto`）。 */
  const encodingChoiceOf = useCallback((tabId: string): string => {
    return tabsRef.current.find((t) => t.id === tabId)?.encoding || AUTO_ID;
  }, []);

  // ---- 最近打开记录（总菜单的「最近打开」二级菜单数据） ----
  const [recentPaths, setRecentPaths] = useState<string[]>(() => readRecentPaths());
  // ---- 首行最左侧的总菜单（历史记录二级菜单 / 语言 / 关于 / 退出） ----
  const [menuOpen, setMenuOpen] = useState(false);
  /** 总菜单内「最近打开」二级菜单的展开状态。 */
  const [historyOpen, setHistoryOpen] = useState(false);
  // 下拉菜单的固定定位坐标（展开时从图标矩形读取；tabbar 是滚动容器，
  // 菜单经 portal 渲染到 body 上避免被 overflow 裁剪）。
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // ---- 文件 tab 右键菜单（在文件浏览器中打开 / 复制路径） ----
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null);
  /** 复制路径成功后的瞬时反馈：菜单项文案切换为「已复制路径」。 */
  const [tabMenuCopied, setTabMenuCopied] = useState(false);
  const tabMenuRef = useRef<HTMLDivElement>(null);

  // ---- 拖动 tab 调整顺序 ----
  // pointerdown 先记「待定手势」，移动超过阈值才进入拖拽：拖影 ghost 跟随指针、
  // 源 tab 淡显、列表内显示插入指示线；drop 时 splice 重排 tabs，
  // localStorage 持久化由现有「文件记忆」effect 自动完成。
  const [tabDrag, setTabDrag] = useState<TabDragState | null>(null);
  const tabDragRef = useRef<TabDragState | null>(null);
  tabDragRef.current = tabDrag;
  const pendingDragRef = useRef<PendingTabDrag | null>(null);
  /** 本次手势是否已越过阈值进入拖拽。 */
  const dragActiveRef = useRef(false);
  /** 最近一次拖拽落点（tabId + 时间戳）：吞掉紧随其后的 click 激活。 */
  const lastTabDragEndRef = useRef<{ tabId: string; time: number } | null>(null);
  const tabbarRef = useRef<HTMLDivElement>(null);
  const tabsBoxRef = useRef<HTMLDivElement>(null);

  // ---- 「关于」模态框 ----
  const [aboutOpen, setAboutOpen] = useState(false);
  /** 应用版本（tauri.conf.json）：core:app 插件默认注册，浏览器 mock 下回退内置值。 */
  const [appVersion, setAppVersion] = useState("0.1.0");

  // ---- 设置模态框（外观 / 字体定制 / 正文字号） ----
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 关闭设置页：引用稳定，供 SettingsModal 的 Esc / 遮罩点击复用。 */
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  // ---- 视图模式选择模态框（文本 / 表格） ----
  const [viewModeOpen, setViewModeOpen] = useState(false);
  /** 未选 schema 就尝试切表格视图：模态框内显示提示。 */
  const [schemaError, setSchemaError] = useState(false);

  // ---- schema 文件记录（表格视图解析用，应用内保存多个备选） ----
  const [schemaPaths, setSchemaPaths] = useState<string[]>(() => readSchemaPaths());

  // 挂载时读取真实版本号（getVersion → plugin:app|version）。
  useEffect(() => {
    void getVersion()
      .then((v) => {
        if (typeof v === "string" && v.length > 0) {
          setAppVersion(v);
        }
      })
      .catch(() => {
        /* 后端不可用（如 dev 浏览器）时保留回退版本号 */
      });
  }, []);

  // 「关于」模态框：Esc 关闭。
  useEffect(() => {
    if (!aboutOpen) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setAboutOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [aboutOpen]);

  // 视图模式模态框：Esc 关闭；目标 tab 消失（被关闭）时同步收起。
  useEffect(() => {
    if (!viewModeOpen) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setViewModeOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [viewModeOpen]);

  useEffect(() => {
    // 目标 tab 被关闭（激活 tab 不存在）时同步收起模态框。
    if (viewModeOpen && !tabs.some((t) => t.id === activeTabId)) {
      setViewModeOpen(false);
    }
  }, [viewModeOpen, tabs, activeTabId]);

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
          schemas: tabs.map((t) => t.slotsPath ?? null),
          // 视图模式一起存：否则 Markdown 预览在重启后会掉回文本视图
          // （表格视图本来也存不住，是因为它依赖 schema 记录，见 schemas）。
          modes: tabs.map((t) => t.viewMode ?? null),
          // 只存手动指定的编码：`auto` 的 tab 存 null，下次打开重新探测
          //（文件可能已被别的工具改写成了另一种编码）。
          encodings: tabs.map((t) =>
            t.encoding && t.encoding !== AUTO_ID ? t.encoding : null
          ),
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

  // schema 文件记录持久化（仅保存路径，不做存在性检查）。
  useEffect(() => {
    try {
      localStorage.setItem(SCHEMA_KEY, JSON.stringify(schemaPaths));
    } catch {
      /* localStorage 不可用时静默 */
    }
  }, [schemaPaths]);

  // 总菜单展开时：点击菜单外任意处 / 按 Esc / 窗口尺寸变化时收起。
  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const onDown = (e: MouseEvent) => {
      const menu = menuRef.current;
      const btn = menuBtnRef.current;
      const target = e.target as Node;
      // 图标按钮自身负责 toggle（否则 mousedown 先关、click 又开，开关失灵）。
      if (btn && btn.contains(target)) {
        return;
      }
      if (menu && !menu.contains(target)) {
        setMenuOpen(false);
        setHistoryOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        setHistoryOpen(false);
      }
    };
    const onResize = () => {
      setMenuOpen(false);
      setHistoryOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [menuOpen]);

  // tab 右键菜单展开时：点击菜单外 / Esc / resize 收起。
  // 右键另一个 tab 时（mousedown 先关、contextmenu 后开）菜单会重新定位到新 tab。
  useEffect(() => {
    if (!tabMenu) {
      return;
    }
    const onDown = (e: MouseEvent) => {
      const menu = tabMenuRef.current;
      const target = e.target as Node;
      if (menu && !menu.contains(target)) {
        setTabMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setTabMenu(null);
      }
    };
    const onResize = () => setTabMenu(null);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [tabMenu]);

  // 钳位：菜单挂载后按实测尺寸修正位置，保证完整落在视口内（贴近边缘右键时）。
  useEffect(() => {
    if (!tabMenu) {
      return;
    }
    const el = tabMenuRef.current;
    if (!el) {
      return;
    }
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const x = Math.min(Math.max(tabMenu.x, margin), window.innerWidth - rect.width - margin);
    const y = Math.min(Math.max(tabMenu.y, margin), window.innerHeight - rect.height - margin);
    if (x !== tabMenu.x || y !== tabMenu.y) {
      setTabMenu({ ...tabMenu, x, y });
    }
  }, [tabMenu]);

  // 目标 tab 被关闭时同步收起菜单。
  useEffect(() => {
    if (tabMenu && !tabs.some((t) => t.id === tabMenu.tabId)) {
      setTabMenu(null);
    }
  }, [tabMenu, tabs]);

  // ---- client_cfg 表格数据（.bin tab 的解析结果，key 为 tabId） ----
  const [cfgTables, setCfgTables] = useState<Record<string, ClientCfgTable>>({});

  /**
   * 解析一个 client_cfg bin：成功存表数据，失败标记到该 tab。schema 必须手动指定。
   * 返回是否成功 —— 状态页的「重新检测」要据此决定给不给失败提示。
   */
  const parseCfg = useCallback(
    async (tabId: string, binPath: string, slotsPath: string): Promise<boolean> => {
      try {
        const table = await invoke<ClientCfgTable>("parse_client_cfg_bin", {
          path: binPath,
          slotsPath,
        });
        setCfgTables((prev) => ({ ...prev, [tabId]: table }));
        setTabs((prev) =>
          prev.map((t) => (t.id === tabId ? { ...t, openError: undefined } : t))
        );
        return true;
      } catch (e) {
        setTabs((prev) =>
          prev.map((t) => (t.id === tabId ? { ...t, openError: String(e) } : t))
        );
        return false;
      }
    },
    []
  );

  // ---- Markdown 全文（.md tab 的读取结果，key 为 tabId） ----
  //
  // 与表格视图同构：读取结果按 tabId 存在 App 里，页面只拿数据、不碰后端。
  // 文本视图走的是稀疏 tail 会话（分块取行），Markdown 预览要整篇解析，
  // 所以单独走 `read_text_file`（见 src-tauri/src/document.rs）。
  const [mdDocs, setMdDocs] = useState<Record<string, MdDoc>>({});

  /**
   * 「新建 tab 时要带的锚点」暂存（键为小写路径）。
   *
   * 只在「目标文档还没打开」时用得上：openPath 会新建 tab，而它不该长一个只有
   * Markdown 才关心的参数，于是用这个一次性暂存把锚点带过去，建完即删。
   * 已经打开的 tab 走 openDocAt 里的另一条路径（直接改写 tab.anchor）。
   */
  const newTabAnchorRef = useRef<Map<string, string>>(new Map());

  /**
   * 读取一个 Markdown 文件全文：成功存文本，失败把错误写到该 tab（驱动状态页）。
   * 返回**内容是否与上次不同** —— 自动刷新据此决定要不要重排版（见 MarkdownView 的「跟随」）。
   *
   * `encodingOverride` 给「刚改完编码」这类**调用方已经知道答案**的场景：`setTabs`
   * 是异步的，紧接着调 `loadMd` 时 `tabsRef` 还是旧的那份，按 tab 现取会拿到旧编码。
   * 其余调用方不传，按 tab 当前的选择走。
   */
  const loadMd = useCallback(
    async (tabId: string, mdPath: string, encodingOverride?: string): Promise<boolean> => {
      const encoding = encodingOverride ?? encodingChoiceOf(tabId);
      try {
        const doc = await invoke<MdDoc>("read_text_file", {
          path: mdPath,
          maxBytes: MD_MAX_BYTES,
          encoding,
        });
        // 后端把「实际按哪种编码解出来的」一并回传：状态栏据此显示（含自动探测的结果）。
        if (doc.encoding) {
          setEncodings((prev) => ({ ...prev, [tabId]: doc.encoding ?? null }));
        }
        // 内容一模一样（只是 mtime 变了，例如编辑器「保存了但没改动」或自动保存）
        // 就不换引用：否则自动刷新会把整篇文档重新解析+重排版一遍，白卡一下。
        let changed = false;
        setMdDocs((prev) => {
          const old = prev[tabId];
          if (old && old.text === doc.text && old.truncated === doc.truncated) {
            return prev;
          }
          changed = true;
          return { ...prev, [tabId]: doc };
        });
        setTabs((prev) =>
          prev.map((t) => (t.id === tabId ? { ...t, openError: undefined } : t))
        );
        return changed;
      } catch (e) {
        // 失败时清掉旧内容：文件已被删/改成读不了，继续展示上一次的正文等于说假话。
        setMdDocs((prev) => {
          if (!(tabId in prev)) {
            return prev;
          }
          const next = { ...prev };
          delete next[tabId];
          return next;
        });
        setTabs((prev) =>
          prev.map((t) => (t.id === tabId ? { ...t, openError: String(e) } : t))
        );
        return false;
      }
    },
    []
  );

  /** 「重新读取」按钮：失败时不动 tab 状态（错误已由 loadMd 写入或保留）。 */
  const reloadMd = useCallback(
    (tabId: string, mdPath: string) => {
      void loadMd(tabId, mdPath);
    },
    [loadMd]
  );

  /**
   * 自动刷新用：读到内容后由 `loadMd` 自己判断「是否真的变了」，返回变化与否。
   *
   * 为什么不让 MarkdownView 直接调 `reloadMd`：一次无条件重读会把「保存但没改内容」
   * 也走成整篇重解析 + 重排版；判断放在这里（比较的是 App 手里的上一份正文），
   * 页面只需要「闪一下提示」。
   */
  const reloadMdIfChanged = useCallback(
    (tabId: string, mdPath: string): Promise<boolean> => loadMd(tabId, mdPath),
    [loadMd]
  );

  /** 查询文件 mtime/大小：Markdown 页的「跟随」用它做轮询（见 MarkdownView）。 */
  const statTextFile = useCallback(
    (path: string): Promise<{ mtimeMs: number; size: number }> =>
      invoke<{ mtimeMs: number; size: number }>("stat_text_file", { path }),
    []
  );


  /** 通过文件对话框添加一个 schema：备份进应用数据目录后注册，返回备份路径（取消 null）。 */
  const importSchemaViaDialog = useCallback(async (): Promise<string | null> => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "cfg_table_slots.json", extensions: ["json"] }],
      });
      if (typeof selected !== "string") {
        return null;
      }
      // 后端把文件内容复制到应用数据目录，此后不再依赖原文件。
      const stored = await invoke<string>("save_schema", { path: selected });
      setSchemaPaths((prev) => pushSchemaPath(prev, stored));
      return stored;
    } catch (e) {
      console.error("importSchemaViaDialog failed", e);
      return null;
    }
  }, []);

  /** 手动选择 cfg_table_slots.json 后重新解析指定 tab（备份进应用数据目录后使用）。 */
  const pickCfgSchema = useCallback(
    async (tabId: string, binPath: string) => {
      const stored = await importSchemaViaDialog();
      if (!stored) {
        return;
      }
      setTabs((prev) =>
        prev.map((t) => (t.id === tabId ? { ...t, slotsPath: stored } : t))
      );
      await parseCfg(tabId, binPath, stored);
    },
    [importSchemaViaDialog, parseCfg]
  );

  // ==================== schema 文件记录管理 ====================

  /** 从 schema 记录中移除一条（同步删除应用数据目录中的备份文件）；
   *  若激活 tab 正选中它，回退为未选择。 */
  const removeSchema = useCallback((path: string) => {
    void invoke("remove_schema_file", { path }).catch((e) => {
      console.error("remove_schema_file failed", path, e);
    });
    const key = path.toLowerCase();
    setSchemaPaths((prev) => prev.filter((p) => p.toLowerCase() !== key));
    setTabs((prev) =>
      prev.map((t) =>
        t.slotsPath && t.slotsPath.toLowerCase() === key ? { ...t, slotsPath: null } : t
      )
    );
  }, []);

  /** 为指定 tab 选择 schema；若已处于表格视图则立即重新解析。 */
  const selectTabSchema = useCallback(
    (tabId: string, slotsPath: string) => {
      setSchemaError(false);
      setTabs((prev) =>
        prev.map((t) => (t.id === tabId ? { ...t, slotsPath } : t))
      );
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (tab && (tab.viewMode ?? "text") === "cfg") {
        void parseCfg(tabId, tab.path, slotsPath);
      }
    },
    [parseCfg]
  );

  // 恢复：挂载时读上次会话，重建标签页并按各自的视图模式重新打开。
  useEffect(() => {
    const saved = readSavedTabs();
    restoredRef.current = true; // 先标记完成，避免后续保存被跳过
    if (!saved || saved.paths.length === 0) {
      return;
    }
    // 历史存档可能有重复路径（旧版本/异常场景），按 Windows 大小写不敏感去重。
    const seen = new Set<string>();
    const list: TabInfo[] = [];
    for (let i = 0; i < saved.paths.length; i++) {
      const p = saved.paths[i];
      const key = p.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const id = nextTabId();
      const savedMode = saved.modes?.[i];
      // 编码选择：存档里存的是**用户的选择**（手动指定才有值，`auto` 存 null）。
      // 不设 `auto`，好让 `TabInfo.encoding` 的「undefined = 自动」这一条成立。
      const savedEncoding = saved.encodings?.[i] ?? undefined;
      list.push({
        id,
        title: p.split(/[\\/]/).pop() || p,
        path: p,
        // 老存档（或该 tab 没有记录模式）按扩展名推断：Markdown 文件恢复成预览。
        viewMode: savedMode ?? defaultViewModeFor(p),
        slotsPath: saved.schemas?.[i] ?? null,
        encoding: savedEncoding,
      });
    }
    setTabs(list);
    setActiveTabId(list[saved.active]?.id ?? list[list.length - 1]?.id ?? null);
    for (const t of list) {
      // 逐个按各自模式打开；文件已被删除/移动时失败信息记到 tab，正文区显示
      // 「文件不存在」定制页（含重新检测 / 重新定位等修复入口）。
      void reopenTab(t);
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

  // ---- 设置：字体定制（非中文字体 / 中文字体）与正文字号 ----
  //
  // 一个字面量状态（`lv-settings`），旧版本只存过标量字号（`lv-fontsize`），
  // `readSettings` 负责把它迁进来。这里**在首次渲染前**就把字体变量写到 <html> 上：
  // 放到 effect 里做的话，首屏会先用默认字体画一遍再跳变 —— 字体跳变比主题跳变显眼。
  const [settings, setSettings] = useState<AppSettings>(() => {
    const initial = readSettings();
    applyFontSettings(initial);
    return initial;
  });
  /** 正文字号（工具栏 A-/A+ 与设置页共用同一个值）。 */
  const fontSize = settings.fontSize;

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  // 设置变化：写 CSS 变量 + 持久化。
  useEffect(() => {
    applyFontSettings(settings);
    writeSettings(settings);
  }, [settings]);

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

  // Overlay 标题栏：窗口右上角原生按钮（最小化/最大化/关闭）的深浅色跟随主题，
  // 否则切换浅色主题后按钮仍是深色系，与首行观感割裂。
  useEffect(() => {
    try {
      void getCurrentWindow().setTheme(theme === "dark" ? "dark" : "light");
    } catch {
      /* 浏览器复现环境无窗口对象：忽略 */
    }
  }, [theme]);

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

  // ---- 无边框窗口（decorations:false）的自绘窗口按钮 ----
  // maximized 驱动「最大化/还原」图标；经 onResized 跟踪真实窗口状态。
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    let win: ReturnType<typeof getCurrentWindow> | null = null;
    try {
      win = getCurrentWindow();
    } catch {
      return; // 浏览器复现环境无窗口对象
    }
    const w = win;
    const refresh = () => {
      w.isMaximized()
        .then((m) => {
          if (!cancelled) {
            setMaximized(m === true);
          }
        })
        .catch(() => {
          /* ignore */
        });
    };
    void w
      .onResized(refresh)
      .then((fn) => {
        if (!cancelled) {
          unlisten = fn;
          refresh();
        }
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const toggleMaximize = useCallback(() => {
    try {
      void getCurrentWindow().toggleMaximize();
    } catch {
      /* 浏览器复现环境：忽略 */
    }
  }, []);

  const toggleLang = useCallback(() => {
    setLang((l) => (l === "zh" ? "en" : "zh"));
  }, []);

  const changeFontSize = useCallback((delta: number) => {
    setSettings((prev) => ({
      ...prev,
      fontSize: clampFontSize(prev.fontSize + delta),
    }));
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

  // ---- 打开 / 重新打开 tab 的文件 ----

  /**
   * 让后端按文本方式打开指定 tab 的路径（成功清除错误标记，失败记录到 tab）。
   *
   * 只有成功才清错误标记：先清后读会让正文区在失败时闪一次
   * （状态页 → 日志页 → 状态页），空正文一闪而过，观感很差。
   *
   * 编码选择按 tab 现取（`auto` → 后端探测）；后端把解析结果回传，存进
   * `encodings` 供状态栏显示。`encodingOverride` 的理由同 [`loadMd`]：`setTabs`
   * 是异步的，刚改完编码的调用方必须把新选择直接传进来。
   */
  const openTabFile = useCallback(
    async (tabId: string, path: string, encodingOverride?: string): Promise<boolean> => {
      try {
        const info = await invoke<EncodingInfo>("open_log_file", {
          tabId,
          path,
          encoding: encodingOverride ?? encodingChoiceOf(tabId),
        });
        setEncodings((prev) => ({ ...prev, [tabId]: info ?? null }));
        setTabs((prev) =>
          prev.map((t) => (t.id === tabId ? { ...t, openError: undefined, textOpened: true } : t))
        );
        return true;
      } catch (e) {
        // 打开失败：错误记在 tab 上，正文区按分类显示对应状态页（见 bodyViews）。
        setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, openError: String(e) } : t)));
        return false;
      }
    },
    [encodingChoiceOf]
  );

  /**
   * 切换当前激活 tab 的文本编码（编码弹窗的「应用」）。
   *
   * 两条路径，取决于该 tab 此刻由谁在解码：
   * - **文本视图**：走后端 `set_encoding` —— 它整体重建会话（换行符形态、行索引、
   *   已加载窗口全部随之重建），并用 `log-lines`（`reset = true`）事件让正文整体
   *   替换。失败（文件此时已被删除等）会把错误显示在弹窗里、**不关闭弹窗**，
   *   让用户能改选另一个编码或取消。
   * - **Markdown 视图**：那份正文是 `read_text_file` 整读来的，没有 tail 会话，
   *   带新编码重读一遍即可。读取失败沿用既有约定：错误写到 tab 上、正文区显示
   *   错误状态页（`loadMd` 负责），因此这里照常关弹窗。
   */
  const applyEncoding = useCallback(
    async (choice: string) => {
      const tab = tabsRef.current.find((t) => t.id === activeTabId);
      if (!tab) {
        return;
      }
      setEncodingError(null);
      setEncodingBusy(true);
      try {
        if ((tab.viewMode ?? "text") === "md") {
          // 显式把新选择传进去：`setTabs` 之下那次写入（见后）还没反映到 `tabsRef`。
          await loadMd(tab.id, tab.path, choice);
        } else {
          const info = await invoke<EncodingInfo>("set_encoding", {
            tabId: tab.id,
            encoding: choice,
          });
          setEncodings((prev) => ({ ...prev, [tab.id]: info ?? null }));
        }
        // **成功之后**才把「选择」写回 tab（并随会话存档持久化）。
        // 先写后调的话，一次失败的切换会留下「存档说 GBK、会话其实还是 UTF-8」的
        // 不一致，而这个不一致在下次打开文件之前都不会被发现。
        //
        // Markdown 分支的「成功」含义稍弱：`loadMd` 自己吞掉读取错误（把错误写到 tab
        // 上、正文区显示错误页），所以文件读不到时这里仍会写下选择。那没关系 ——
        // 错误页说明的是「这个文件读不了」，与编码无关；下次打开成功时用用户的选择
        // 正是他想要的。
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tab.id ? { ...t, encoding: choice === AUTO_ID ? undefined : choice } : t
          )
        );
        setEncodingOpen(false);
      } catch (e) {
        setEncodingError(appT.encodingFailed(String(e)));
      } finally {
        setEncodingBusy(false);
      }
    },
    [activeTabId, appT, loadMd]
  );

  /**
   * 切换编码后重新拉一次状态栏的编码信息。
   *
   * 文本视图的重载是**异步**的（后端重建会话、发 reset 事件），`applyEncoding` 里
   * 拿到的只是「已按新编码重开」的即时结果；等正文真正回来后再对一次账，避免
   * 状态栏显示与正文实际用的编码不一致（例如后端回退到了兜底编码）。
   */
  useEffect(() => {
    if (!encodingOpen || !activeTabId) {
      return;
    }
    const tabId = activeTabId;
    void fetchTabEncoding(tabId).then((info) => {
      if (info) {
        setEncodings((prev) => ({ ...prev, [tabId]: info }));
      }
    });
  }, [encodingOpen, activeTabId, encodingBusy]);
  // ---- 失败 tab 的重新检测 ----
  //
  // 状态页本身只有一行说明、没有按钮，所以这里只保留一条**隐式**的恢复路径：
  // 从历史记录 / 拖放 / 命令行再次打开同一路径时，顺手重试那个失败 tab。
  // 没有它的话，文件恢复后 tab 会一直停在「文件不存在」，界面就说了假话。

  /** 按 tab 当前的视图模式重新打开它（返回是否成功）。 */
  const reopenTab = useCallback(
    (tab: TabInfo): Promise<boolean> => {
      const mode = tab.viewMode ?? defaultViewModeFor(tab.path);
      // 编码显式传 tab 自己的那份：这里手里就有整个 tab 对象，比按 id 去 ref 里
      // 现取更准 —— 恢复会话时 `setTabs(list)` 还没生效，ref 里查不到这些新 tab。
      if (mode === "md") {
        return loadMd(tab.id, tab.path, tab.encoding);
      }
      return mode === "cfg" && tab.slotsPath
        ? parseCfg(tab.id, tab.path, tab.slotsPath)
        : openTabFile(tab.id, tab.path, tab.encoding);
    },
    [loadMd, openTabFile, parseCfg]
  );

  // 打开新文件：新建一个 tab。视图模式按扩展名推断（.md/.markdown 直接进 Markdown
  // 预览），其余按文本日志打开；表格视图涉及 schema 选择，始终由用户手动切换。
  // 同路径（Windows 大小写不敏感）已有 tab 时直接激活，不重复打开。
  /** 打开指定路径（对话框选中后 / 自动化钩子 / 会话恢复共用）。 */
  const openPath = useCallback(
    async (selected: string) => {
      const key = selected.toLowerCase();
      const existing = tabsRef.current.find((t) => t.path.toLowerCase() === key);
      if (existing) {
        setActiveTabId(existing.id);
        // 该 tab 处于失败态（打开时文件不存在）：再打开一次等价于重新检测，
        // 文件已恢复就直接切回内容视图，否则继续显示那一行说明。
        if (existing.openError) {
          void reopenTab(existing);
        }
        return;
      }
      const id = nextTabId();
      const name = selected.split(/[\\/]/).pop() || selected;
      const viewMode = defaultViewModeFor(selected);
      // 跨文档链接带来的锚点（openDocAt 暂存）：建 tab 时带上，页面渲染后跳转
      const anchor = newTabAnchorRef.current.get(key);
      newTabAnchorRef.current.delete(key);
      // 记录到最近打开历史（去重、上限 10 条；不做存在性检查，失效路径由
      // 正文区的「文件不存在」状态页负责说明）。
      setRecentPaths((prev) => pushRecentPath(prev, selected));
      // 先建 tab，再让后端打开文件；失败时正文区显示对应状态页。
      setTabs((prev) => [...prev, { id, title: name, path: selected, viewMode, anchor }]);
      setActiveTabId(id);
      if (viewMode === "md") {
        await loadMd(id, selected);
      } else {
        await openTabFile(id, selected);
      }
    },
    [loadMd, openTabFile, reopenTab]
  );

  /** 打开另一个文档（可选锚点）：走 App 既有的 openPath，锚点写进目标 tab 的状态。 */
  const openDocAt = useCallback(
    (docPath: string, anchor?: string) => {
      if (anchor) {
        const key = docPath.toLowerCase();
        // 已打开的 tab：直接改写它的 anchor（会触发一次重渲染，页面据此跳转）
        const existing = tabsRef.current.find((t) => t.path.toLowerCase() === key);
        if (existing) {
          setTabs((prev) => prev.map((t) => (t.id === existing.id ? { ...t, anchor } : t)));
        }
        // 还没打开的 tab：由 openPath 新建时带上（见 NewTabAnchorRef）
        newTabAnchorRef.current.set(key, anchor);
      }
      void openPath(docPath);
    },
    [openPath]
  );

  /**
   * 切换指定 tab 的视图模式。
   *
   * 切到表格：按该 tab 选择的 schema 解析（必须手动指定）。
   * 切到 Markdown：读取全文；从表格切走时清掉 openError（那条错误说的是 bin 解析失败，
   * 与 Markdown 无关，留着会让新页面一进来就显示别人的错误）。
   */
  const switchViewMode = useCallback(
    (tabId: string, mode: ViewMode, binPath: string, slotsPath: string) => {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? { ...t, viewMode: mode, openError: mode === "text" ? t.openError : undefined }
            : t
        )
      );
      if (mode === "cfg") {
        void parseCfg(tabId, binPath, slotsPath);
      } else if (mode === "md") {
        void loadMd(tabId, binPath);
      } else {
        // 切回文本视图：只有「从没开过文本会话」的 tab 才需要补 open_log_file
        // （Markdown 预览直接打开的 tab 就是这种），否则会白清一次已加载内容。
        const tab = tabsRef.current.find((t) => t.id === tabId);
        if (tab && !tab.textOpened) {
          void openTabFile(tabId, binPath);
        }
      }
    },
    [loadMd, openTabFile, parseCfg]
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
        // 扩展名只是给对话框的默认过滤器；`*` 一直保留（日志没有固定后缀）。
        filters: [{ name: appT.openDialogName, extensions: ["log", "txt", "md", "markdown", "bin", "*"] }],
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

  /** 收起总菜单（连同其二级菜单）。 */
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setHistoryOpen(false);
  }, []);

  /** 总菜单开关：展开时从图标矩形读取坐标（portal 定位用）。 */
  const toggleMenu = useCallback(() => {
    if (menuOpen) {
      closeMenu();
      return;
    }
    const r = menuBtnRef.current?.getBoundingClientRect();
    setMenuPos(r ? { left: r.left, top: r.bottom } : { left: 0, top: 0 });
    setHistoryOpen(false);
    setMenuOpen(true);
  }, [menuOpen, closeMenu]);

  /** 退出程序：单窗口应用，关闭主窗口即退出。 */
  const exitApp = useCallback(() => {
    closeMenu();
    try {
      void getCurrentWindow().close();
    } catch {
      /* 浏览器复现环境：忽略 */
    }
  }, [closeMenu]);

  /** 历史菜单选中一项：同路径的 tab 已打开（且打开成功）→ 激活它，不新建；
   *  否则走常规打开流程。Windows 路径大小写不敏感，按小写比较。 */
  const openRecent = useCallback(
    (path: string) => {
      closeMenu();
      const key = path.toLowerCase();
      const existing = tabs.find((t) => t.path.toLowerCase() === key && !t.openError);
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }
      void openPath(path);
    },
    [tabs, openPath, closeMenu]
  );

  /** 单独删除一条历史记录（二级菜单保持展开，便于连续删除）。 */
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
      // 无论文本、表格还是 Markdown 视图，后端会话与页面缓存都要清理。
      void invoke("close_tab", { tabId: id });
      setCfgTables((prev) => {
        if (!(id in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setMdDocs((prev) => {
        if (!(id in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setEncodings((prev) => {
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

  /** 打开 tab 右键菜单：抑制 WebView2 默认菜单，记录光标坐标，并激活该 tab。 */
  const openTabMenu = useCallback((e: React.MouseEvent, tab: TabInfo) => {
    if (tabDragRef.current) {
      return; // 拖拽进行中不打开菜单
    }
    e.preventDefault();
    e.stopPropagation();
    setActiveTabId(tab.id);
    setTabMenuCopied(false);
    setTabMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
  }, []);

  const closeTabMenu = useCallback(() => {
    setTabMenu(null);
    setTabMenuCopied(false);
  }, []);

  /** 「在文件浏览器中打开」：Explorer 弹出并选中该文件；失败静默记录（菜单已关）。 */
  const handleRevealTab = useCallback(
    (tab: TabInfo) => {
      closeTabMenu();
      void revealItemInDir(tab.path).catch((e) => {
        console.error("revealItemInDir failed:", tab.path, e);
      });
    },
    [closeTabMenu]
  );

  /** 「复制路径」：成功后菜单项短暂显示「已复制路径」再自动关闭；失败静默关闭。 */
  const handleCopyTabPath = useCallback(
    (tab: TabInfo) => {
      void copyTextToClipboard(tab.path)
        .then(() => {
          setTabMenuCopied(true);
          window.setTimeout(closeTabMenu, 900);
        })
        .catch((e) => {
          console.error("copy path failed:", tab.path, e);
          closeTabMenu();
        });
    },
    [closeTabMenu]
  );

  // ==================== tab 拖拽排序 ====================

  /** 由指针横坐标计算插入目标：含源 tab 的序列中第一个「中线在指针右侧」的
   *  下标（== tabs.length 表示末尾），同时返回指示线在 .tabs 容器内的横坐标。 */
  const computeTabTarget = useCallback((clientX: number) => {
    const box = tabsBoxRef.current;
    if (!box) {
      return { target: 0, indicatorX: 0 };
    }
    const els = Array.from(box.querySelectorAll<HTMLElement>(".tab"));
    const boxLeft = box.getBoundingClientRect().left;
    const n = els.length;
    let target = n;
    let indicatorX = 0;
    for (let i = 0; i < n; i++) {
      const r = els[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) {
        target = i;
        indicatorX = r.left - 2 - boxLeft;
        break;
      }
    }
    if (target === n && n > 0) {
      indicatorX = els[n - 1].getBoundingClientRect().right + 2 - boxLeft;
    }
    return { target, indicatorX };
  }, []);

  /** 拖拽时指针靠近 tabbar 左右边缘 → 自动横向滚动（速率随距离增大）。 */
  const autoScrollTabbar = useCallback((clientX: number) => {
    const bar = tabbarRef.current;
    if (!bar) {
      return;
    }
    const r = bar.getBoundingClientRect();
    const edge = 48;
    let dx = 0;
    if (clientX < r.left + edge) {
      dx = -Math.ceil((edge - (clientX - r.left)) / 2);
    } else if (clientX > r.right - edge) {
      dx = Math.ceil((edge - (r.right - clientX)) / 2);
    }
    if (dx !== 0) {
      bar.scrollLeft += dx;
    }
  }, []);

  /** pointerdown：记录待定手势并捕获指针；✕ 按钮与右键不参与。 */
  const onTabPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>, t: TabInfo) => {
    if (e.button !== 0) {
      return;
    }
    if ((e.target as HTMLElement).closest(".tab-close")) {
      return;
    }
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    dragActiveRef.current = false;
    pendingDragRef.current = {
      tabId: t.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX - r.left,
      rect: { top: r.top, width: r.width, height: r.height },
      from: tabsRef.current.findIndex((x) => x.id === t.id),
    };
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件/指针不存在时忽略捕获，事件仍按冒泡到达本元素 */
    }
  }, []);

  /** pointermove（指针捕获后持续到达源 tab）：超过阈值才升级为拖拽，否则视为点击。 */
  const onTabPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const p = pendingDragRef.current;
      if (!p || p.pointerId !== e.pointerId) {
        return;
      }
      if (!dragActiveRef.current) {
        if (Math.abs(e.clientX - p.startX) < 5 && Math.abs(e.clientY - p.startY) < 5) {
          return;
        }
        dragActiveRef.current = true;
        setTabMenu(null); // 进入拖拽：收起右键菜单
        const { target, indicatorX } = computeTabTarget(e.clientX);
        setTabDrag({
          tabId: p.tabId,
          pointerId: p.pointerId,
          x: e.clientX - p.offsetX,
          y: p.rect.top,
          width: p.rect.width,
          height: p.rect.height,
          indicatorX,
          target,
          from: p.from,
        });
        return;
      }
      autoScrollTabbar(e.clientX);
      const { target, indicatorX } = computeTabTarget(e.clientX);
      setTabDrag((d) =>
        d ? { ...d, x: e.clientX - p.offsetX, indicatorX, target } : d
      );
    },
    [computeTabTarget, autoScrollTabbar]
  );

  /** 结束手势：commit=true 按目标位置重排 tabs；false（Esc/pointercancel）放弃。 */
  const finishTabDrag = useCallback((commit: boolean) => {
    const p = pendingDragRef.current;
    pendingDragRef.current = null;
    const wasDragging = dragActiveRef.current;
    dragActiveRef.current = false;
    const d = tabDragRef.current;
    setTabDrag(null);
    if (!wasDragging || !p || !d || !commit) {
      return;
    }
    // 记录落点：紧随 pointerup 的 click 会命中被拖 tab，短窗口内忽略该次激活。
    lastTabDragEndRef.current = { tabId: d.tabId, time: Date.now() };
    // 含源 tab 序列里的插入下标 → 移除源 tab 后的实际下标。
    const to = d.target > d.from ? d.target - 1 : d.target;
    if (to === d.from) {
      return; // 落回原位置，无需重排
    }
    setTabs((prev) => {
      const from = prev.findIndex((x) => x.id === d.tabId);
      if (from < 0 || to < 0 || to > prev.length - 1 || to === from) {
        return prev;
      }
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      if (!moved) {
        return prev;
      }
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  // 拖拽中按 Esc 取消（不影响其它 Esc 处理器：about 菜单等各自独立监听）。
  useEffect(() => {
    if (!tabDrag) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        finishTabDrag(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [tabDrag, finishTabDrag]);

  /** 当前激活 tab（用于标题栏同步 / 视图模式选择框的目标）。 */
  const activeTab = tabs.find((t) => t.id === activeTabId);

  // 原生标题条已与首行融合（Overlay）：把窗口标题同步为当前激活 tab 的文件名，
  // 任务栏 / Alt+Tab 上能直接看到正在看哪个日志；无 tab 时回落为应用名。
  useEffect(() => {
    try {
      void getCurrentWindow().setTitle(activeTab ? activeTab.title : "LogLens");
    } catch {
      /* 浏览器复现环境无窗口对象：忽略 */
    }
  }, [activeTab?.title]);

  /** 右键菜单指向的 tab（已关闭时找不到，菜单随之消失）。 */
  const menuTab = tabMenu ? tabs.find((t) => t.id === tabMenu.tabId) : undefined;

  /**
   * 文本编码是否适用于当前 tab。
   *
   * 表格视图（`client_cfg` 二进制）不按文本解码，编码对它没有意义 —— 状态栏此时
   * 把编码显示成不可点的灰色，而不是藏起来（否则状态栏会在视图间跳动）。
   * 没有激活 tab 时也不适用。
   */
  const canPickEncoding = activeTab != null && (activeTab.viewMode ?? "text") !== "cfg";

  /**
   * 激活 tab 换了、而状态栏还没有它的编码信息时补一次。
   *
   * 编码信息由各视图在自己打开/整读文件时上报（`open_log_file` / `read_text_file`
   * 的返回值），但有几条路径不会上报：会话恢复时文件已不存在、tab 关闭后又被
   * 重新打开、以及将来新增的视图。少一次补拉，状态栏就会一直显示「—」，
   * 而它旁边的行数却是有值的 —— 看起来像功能坏了。
   *
   * 两条查法：先问后端会话（`get_encoding`，文本视图有会话才有答案），
   * 拿不到再直接探测文件（`detect_encoding`，Markdown 视图没有 tail 会话，走这条）。
   * 只在「确实没有」时才问（`encodings[activeTabId]` 有值就跳过）：这是补位，
   * 不是每次切 tab 都打两次 IPC。
   */
  useEffect(() => {
    if (!canPickEncoding || !activeTabId) {
      return;
    }
    const tab = tabs.find((t) => t.id === activeTabId);
    // 文件本身打不开（不存在 / 无权限）时不要再问：探测只会一直失败，而这个 effect
    // 的依赖里带着 `tabs`，每次开关 tab 都会白打两轮 IPC。
    if (!tab || tab.openError || encodings[activeTabId]) {
      return;
    }
    let alive = true;
    const choice = tab.encoding || AUTO_ID;
    void fetchTabEncoding(activeTabId)
      // 会话没有答案（Markdown 视图没有 tail 会话）→ 按**这个 tab 自己的选择**解析，
      // 不能无条件重跑自动探测：手动钉死编码的 tab 会被显示成探测结果，与正文对不上。
      .then((info) => info ?? detectEncoding(tab.path, choice))
      .then((info) => {
        if (alive && info) {
          setEncodings((prev) => ({ ...prev, [activeTabId]: info }));
        }
      });
    return () => {
      alive = false;
    };
  }, [canPickEncoding, activeTabId, encodings, tabs]);

  return (
    <div
      className="loglens"
      style={{ "--log-font-size": `${fontSize}px` } as React.CSSProperties}
    >
      <div className="tabbar" ref={tabbarRef}>
        {/* 无边框窗口（decorations:false）：tab 列表与右侧工具栏之间的空白
            拖拽条负责窗口拖动。双击拖拽条由 Tauri 内置脚本自动触发最大化/还原
            （internal_toggle_maximize）。tabbar 容器自身不标 drag region——它的
            底部可能出现水平滚动条，标在容器上会抢走滚动条拖动。 */}
        <button
          className="menu-btn"
          ref={menuBtnRef}
          onClick={toggleMenu}
          title={appT.menuTitle}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2 4.5h12M2 8h12M2 11.5h12" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
        <div className="tabs" ref={tabsBoxRef}>
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`tab ${t.id === activeTabId ? "active" : ""} ${
                tabDrag?.tabId === t.id ? "drag-source" : ""
              }`}
              onClick={() => {
                // 拖拽结束后的首次 click 是 pointerup 的附属事件，不激活 tab
                // （时间窗 + 同 tab 判定，避免误吞用户快速点击其它 tab）。
                const last = lastTabDragEndRef.current;
                if (last && last.tabId === t.id && Date.now() - last.time < 400) {
                  lastTabDragEndRef.current = null;
                  return;
                }
                setActiveTabId(t.id);
              }}
              onContextMenu={(e) => openTabMenu(e, t)}
              onPointerDown={(e) => onTabPointerDown(e, t)}
              onPointerMove={onTabPointerMove}
              onPointerUp={() => finishTabDrag(true)}
              onPointerCancel={() => finishTabDrag(false)}
            >
              <span className="tab-title">{t.title}</span>
              {/* 打开失败的 tab：标题后加警告标记，不必切过去就知道哪个 tab 有问题
                  （正文区的完整解释由状态页面负责，见 bodyViews）。 */}
              {t.openError ? (
                <span className="tab-warn" title={t.openError} aria-label={t.openError}>
                  ⚠
                </span>
              ) : null}
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
          {tabDrag ? (
            <div className="tab-drop-indicator" style={{ left: tabDrag.indicatorX }} />
          ) : null}
          <button className="tab-add" onClick={handleOpen} disabled={opening} title={appT.openTabTitle}>
            {opening ? "…" : appT.openTab}
          </button>
        </div>
        {/* tab 列表与右侧工具栏之间的空白：窗口拖动主区域（tab 少时占满整行）。 */}
        <div className="titlebar-drag" data-tauri-drag-region />
        <div className="tabbar-right">
          <button
            className="icon-btn"
            onClick={() => changeFontSize(-1)}
            title={appT.fontSizeSmaller}
            disabled={fontSize <= FONT_SIZE_MIN}
          >
            A-
          </button>
          <span className="font-label">{fontSize}px</span>
          <button
            className="icon-btn"
            onClick={() => changeFontSize(1)}
            title={appT.fontSizeBigger}
            disabled={fontSize >= FONT_SIZE_MAX}
          >
            A+
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
          {/* 设置（含字体定制）：齿轮放在工具栏最右，与主题切换相邻。 */}
          <button
            className="icon-btn settings-btn"
            onClick={() => setSettingsOpen(true)}
            title={appT.settingsOpenTitle}
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z"
                stroke="currentColor"
                strokeWidth="1.2"
              />
              <path
                d="M13.2 8c0-.35-.04-.69-.1-1.02l1.4-1.05-1.5-2.6-1.62.66a5.2 5.2 0 0 0-1.77-1.03L9.4 1.3H6.6l-.21 1.66a5.2 5.2 0 0 0-1.77 1.03l-1.62-.66-1.5 2.6 1.4 1.05a5.3 5.3 0 0 0 0 2.04l-1.4 1.05 1.5 2.6 1.62-.66c.52.45 1.12.8 1.77 1.03l.21 1.66h2.8l.21-1.66a5.2 5.2 0 0 0 1.77-1.03l1.62.66 1.5-2.6-1.4-1.05c.06-.33.1-.67.1-1.02Z"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        {/* 无边框窗口的自绘窗口按钮（最小化/最大化/关闭），位于首行最右。 */}
        <div className="win-controls">
          <button
            className="win-btn"
            onClick={() => {
              try {
                void getCurrentWindow().minimize();
              } catch {
                /* ignore */
              }
            }}
            title={appT.winMinimize}
          >
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
          <button
            className="win-btn"
            onClick={toggleMaximize}
            title={maximized ? appT.winRestore : appT.winMaximize}
          >
            {maximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1" />
                <path d="M2.5 2.5V0.5H9.5V7.5H7.5" stroke="currentColor" strokeWidth="1" fill="none" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" />
              </svg>
            )}
          </button>
          <button
            className="win-btn win-close"
            onClick={() => {
              try {
                void getCurrentWindow().close();
              } catch {
                /* ignore */
              }
            }}
            title={appT.winClose}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M0.5 0.5L9.5 9.5M9.5 0.5L0.5 9.5" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
        </div>
      </div>

      {menuOpen && menuPos
        ? createPortal(
            <div
              className="app-menu"
              ref={menuRef}
              role="menu"
              style={{ position: "fixed", left: menuPos.left, top: menuPos.top }}
            >
              <div className="app-menu-has-sub">
                <button
                  className="app-menu-item"
                  role="menuitem"
                  aria-expanded={historyOpen}
                  onClick={() => setHistoryOpen((h) => !h)}
                >
                  <span>{appT.recentTitle}</span>
                  <span className="app-menu-caret">{historyOpen ? "▾" : "▸"}</span>
                </button>
                {historyOpen ? (
                  <div className="app-menu-sub" role="menu">
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
                  </div>
                ) : null}
              </div>
              <button
                className="app-menu-item"
                role="menuitem"
                onClick={() => {
                  closeMenu();
                  toggleLang();
                }}
              >
                {appT.menuLangTitle}
              </button>
              <button
                className="app-menu-item"
                role="menuitem"
                onClick={() => {
                  closeMenu();
                  setSettingsOpen(true);
                }}
              >
                {appT.settingsTitle}
              </button>
              <button
                className="app-menu-item"
                role="menuitem"
                onClick={() => {
                  closeMenu();
                  setAboutOpen(true);
                }}
              >
                {appT.aboutTitle}
              </button>
              <div className="app-menu-sep" role="separator" />
              <button className="app-menu-item app-menu-exit" role="menuitem" onClick={exitApp}>
                {appT.menuExit}
              </button>
            </div>,
            document.body
          )
        : null}

      {tabMenu && menuTab
        ? createPortal(
            <div
              className="tab-menu"
              ref={tabMenuRef}
              role="menu"
              style={{ position: "fixed", left: tabMenu.x, top: tabMenu.y }}
              onContextMenu={(e) => e.preventDefault()}
            >
              <button
                className="tab-menu-item"
                role="menuitem"
                onClick={() => handleRevealTab(menuTab)}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M2 4.5h12M2 4.5v7.5a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V4.5"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    fill="none"
                  />
                  <path d="M2 6.5h12M5 9h6" stroke="currentColor" strokeWidth="1.2" />
                </svg>
                {appT.tabMenuReveal}
              </button>
              <button
                className="tab-menu-item"
                role="menuitem"
                onClick={() => handleCopyTabPath(menuTab)}
              >
                {tabMenuCopied ? (
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path d="M2.5 8.5L6 12L13.5 4" stroke="currentColor" strokeWidth="1.6" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <rect
                      x="5.5"
                      y="5.5"
                      width="9"
                      height="9"
                      rx="1"
                      stroke="currentColor"
                      strokeWidth="1.2"
                    />
                    <path
                      d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      fill="none"
                    />
                  </svg>
                )}
                {tabMenuCopied ? appT.tabMenuCopyPathOk : appT.tabMenuCopyPath}
              </button>
            </div>,
            document.body
          )
        : null}

      {tabDrag
        ? (() => {
            const dragTab = tabs.find((t) => t.id === tabDrag.tabId);
            if (!dragTab) {
              return null;
            }
            return createPortal(
              <div
                className="drag-ghost"
                aria-hidden="true"
                style={{
                  left: tabDrag.x,
                  top: tabDrag.y,
                  width: tabDrag.width,
                  height: tabDrag.height,
                }}
              >
                <span className="tab-title">{dragTab.title}</span>
                <button className="tab-close" tabIndex={-1} disabled>
                  ✕
                </button>
              </div>,
              document.body
            );
          })()
        : null}

      {tabs.length > 0 ? (
        <>
          {tabs.map((t) => (
            <div
              key={t.id}
              className="tab-panel"
              style={{ display: t.id === activeTabId ? "flex" : "none" }}
            >
              {/* 正文渲染交给页面框架：由注册表按 tab 状态选出唯一页面
                  （文件不存在 / 打开失败 / 表格 / 文本），见 bodyViews。 */}
              <BodyViewHost
                registry={bodyViews}
                ctx={{
                  tab: t,
                  error: classifyOpenError(t.openError),
                  cfg: cfgTables[t.id] ?? null,
                  pickSchema: (tabId, path) => void pickCfgSchema(tabId, path),
                  md: mdDocs[t.id] ?? null,
                  reloadMd,
                  reloadMdIfChanged,
                  openDoc: openDocAt,
                  anchor: t.anchor ?? null,
                  consumeAnchor: () => {
                    // 写回 undefined：锚点是一次性指令，消费完就清，避免重渲染时反复跳
                    setTabs((prev) =>
                      prev.map((x) => (x.id === t.id && x.anchor ? { ...x, anchor: undefined } : x))
                    );
                  },
                  statFile: statTextFile,
                }}
                base={{
                  tabId: t.id,
                  path: t.path,
                  active: t.id === activeTabId,
                  fontSize,
                  lang,
                  onSwitchViewMode: () => {
                    setSchemaError(false);
                    setViewModeOpen(true);
                  },
                  onClose: () => closeTab(t.id),
                  registerCopy,
                  reportTotal,
                }}
              />
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

      {settingsOpen ? (
        <SettingsModal
          lang={lang}
          settings={settings}
          onChange={updateSettings}
          theme={theme}
          onSetTheme={setTheme}
          onSetLang={setLang}
          onClose={closeSettings}
        />
      ) : null}

      {aboutOpen ? (
        <div className="body-modal-overlay" onClick={() => setAboutOpen(false)}>
          <div
            className="about-modal"
            role="dialog"
            aria-modal="true"
            aria-label={appT.aboutTitle}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="about-name">LogLens</div>
            <div className="about-version">
              {appT.aboutVersionLabel} v{appVersion}
            </div>
            <div className="about-desc">{appT.aboutDesc}</div>
            <div className="about-tech">{appT.aboutTech}</div>
            <button className="body-modal-btn" onClick={() => setAboutOpen(false)}>
              {appT.aboutClose}
            </button>
          </div>
        </div>
      ) : null}

      {viewModeOpen && activeTab ? (
        <div className="body-modal-overlay" onClick={() => setViewModeOpen(false)}>
          <div
            className="viewmode-modal"
            role="dialog"
            aria-modal="true"
            aria-label={appT.viewModeModalTitle}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="viewmode-title">{appT.viewModeModalTitle}</div>
            {(
              [
                { id: "text", name: appT.viewModeTextName, desc: appT.viewModeTextDesc },
                { id: "md", name: appT.viewModeMdName, desc: appT.viewModeMdDesc },
                { id: "cfg", name: appT.viewModeCfgName, desc: appT.viewModeCfgDesc },
              ] as const
            ).map((m) => {
              const current = (activeTab.viewMode ?? "text") === m.id;
              return (
                <button
                  key={m.id}
                  className={`viewmode-item${current ? " current" : ""}`}
                  onClick={() => {
                    // 表格视图必须已手动指定 schema 文件；未选择时提示并留在模态框。
                    if (m.id === "cfg" && !activeTab.slotsPath) {
                      setSchemaError(true);
                      return;
                    }
                    switchViewMode(activeTab.id, m.id, activeTab.path, activeTab.slotsPath ?? "");
                    setViewModeOpen(false);
                  }}
                >
                  <div className="viewmode-item-head">
                    <span className="viewmode-item-name">{m.name}</span>
                    {current ? (
                      <span className="viewmode-current">{appT.viewModeCurrent}</span>
                    ) : null}
                  </div>
                  <div className="viewmode-item-desc">{m.desc}</div>
                </button>
              );
            })}
            <div className="viewmode-schema">
              <div className="viewmode-schema-title">{appT.viewModeSchemaTitle}</div>
              {schemaError ? (
                <div className="viewmode-schema-error">{appT.viewModeSchemaRequired}</div>
              ) : null}
              {schemaPaths.length === 0 ? (
                <div className="viewmode-schema-empty">{appT.viewModeSchemaEmpty}</div>
              ) : null}
              {schemaPaths.map((p) => {
                const name = p.split(/[\\/]/).pop() || p;
                const checked =
                  activeTab.slotsPath != null &&
                  activeTab.slotsPath.toLowerCase() === p.toLowerCase();
                return (
                  <div
                    key={p.toLowerCase()}
                    className={`viewmode-schema-item${checked ? " current" : ""}`}
                  >
                    <label>
                      <input
                        type="radio"
                        name="lv-schema"
                        checked={checked}
                        onChange={() => selectTabSchema(activeTab.id, p)}
                      />
                      <span className="viewmode-schema-name" title={p}>
                        {name}
                      </span>
                      <span className="viewmode-schema-path">{p}</span>
                    </label>
                    <button
                      className="viewmode-schema-del"
                      onClick={() => removeSchema(p)}
                      title={appT.viewModeSchemaRemove}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
              <button
                className="viewmode-schema-add"
                onClick={() => {
                  void importSchemaViaDialog().then((sel) => {
                    // 添加即选中（文件已备份进应用数据目录）。
                    if (sel) {
                      selectTabSchema(activeTab.id, sel);
                    }
                  });
                }}
              >
                {appT.viewModeSchemaAdd}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {dragActive ? (
        <div className="drop-overlay">
          <div className="drop-overlay-box">{appT.dropToOpen}</div>
        </div>
      ) : null}

      {/* 底部状态栏：行数（从工具栏右上角搬来）+ 文件编码（可点开弹窗切换）。
          放在正文之后、模态框之前：模态框都是 fixed 定位，层级由 z-index 决定，
          与这里的顺序无关。 */}
      <StatusBar
        lang={lang}
        total={activeTotal}
        totalTitle={appT.totalLinesTitle}
        encoding={canPickEncoding ? (encodings[activeTabId ?? ""] ?? null) : null}
        hasTab={activeTab != null}
        canPickEncoding={canPickEncoding}
        busy={encodingBusy}
        onPickEncoding={() => {
          setEncodingError(null);
          setEncodingOpen(true);
        }}
      />

      {encodingOpen && activeTab && canPickEncoding ? (
        <EncodingModal
          lang={lang}
          path={activeTab.path}
          current={encodings[activeTab.id] ?? null}
          error={encodingError}
          busy={encodingBusy}
          onApply={(id) => void applyEncoding(id)}
          onClose={() => {
            setEncodingOpen(false);
            setEncodingError(null);
          }}
        />
      ) : null}
    </div>
  );
}
