import { useCallback, useEffect, useRef, useState } from "react";

// 样式与 KaTeX 的字体/CSS 都挂在本页面（按需加载的 chunk）上：
// 文本视图启动时既不会解析这些 CSS，也不会下载 KaTeX 的字体文件。
import "katex/dist/katex.min.css";
import "../markdown/markdown.css";

import { copyTextToClipboard } from "../clipboard";
import { hashOf } from "../markdown/paths.ts";
import { renderMarkdown, type MdHeading, type MdRenderResult } from "../markdown/markdown.ts";
import { sanitizeHtml } from "../markdown/sanitize.ts";
import type { BodyViewProps, ViewLang } from "./body-view.ts";
import { useBodyViewEffects } from "./use-body-view.ts";
import { ViewToggleButton } from "./ViewToggleButton.tsx";

/**
 * Markdown 预览页面（正文区的第 4 个内容视图）。
 *
 * 和表格视图一样，内容视图自带工具栏与全部状态：文本视图的工具栏（过滤 / 跟随 /
 * 跳行 / 搜索）对 Markdown 没有意义，混在一起只会互相干扰。这里保留的最小集合是
 * 「切回文本视图的入口 + 预览/源码 + 大纲 + 刷新」。
 *
 * 与其他页面的边界：
 * - 渲染管线（解析 / 公式 / 高亮 / 清洗）在 `src/markdown/`，本文件只管交互；
 * - 读文件、开新 tab、调系统程序都在 App 侧，通过 props 注入（页面不碰后端）。
 */

/** 后端 `read_text_file` 的返回负载（与 `src-tauri/src/document.rs` 对齐）。 */
export interface MdDoc {
  /** 全文（UTF-8 BOM 已剥、非法字节按 lossy 替换）。 */
  text: string;
  /** 文件真实字节数。 */
  bytes: number;
  /** 是否因为超过上限被截断。 */
  truncated: boolean;
}

/** 页内查找状态。 */
interface FindState {
  open: boolean;
  query: string;
  caseSensitive: boolean;
  /** 命中序号（0-based）；无命中为 -1。 */
  index: number;
  /** 命中总数。 */
  count: number;
}

const FIND_CLOSED: FindState = { open: false, query: "", caseSensitive: false, index: -1, count: 0 };

/** 大纲面板默认展开的标题数门槛：太短的文档不需要大纲占位。 */
const OUTLINE_MIN_HEADINGS = 3;

// ==================== 用户偏好（localStorage） ====================
//
// 三条偏好都按「全局」存：同一份文档反复打开、或换一篇文档，观感应当延续，
// 而不是每开一个 tab 都要重调一次。键名沿用 App 的 lv-* 约定。

/** 大纲面板偏好：`auto` = 按标题数自动展开（首次使用时的默认行为）。 */
type OutlinePref = "auto" | "open" | "closed";

const OUTLINE_KEY = "lv-md-outline";
const WIDTH_KEY = "lv-md-width";
/** 是否跟随文件变化自动刷新（默认开：文档常被外部编辑，手动点刷新很容易忘）。 */
const FOLLOW_KEY = "lv-md-follow";
/** 阅读位置记忆：`{ [文档路径小写]: 滚动比例 0–1 }`。按比例存，改宽度/字号后依然有效。 */
const SCROLL_KEY = "lv-md-scroll";
/** 位置记忆最多保留多少篇文档（避免 localStorage 无限增长）。 */
const SCROLL_MAX = 60;
/** 自动刷新的轮询间隔：够快（1.5s 内看到编辑结果），又不至于把 IPC 打满。 */
const FOLLOW_POLL_MS = 1500;

/** 正文宽度（占可用宽度的百分比）：默认 70%，范围 20–100，步进 1%。 */
const WIDTH_DEFAULT = 70;
const WIDTH_MIN = 20;
const WIDTH_MAX = 100;

/** 读取大纲偏好（无记录 / 损坏 → auto）。 */
function readOutlinePref(): OutlinePref {
  try {
    const v = localStorage.getItem(OUTLINE_KEY);
    return v === "open" || v === "closed" ? v : "auto";
  } catch {
    return "auto";
  }
}

/** 读取正文宽度偏好（无记录 / 越界 → 默认值）。 */
function readWidthPref(): number {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(v) && v >= WIDTH_MIN && v <= WIDTH_MAX ? Math.round(v) : WIDTH_DEFAULT;
  } catch {
    return WIDTH_DEFAULT;
  }
}

/** 统一的偏好写入（localStorage 不可用时静默，与 App 的其它偏好一致）。 */
function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 忽略：设置不生效不影响阅读 */
  }
}

/** 读取「跟随文件变化」偏好（无记录 → 开）。 */
function readFollowPref(): boolean {
  try {
    return localStorage.getItem(FOLLOW_KEY) !== "0";
  } catch {
    return true;
  }
}

/** 位置记忆：整表读取（键为小写路径）。 */
function readScrollMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SCROLL_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** 位置记忆：按路径读取滚动比例（无记录 → null）。 */
function readScrollRatio(path: string): number | null {
  const ratio = readScrollMap()[path.toLowerCase()];
  return typeof ratio === "number" && ratio > 0 ? ratio : null;
}

/** 位置记忆：写入滚动比例；超出上限时按写入时间淘汰一半（Map 保序，旧的在前）。 */
function writeScrollRatio(path: string, ratio: number): void {
  const map = readScrollMap();
  map[path.toLowerCase()] = ratio;
  const keys = Object.keys(map);
  if (keys.length > SCROLL_MAX) {
    for (const key of keys.slice(0, keys.length - SCROLL_MAX)) {
      delete map[key];
    }
  }
  writePref(SCROLL_KEY, JSON.stringify(map));
}

/** `MarkdownView` 的专属属性（公共属性见 `BodyViewProps`）。 */
export interface MarkdownViewProps
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
  /** 界面语言。 */
  lang: ViewLang;
  /** 后端读到的全文；null = 还没读到（显示「读取中」）。 */
  doc: MdDoc | null;
  /** 读取失败信息（复用 tab.openError，与状态页同一来源）。 */
  error?: string;
  /** 重新读取（文件被外部编辑后手动刷新）。 */
  onReload: () => void;
  /**
   * 读取文件并在**内容确实变化**时替换正文；返回是否发生变化。
   *
   * 与 {@link onReload} 的区别只在于「内容逐字未变时不动状态」——自动刷新用它，
   * 手动「重新读取」仍走 `onReload`（用户点了就该有动作，哪怕内容没变）。
   */
  onReloadIfChanged: () => Promise<boolean>;
  /** 打开另一个 Markdown 文档；`anchor` 用于 `other.md#sec` 的跨文档跳转。 */
  onOpenDoc: (path: string, anchor?: string) => void;
  /** 交给系统默认程序打开本地文件（图片等）。 */
  onOpenLocal: (path: string) => void;
  /** 用默认浏览器打开外部链接。 */
  onOpenUrl: (url: string) => void;
  /** 本地文件路径 → asset 协议 URL（图片用；由 App 注入 Tauri 的 convertFileSrc）。 */
  toAssetUrl: (path: string) => string;
  /** 查询文件的 mtime/大小（自动刷新轮询用）。 */
  statFile: (path: string) => Promise<{ mtimeMs: number; size: number }>;
  /** 打开本 tab 时待跳转的锚点（来自跨文档链接）；跳完通知 App 清掉。 */
  initialAnchor?: string | null;
  /** 待跳锚点已消费（App 侧清空，避免再次打开时重复跳转）。 */
  onAnchorConsumed: () => void;
}

/** 一个文件大小的可读文本。 */
function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 在渲染好的正文里把命中文本包成 `<mark class="md-hit">`。
 *
 * 只处理单个文本节点内部（跨 `<strong>` / `<a>` 的命中不算），公式（`.katex`）内部
 * 一律跳过 —— 往 KaTeX 的排版结构里插 `<mark>` 会把公式拆坏。
 */
function wrapMatches(root: HTMLElement, query: string, caseSensitive: boolean): HTMLElement[] {
  if (!query) {
    return [];
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || node.nodeValue.trim() === "") {
        return NodeFilter.FILTER_REJECT;
      }
      if (node.parentElement?.closest(".katex") != null) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const texts: Text[] = [];
  while (walker.nextNode()) {
    texts.push(walker.currentNode as Text);
  }

  const needle = caseSensitive ? query : query.toLowerCase();
  const marks: HTMLElement[] = [];

  for (const node of texts) {
    const value = node.nodeValue ?? "";
    const haystack = caseSensitive ? value : value.toLowerCase();
    const ranges: Array<[number, number]> = [];
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) {
        break;
      }
      ranges.push([at, at + needle.length]);
      from = at + needle.length;
    }
    if (ranges.length === 0) {
      continue;
    }

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const [start, end] of ranges) {
      if (start > cursor) {
        fragment.appendChild(document.createTextNode(value.slice(cursor, start)));
      }
      const mark = document.createElement("mark");
      mark.className = "md-hit";
      mark.textContent = value.slice(start, end);
      fragment.appendChild(mark);
      marks.push(mark);
      cursor = end;
    }
    if (cursor < value.length) {
      fragment.appendChild(document.createTextNode(value.slice(cursor)));
    }
    node.parentNode?.replaceChild(fragment, node);
  }

  return marks;
}

/**
 * 闪一下刚跳转到的脚注（角标 / 条目 / 回跳箭头）。
 *
 * 为什么要有这个：脚注跳转的目标往往只有一行字，滚过去之后**看不出哪一行是目标**
 * （读者刚点完，视线还停在别处）。去掉类名再强制重排，是为了让连续跳转同一个目标
 * 也能重新播动画（否则第二次点没有任何反馈）。
 */
function flashFootnote(target: HTMLElement): void {
  target.classList.remove("md-flash");
  // 读一次布局属性触发重排，动画才能重放
  void target.offsetWidth;
  target.classList.add("md-flash");
  window.setTimeout(() => target.classList.remove("md-flash"), 1200);
}

/**
 * 把正文里的某个元素滚到滚动容器顶部（带一点留白）。
 *
 * 为什么不用 `element.scrollIntoView()`：它会把**目标元素**对齐到最近的滚动祖先，
 * 而我们要对齐的是 `.md-scroll` 这个容器——正文里嵌着图片容器、KaTeX 的块级元素
 * 各自都有 `overflow`，`scrollIntoView` 选中谁并不确定（实测跳转落点会偏出一百多像素，
 * 而且滚过头时会被夹在容器底部，表现成「点了但没跳到位」）。
 * 这里改成「用两边的 boundingClientRect 算差值 + 手动夹进 [0, maxScroll]」：
 * 落点可预测，也不会出现滚动容器与窗口一起动的情况。
 *
 * 同理不用 CSS 的 `scroll-behavior: smooth` 来兜底：跳转的可见反馈由
 * {@link flashFootnote} / 大纲高亮负责，动画只会让落点变成「取决于何时测量」。
 */
function scrollWithin(scroller: HTMLElement, target: HTMLElement, pad = 8): void {
  const delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - pad;
  const max = scroller.scrollHeight - scroller.clientHeight;
  scroller.scrollTop = Math.min(Math.max(scroller.scrollTop + delta, 0), Math.max(max, 0));
}

/** 界面文案（视图模块自带中英文案，与 CfgTableTab 一致：views → App 单向依赖）。 */const TEXT = {
  zh: {
    toggleTitle: "切换视图模式",
    preview: "预览",
    source: "源码",
    outline: "大纲",
    refresh: "重新读取",
    find: "查找",
    findPlaceholder: "在预览中查找",
    findCase: "区分大小写",
    findPrev: "上一个",
    findNext: "下一个",
    findClose: "关闭",
    loading: "读取中…",
    rendering: "渲染中…",
    retry: "重试",
    truncated: (size: string) => `文件超过预览上限，仅显示前 ${size} 之后的内容被截断。`,
    outlineCollapse: "折叠大纲",
    outlineExpand: "展开大纲",
    errorTitle: "读取失败",
    empty: "（空文档）",
    lines: (n: number) => `共 ${n} 行`,
    imageHint: (src: string) => `在资源管理器中显示：${src}`,
    width: "宽度",
    widthHint: "正文宽度（占可用宽度的百分比，方向键按 1% 调整）",
    widthReset: "恢复默认宽度",
    follow: "跟随",
    followHint: "文件被外部修改时自动重新读取（每 1.5 秒检查一次）",
    refreshed: "已刷新",
    /** 轮询发现文件变了、但内容逐字未变（编辑器空保存 / 只改了换行）时的提示。 */
    followIdle: "无变化",
    modeToggleHint: "在预览与源码之间切换（Ctrl+E）",
    anchorCopyHint: "复制本节链接",
    anchorCopied: "链接已复制",
  },
  en: {
    toggleTitle: "Switch view mode",
    preview: "Preview",
    source: "Source",
    outline: "Outline",
    refresh: "Reload",
    find: "Find",
    findPlaceholder: "Find in preview",
    findCase: "Match case",
    findPrev: "Previous",
    findNext: "Next",
    findClose: "Close",
    loading: "Loading…",
    rendering: "Rendering…",
    retry: "Retry",
    truncated: (size: string) => `File exceeds the preview limit: only the first ${size} is shown.`,
    outlineCollapse: "Collapse outline",
    outlineExpand: "Expand outline",
    errorTitle: "Failed to read",
    empty: "(empty document)",
    lines: (n: number) => `${n} lines`,
    imageHint: (src: string) => `Reveal in File Explorer: ${src}`,
    width: "Width",
    widthHint: "Body width (percentage of the available width; arrow keys step by 1%)",
    widthReset: "Reset to default width",
    follow: "Follow",
    followHint: "Reload automatically when the file changes on disk (checked every 1.5s)",
    refreshed: "Updated",
    followIdle: "Unchanged",
    modeToggleHint: "Switch between preview and source (Ctrl+E)",
    anchorCopyHint: "Copy a link to this section",
    anchorCopied: "Link copied",
  },
} as const;

export function MarkdownView(props: MarkdownViewProps) {
  const {
    active,
    path,
    fontSize,
    lang,
    doc,
    error,
    onReload,
    onReloadIfChanged,
    onOpenDoc,
    onOpenLocal,
    onOpenUrl,
    toAssetUrl,
    statFile,
    initialAnchor,
    onAnchorConsumed,
  } = props;
  const t = TEXT[lang];

  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const marksRef = useRef<HTMLElement[]>([]);
  const findInputRef = useRef<HTMLInputElement>(null);

  const [mode, setMode] = useState<"preview" | "source">("preview");
  /** 渲染结果；null = 还没渲染好（大文档渲染会占住主线程一会儿，先画占位）。 */
  const [rendered, setRendered] = useState<MdRenderResult | null>(null);
  /** 大纲偏好：auto = 按标题数自动决定（首次使用的默认），open/closed = 用户手动选择。 */
  const [outlinePref, setOutlinePref] = useState<OutlinePref>(readOutlinePref);
  /** 正文宽度（%）：用户可调，1% 一档。 */
  const [bodyWidth, setBodyWidth] = useState<number>(readWidthPref);
  /** 是否跟随文件变化自动刷新。 */
  const [follow, setFollow] = useState<boolean>(readFollowPref);
  /** 自动刷新刚生效的瞬时提示（工具栏上闪一下「已刷新」）。 */
  const [justRefreshed, setJustRefreshed] = useState(false);
  /** 轮询发现「文件动了但内容没变」时的瞬时提示（同样是工具栏上闪一下）。 */
  const [justUnchanged, setJustUnchanged] = useState(false);
  /** 点击标题 `¶` 后的瞬时反馈（「链接已复制」）：这个动作没有其它可见结果，没提示等于没发生。 */
  const [anchorCopied, setAnchorCopied] = useState(false);
  const [activeHeading, setActiveHeading] = useState("");
  const [find, setFind] = useState<FindState>(FIND_CLOSED);
  /** 源码视图里点大纲时的待跳目标：切回预览并渲染完成后执行。 */
  const [pendingHeading, setPendingHeading] = useState<string | null>(null);
  /** 已经恢复过滚动位置的文档路径（每篇只恢复一次，自动刷新时不打断阅读）。 */
  const restoredPathRef = useRef<string | null>(null);
  /**
   * 最近一次的滚动位置（像素）。
   *
   * 为什么要在滚动时记下来、而不是重渲染时现读：重渲染会先进入「渲染中…」占位态，
   * 那一刻 `.md-body` 被卸载、内容变空，容器的 scrollTop 会被浏览器**立刻夹成 0**；
   * 等新内容好了再读 scrollTop，读到的就是 0（自动刷新会把读者拽回文首）。
   */
  const scrollTopRef = useRef(0);
  /** 轮询用的回调放进 ref：App 每次渲染都会传新的箭头函数，直接进 deps 会不断重启轮询。 */
  const statRef = useRef(statFile);
  statRef.current = statFile;
  /**
   * 轮询用「先 stat 后读」的两段式回调（App 注入）：返回是否真的发生了内容变化。
   *
   * 为什么不让轮询直接调 `onReload`：编辑器「保存但没改内容」也会更新 mtime，
   * 一次无条件重读会把整篇文档重新解析 + 重排版（主线程同步操作）白做一遍，
   * 长文档上就是一次肉眼可见的卡顿。这里先在 App 侧比较读取结果，只有真的变了才换引用。
   */
  const reloadIfChangedRef = useRef(onReloadIfChanged);
  reloadIfChangedRef.current = onReloadIfChanged;
  /**
   * 「跟随」的基线：`文档路径（小写） → 上次确认内容变化的 mtime/size`。
   *
   * 放在 ref 里是为了活过 effect 重建（理由见轮询那一段的注释）。按路径索引，
   * 这样在同一份文档上重启 effect 会接着比，换文档则重新采样。条目很少（每个 tab 一条），
   * 不需要淘汰策略。
   */
  const followBaselineRef = useRef<Map<string, { mtimeMs: number; size: number }>>(new Map());

  const outline = rendered?.outline ?? [];
  // 短文档展开大纲只会挤占正文（门槛见 OUTLINE_MIN_HEADINGS）；用户手动选择后不再自动改。
  const outlineOpen =
    outlinePref === "auto" ? outline.length >= OUTLINE_MIN_HEADINGS : outlinePref === "open";

  // ---- 渲染：解析 + 公式 + 高亮 + 清洗（清洗在 sanitizeHtml 里，见 src/markdown/） ----
  useEffect(() => {
    if (!doc) {
      setRendered(null);
      return;
    }
    let cancelled = false;
    setRendered(null);
    // 先让「渲染中…」画出来再做重活：长文档的解析 + 公式排版是同步的，
    // 直接在 effect 里跑会把这一帧一起卡住，用户看到的是「点了没反应」。
    const timer = setTimeout(() => {
      if (cancelled) {
        return;
      }
      setRendered(renderMarkdown(doc.text, { sanitize: sanitizeHtml, docPath: path }));
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [doc, path]);

  // 大纲折叠/展开与宽度都是「用户偏好」：写进 localStorage，下次打开任何文档都沿用。
  const toggleOutline = useCallback((open: boolean) => {
    setOutlinePref(open ? "open" : "closed");
    writePref(OUTLINE_KEY, open ? "open" : "closed");
  }, []);

  const changeWidth = useCallback((value: number) => {
    const clamped = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(value)));
    setBodyWidth(clamped);
    writePref(WIDTH_KEY, String(clamped));
  }, []);

  const toggleFollow = useCallback((next: boolean) => {
    setFollow(next);
    writePref(FOLLOW_KEY, next ? "1" : "0");
  }, []);

  // ---- 正文 DOM：先恢复原始 HTML，再按当前查询打标记、接上图片 ----
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) {
      return;
    }
    const keepScroll = scrollTopRef.current;
    if (mode === "preview") {
      body.innerHTML = rendered?.html ?? "";
      for (const chip of body.querySelectorAll<HTMLElement>(".md-image")) {
        // 悬停提示与图片地址都属于「运行环境才知道的东西」：管线是纯函数、不带 locale、
        // 也拿不到 Tauri API，所以统一在挂载后补。
        chip.title = t.imageHint(chip.dataset.mdSrc ?? "");
        const img = chip.querySelector<HTMLImageElement>("img.md-image-img");
        const file = img?.dataset.mdPath;
        if (!img || !file) {
          continue; // 远程图片 / 非图片文件：保持占位符
        }
        // 加载成功 → 只显示图片；失败（文件不在、或不在 asset scope 授权目录内）→
        // 退回「图标 + 路径」的占位样式，比一个破图标有用。
        img.addEventListener("load", () => { chip.dataset.mdState = "loaded"; }, { once: true });
        img.addEventListener("error", () => { chip.dataset.mdState = "missing"; img.remove(); }, { once: true });
        img.src = toAssetUrl(file);
      }
      marksRef.current =
        rendered && find.query ? wrapMatches(body, find.query, find.caseSensitive) : [];
    } else {
      // 源码视图不参与页内查找（查找的是预览正文），清掉标记状态避免计数残留。
      marksRef.current = [];
    }
    if (scrollRef.current) {
      scrollRef.current.scrollTop = keepScroll;
    }
    scrollTopRef.current = keepScroll;
    setFind((prev) => {
      const count = marksRef.current.length;
      const index = count === 0 ? -1 : Math.min(prev.index < 0 ? 0 : prev.index, count - 1);
      return prev.count === count && prev.index === index ? prev : { ...prev, count, index };
    });
  }, [rendered, find.query, find.caseSensitive, mode, t, toAssetUrl]);

  // ---- 阅读位置：滚动时按比例记录，换文档后恢复一次 ----
  //
  // 记比例而不是像素：用户可能改了正文宽度或字号（甚至换了窗口大小），像素值会指到别处。
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) {
      return;
    }
    let frame = 0;
    let pending = false;
    const flush = () => {
      frame = 0;
      const max = scroller.scrollHeight - scroller.clientHeight;
      writeScrollRatio(path, max > 0 ? scroller.scrollTop / max : 0);
      pending = false;
    };
    const onScroll = () => {
      pending = true;
      scrollTopRef.current = scroller.scrollTop; // 见 scrollTopRef 的注释
      if (frame === 0) {
        frame = requestAnimationFrame(flush);
      }
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame !== 0) {
        cancelAnimationFrame(frame);
      }
      // 卸载 / 换文档前把最后一次位置落盘（滚动节流可能还没跑到）
      if (pending) {
        const max = scroller.scrollHeight - scroller.clientHeight;
        writeScrollRatio(path, max > 0 ? scroller.scrollTop / max : 0);
      }
    };
  }, [path]);

  // 渲染完成后恢复一次位置。自动刷新会换掉 `rendered`（同一 path），此时**不**恢复，
  // 让 DOM effect 保住当前 scrollTop —— 边看边改的文档不该把视线拽回去。
  useEffect(() => {
    if (!rendered || mode !== "preview" || !doc) {
      return;
    }
    if (restoredPathRef.current === path) {
      return;
    }
    restoredPathRef.current = path;
    // 跨文档带锚点打开的：位置交给锚点，别再做恢复
    if (initialAnchor) {
      return;
    }
    const scroller = scrollRef.current;
    if (!scroller) {
      return;
    }
    const ratio = readScrollRatio(path);
    if (ratio == null) {
      return;
    }
    const max = scroller.scrollHeight - scroller.clientHeight;
    if (max > 0) {
      const top = ratio * max;
      scroller.scrollTop = top;
      scrollTopRef.current = top;
    }
  }, [rendered, mode, doc, path, initialAnchor]);

  // ---- 跨文档锚点：`other.md#sec` 打开的 tab 落位到指定小节 ----
  useEffect(() => {
    if (!initialAnchor || !rendered || mode !== "preview") {
      return;
    }
    const target = bodyRef.current?.querySelector<HTMLElement>(`[id="${CSS.escape(initialAnchor)}"]`);
    if (target && scrollRef.current) {
      scrollWithin(scrollRef.current, target);
    }
    // data 属性只为可观测性（E2E 断言「锚点是否真的被处理过」，以及处理了哪个）；
    // 目标不存在也照样消费掉，否则每次重渲染都会重试。
    if (scrollRef.current) {
      scrollRef.current.dataset.mdAnchorHandled = initialAnchor;
    }
    onAnchorConsumed();
  }, [initialAnchor, rendered, mode, onAnchorConsumed]);

  // ---- 跟随文件变化：轮询 mtime/size，变了就重读（内容确实变了才重排版） ----
  //
  // 为什么轮询而不是 fs watcher：编辑器普遍「写临时文件再 rename」地原子保存，
  // watcher 要正确处理得盯父目录 + 处理重命名（tail.rs 为日志做过一遍）；
  // 而这里关心的只是「内容变了没」，1.5s 的 stat 足够便宜，也天然扛住原子保存。
  //
  // 基线放在 ref 里（按文档路径索引）而不是 effect 的局部变量：这个 effect 的依赖里有
  // `doc`，而「文件真的变了」正好会让 `doc` 换引用 → effect 重建 → 局部基线被清空 →
  // 下一次 stat 被当成「首次采样」而不再触发刷新（实测到的连环失效）。
  // 基线只在**内容确实变了**之后前移，因此对「mtime 变了但文本逐字相同」的文件，
  // 最坏情况是每次轮询都多读一遍文件，而不会白做一次重解析 + 重排版。
  useEffect(() => {
    if (!active || !follow || !doc) {
      return;
    }
    let cancelled = false;
    let timer = 0;
    const key = path.toLowerCase();
    const tick = async () => {
      try {
        const stat = await statRef.current(path);
        if (cancelled) {
          return;
        }        const baseline = followBaselineRef.current.get(key) ?? null;
        if (!baseline) {
          followBaselineRef.current.set(key, stat);
        } else if (stat.mtimeMs !== baseline.mtimeMs || stat.size !== baseline.size) {
          // 可观测性（E2E / 冒烟脚本断言「轮询确实触发了重读」）
          if (scrollRef.current) {
            scrollRef.current.dataset.mdAutoRefresh = String(stat.mtimeMs);
          }
          // 「变了」只是 mtime 变了：内容是否真的不同由 App 侧逐字比较后才知道。
          // 逐字相同（编辑器空保存 / 只改了行尾）时不换引用、不重排版，只闪一下提示。
          const changed = await reloadIfChangedRef.current();
          if (cancelled) {
            return;
          }
          if (changed) {
            followBaselineRef.current.set(key, stat);
          }
          setJustRefreshed(changed);
          setJustUnchanged(!changed);
        }
      } catch {
        /* 读不到（编辑器正在原子保存 / 文件被临时占用）：等下一轮，不打扰用户 */
      }
      if (!cancelled) {
        timer = window.setTimeout(tick, FOLLOW_POLL_MS);
      }
    };
    timer = window.setTimeout(tick, FOLLOW_POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, follow, doc, path]);

  /**
   * 自动刷新的瞬时提示自动复位（「已刷新」/「无变化」只闪一下）。
   *
   * 复位计时器单独挂在这里、而不是写在轮询里：轮询 effect 的依赖里有 `doc`，
   * 一旦内容真的变了它就会重建，写在里面的 timeout 会被清理掉 —— 结果就是
   * 「已刷新」永远留在按钮上（这是实测到的现象，不是理论风险）。
   */
  useEffect(() => {
    if (!justRefreshed && !justUnchanged) {
      return;
    }
    const timer = window.setTimeout(() => {
      setJustRefreshed(false);
      setJustUnchanged(false);
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [justRefreshed, justUnchanged]);

  // 命中高亮：当前命中加粗描边并滚进视野。
  useEffect(() => {
    const marks = marksRef.current;
    marks.forEach((mark, i) => mark.classList.toggle("md-hit-current", i === find.index));
    const current = find.index >= 0 ? marks[find.index] : null;
    // 命中可能在长文档深处：这里**保留平滑滚动**（查找是「顺着看下去」的动作，
    // 闪一下就到会让人丢失上下文），落点用容器相对计算再夹进范围。
    if (current && scrollRef.current) {
      const scroller = scrollRef.current;
      const delta = current.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      const max = scroller.scrollHeight - scroller.clientHeight;
      const top = Math.min(Math.max(scroller.scrollTop + delta - scroller.clientHeight / 3, 0), Math.max(max, 0));
      scroller.scrollTo({ top, behavior: "smooth" });
    }
  }, [find.index, find.count, find.query, find.caseSensitive, mode]);

  /** 跳到某个标题（滚动定位）。 */
  const scrollToHeading = useCallback((id: string) => {
    const scroller = scrollRef.current;
    const target = bodyRef.current?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
    if (scroller && target) {
      scrollWithin(scroller, target);
    }
  }, []);

  /**
   * 跳到某个标题（大纲点击 / `#锚点` 链接共用）。
   *
   * 源码视图下正文还没渲染，直接滚会找不到目标 —— 先切回预览，等渲染完再跳
   * （见 pendingHeading 的 effect）。这样大纲在两种视图下都能用，切换也不闪。
   */
  const goHeading = useCallback(
    (id: string) => {
      if (mode === "preview") {
        scrollToHeading(id);
      } else {
        setMode("preview");
        setPendingHeading(id);
      }
    },
    [mode, scrollToHeading]
  );

  useEffect(() => {
    if (!pendingHeading || mode !== "preview" || !rendered) {
      return;
    }
    scrollToHeading(pendingHeading);
    setPendingHeading(null);
  }, [pendingHeading, mode, rendered, scrollToHeading]);

  // ---- 滚动联动大纲高亮（rAF 节流，避免滚动时每像素都算） ----
  useEffect(() => {
    const scroller = scrollRef.current;
    const body = bodyRef.current;
    if (!scroller || !body || !outlineOpen || mode !== "preview") {
      return;
    }
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = scroller.getBoundingClientRect().top + 8;
      let current = "";
      for (const heading of outline) {
        const el = body.querySelector<HTMLElement>(`[id="${CSS.escape(heading.id)}"]`);
        if (el && el.getBoundingClientRect().top <= top) {
          current = heading.id;
        }
      }
      setActiveHeading((prev) => (prev === current ? prev : current));
    };
    const onScroll = () => {
      if (frame === 0) {
        frame = requestAnimationFrame(update);
      }
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame !== 0) {
        cancelAnimationFrame(frame);
      }
    };
  }, [outline, outlineOpen, mode]);

  // ---- 页内查找：Ctrl+F 打开；Ctrl+E 在预览/源码之间切换 ----
  const openFind = useCallback(() => {
    setMode("preview");
    setFind((prev) => ({ ...prev, open: true }));
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, []);

  /**
   * 预览 ⇄ 源码（Ctrl+E）。
   *
   * 为什么不做成「Ctrl+E 打开查找」之类的组合：VSCode 里 Ctrl+E 是「打开文件」，
   * 在文档阅读场景里最像它的操作就是「换一种呈现方式看同一篇」——切到源码看原始
   * 写法、再切回预览看排版，是读技术文档时最频繁的一次往返。
   */
  const toggleMode = useCallback(() => {
    setMode((prev) => (prev === "preview" ? "source" : "preview"));
  }, []);

  useEffect(() => {
    if (!active) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      const key = e.key.toLowerCase();
      if (key === "f") {
        e.preventDefault();
        openFind();
      } else if (key === "e") {
        e.preventDefault();
        toggleMode();
      } else if (e.key === "Escape" && find.open) {
        setFind(FIND_CLOSED);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, find.open, openFind, toggleMode]);

  /** 上一个 / 下一个命中（循环）。 */
  const stepFind = useCallback(
    (delta: number) => {
      setFind((prev) => {
        if (prev.count === 0) {
          return prev;
        }
        const next = (prev.index + delta + prev.count) % prev.count;
        return { ...prev, index: next };
      });
    },
    []
  );

  // 公共生命周期：激活时注册「复制当前视图」（复制 Markdown 原文）与行数。
  const copySource = useCallback(async () => doc?.text ?? "", [doc]);
  useBodyViewEffects(props, { copy: doc ? copySource : null, total: rendered?.lines ?? null });

  // ---- 正文里的点击：链接分流 / 图片占位打开（必须拦住默认行为） ----
  //
  // Tauri 的 WebView 一旦被导航走就回不来了（退格键、外链、锚点都会），
  // 所以正文里**所有** `<a>` 的默认行为都在这里被吃掉，再由我们决定去哪。
  const onBodyClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const element = e.target as HTMLElement | null;
      if (!element) {
        return;
      }
      const image = element.closest<HTMLElement>(".md-image");
      if (image) {
        e.preventDefault();
        const src = image.dataset.mdSrc;
        if (src) {
          (image.dataset.mdKind === "url" ? onOpenUrl : onOpenLocal)(src);
        }
        return;
      }
      const anchor = element.closest<HTMLAnchorElement>("a");
      if (!anchor) {
        return;
      }
      e.preventDefault();
      // 脚注的角标与回跳箭头：目标是同一篇里的一个 `<li>` / `<sup>`，滚动过去
      // 再闪一下高亮 —— 否则读者会看不到「刚才跳到了哪一行」。
      const footnoteTarget =
        anchor.dataset.mdFootnote ?? anchor.dataset.mdFootnoteRef ?? null;
      if (footnoteTarget) {
        const domId = anchor.dataset.mdFootnote
          ? `footnote-${footnoteTarget}`
          : `footnote-ref-${footnoteTarget}`;
        const target = bodyRef.current?.querySelector<HTMLElement>(`[id="${CSS.escape(domId)}"]`);
        if (target && scrollRef.current) {
          scrollWithin(scrollRef.current, target, 24);
          flashFootnote(target);
        }
        return;
      }
      const href = anchor.getAttribute("href") ?? "";
      const anchorId = anchor.dataset.mdAnchor ?? (href.startsWith("#") ? hashOf(href) : "");
      // 标题上的 `¶` 复制锚点链接：把完整 URL 写进剪贴板，而不是滚动（点了几乎不动，
      // 用户要的是「把这一节的链接发给别人」）。
      if (anchor.dataset.mdAnchor && anchor.classList.contains("md-anchor")) {
        void copyTextToClipboard(`${location.href.split("#")[0]}#${anchor.dataset.mdAnchor}`);
        setAnchorCopied(true);
        window.setTimeout(() => setAnchorCopied(false), 1200);
        return;
      }
      if (anchorId) {
        scrollToHeading(anchorId);
        return;
      }
      if (anchor.dataset.mdExternal) {
        onOpenUrl(href);
        return;
      }
      const target = anchor.dataset.mdPath;
      if (target) {
        if (anchor.dataset.mdKind === "doc") {
          // `other.md#sec`：把锚点一起带过去（新 tab 落位到那一节）
          onOpenDoc(target, anchor.dataset.mdFrag || undefined);
        } else {
          onOpenLocal(target);
        }
      }
    },
    [onOpenDoc, onOpenLocal, onOpenUrl, scrollToHeading]
  );

  // ---- 失败 / 读取中 / 空文档：都用正文区中央的一行说明，不堆按钮 ----

  if (error) {
    return (
      <div className="md-tab">
        <div className="md-toolbar">
          <ViewToggleButton title={t.toggleTitle} onClick={props.onSwitchViewMode} />
          <span className="md-name" title={path}>
            {path.split(/[\\/]/).pop() || path}
          </span>
          <span className="md-actions">
            <button className="md-btn" onClick={onReload}>
              {t.retry}
            </button>
          </span>
        </div>
        <div className="md-error" title={error}>
          {/* 标题给「这是什么错误」，下面一行是后端原文：Tauri 的报错常带
              `os error 5` 这类系统措辞，没有标题时读者不知道该看哪一部分。 */}
          <p className="md-error-title">{t.errorTitle}</p>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="md-tab">
      <div className="md-toolbar">
        <ViewToggleButton title={t.toggleTitle} onClick={props.onSwitchViewMode} />
        <span className="md-name" title={path}>
          {path.split(/[\\/]/).pop() || path}
        </span>
        {doc ? <span className="md-size">{formatSize(doc.bytes)}</span> : null}
        <span className="md-mode-switch" role="group">
          <button
            className={`md-mode${mode === "preview" ? " on" : ""}`}
            onClick={() => setMode("preview")}
            aria-pressed={mode === "preview"}
            title={`${t.preview}（${t.modeToggleHint}）`}
          >
            {t.preview}
          </button>
          <button
            className={`md-mode${mode === "source" ? " on" : ""}`}
            onClick={() => {
              setMode("source");
              setFind(FIND_CLOSED);
            }}
            aria-pressed={mode === "source"}
            title={`${t.source}（${t.modeToggleHint}）`}
          >
            {t.source}
          </button>
        </span>
        <span className="md-actions">
          <button
            className={`md-btn${outlineOpen ? " on" : ""}`}
            onClick={() => toggleOutline(!outlineOpen)}
            aria-pressed={outlineOpen}
            title={outlineOpen ? t.outlineCollapse : t.outlineExpand}
            disabled={outline.length === 0}
          >
            {t.outline}
          </button>
          <button className="md-btn" onClick={openFind} title={t.find} disabled={mode === "source"}>
            {t.find}
          </button>
          <button className="md-btn" onClick={onReload} title={t.refresh}>
            {t.refresh}
          </button>
        </span>
        {/* 跟随文件变化：开着时外部编辑会自动进来；刚刷新过 / 内容没变时按钮旁闪一下提示 */}
        <button
          className={`md-btn${follow ? " on" : ""}`}
          onClick={() => toggleFollow(!follow)}
          aria-pressed={follow}
          title={t.followHint}
        >
          {follow && justRefreshed ? t.refreshed : follow && justUnchanged ? t.followIdle : t.follow}
        </button>
        {/* 正文宽度：滑块（方向键 = 1% 步进）+ 数值；点数值回默认值。 */}
        <span className="md-width">
          <span className="md-width-label">{t.width}</span>
          <input
            className="md-width-range"
            type="range"
            min={WIDTH_MIN}
            max={WIDTH_MAX}
            step={1}
            value={bodyWidth}
            aria-label={`${t.width} (%)`}
            title={t.widthHint}
            onChange={(e) => changeWidth(Number(e.target.value))}
          />
          <button
            className="md-width-value"
            onClick={() => changeWidth(WIDTH_DEFAULT)}
            title={t.widthReset}
          >
            {bodyWidth}%
          </button>
        </span>
      </div>

      {doc?.truncated ? (
        <div className="md-banner" title={t.truncated(formatSize(doc.bytes))}>
          {t.truncated(formatSize(doc.bytes))}
        </div>
      ) : null}

      <div className="md-main">
        {/* 大纲在正文**左侧**：视线从左上进入，先看到目录再看到正文。
            折叠后只留一条竖轨（一个「还回得去」的入口，不必回工具栏找按钮）。 */}
        {outline.length > 0 ? (
          outlineOpen ? (
            <aside className="md-outline" aria-label={t.outline}>
              <div className="md-outline-head">
                <span className="md-outline-title">{t.outline}</span>
                <button
                  className="md-outline-collapse"
                  onClick={() => toggleOutline(false)}
                  title={t.outlineCollapse}
                  aria-label={t.outlineCollapse}
                >
                  «
                </button>
              </div>
              <div className="md-outline-list">
                {outline.map((heading: MdHeading) => (
                  <button
                    key={heading.id}
                    className={`md-outline-item${heading.id === activeHeading ? " current" : ""}`}
                    style={{ paddingLeft: `${8 + (heading.depth - 1) * 12}px` }}
                    onClick={() => goHeading(heading.id)}
                    title={heading.text}
                  >
                    {heading.text}
                  </button>
                ))}
              </div>
            </aside>
          ) : (
            /* 折叠后留一条竖轨（整条可点）：比只在工具栏留按钮更容易回到大纲 */
            <button
              className="md-outline-rail"
              onClick={() => toggleOutline(true)}
              title={t.outlineExpand}
              aria-label={t.outlineExpand}
              aria-expanded={false}
            >
              <span className="md-outline-rail-icon">»</span>
              <span className="md-outline-rail-label">{t.outline}</span>
            </button>
          )
        ) : null}

        {/* 正文区与查找框分开两层：查找框绝对定位在正文区右上角（不随正文滚动），
            左侧的大纲也不会被盖住。 */}
        <div className="md-content">
          <div
            className="md-scroll"
            ref={scrollRef}
            style={{ "--log-font-size": `${fontSize}px` } as React.CSSProperties}
          >
            {/* 文档列：宽度 = 用户设置的百分比（预览与源码共用，切换时不跳变） */}
            <div className="md-column" style={{ width: `${bodyWidth}%` }}>
              {!doc ? (
                <div className="md-notice">{t.loading}</div>
              ) : mode === "source" ? (
                <pre className="md-source">{doc.text}</pre>
              ) : !rendered ? (
                <div className="md-notice">{t.rendering}</div>
              ) : rendered.html.trim() === "" ? (
                <div className="md-notice">{t.empty}</div>
              ) : (
                <div className="md-body" ref={bodyRef} onClick={onBodyClick} />
              )}
            </div>
          </div>

          {/* 复制锚点的瞬时反馈：这个动作没有别的可见结果，没提示等于没发生 */}
          {anchorCopied ? <div className="md-copied" role="status">{t.anchorCopied}</div> : null}

          {find.open && mode === "preview" ? (            <div className="md-find" role="dialog" aria-label={t.find}>
              <input
                ref={findInputRef}
                className="md-find-input"
                value={find.query}
                placeholder={t.findPlaceholder}
                onChange={(e) => setFind((prev) => ({ ...prev, query: e.target.value, index: 0 }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    stepFind(e.shiftKey ? -1 : 1);
                  } else if (e.key === "Escape") {
                    setFind(FIND_CLOSED);
                  }
                }}
              />
              <span className="md-find-count">
                {find.count === 0 ? "0/0" : `${find.index + 1}/${find.count}`}
              </span>
              <button
                className={`md-find-case${find.caseSensitive ? " on" : ""}`}
                onClick={() => setFind((prev) => ({ ...prev, caseSensitive: !prev.caseSensitive, index: 0 }))}
                aria-pressed={find.caseSensitive}
                title={t.findCase}
              >
                Aa
              </button>
              <button className="md-find-btn" onClick={() => stepFind(-1)} title={t.findPrev}>
                ↑
              </button>
              <button className="md-find-btn" onClick={() => stepFind(1)} title={t.findNext}>
                ↓
              </button>
              <button
                className="md-find-btn"
                onClick={() => setFind(FIND_CLOSED)}
                title={t.findClose}
              >
                ✕
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
