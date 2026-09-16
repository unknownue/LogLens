// e2e-markdown.mjs — 用真实浏览器（Edge/Chrome + CDP）验收 Markdown 预览页。
//
// 为什么必须跑真浏览器：这一页有三件事只在浏览器里成立，
//   1. **清洗**（DOMPurify）在无 DOM 的 Node 里根本不可用（`isSupported === false`），
//      单测只能验「清洗被调用了」，验不了「注入真的被挡住了」；
//   2. **KaTeX 排版**要真实布局（`.katex` 有非零高度）才算渲染成功，Node 里只能验标记；
//   3. 交互（大纲跳转、页内查找、链接分流、Ctrl+F、视图模式往返）全都要真实事件。
//
// 用法：
//   1) pnpm run dev                    # Vite dev server（127.0.0.1:5173）
//   2) node tools/e2e-markdown.mjs --launch
//      （--launch 自己拉起无头 Edge 并在结束时关掉；也可先手动起浏览器再省略该参数）
//   node tools/e2e-markdown.mjs --launch --theme light --shot %TEMP%\loglens-md
//
// 覆盖场景见下方 PHASE1/2/3 的注释；所有断言最后统一汇总（失败不中断）。

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ==================== 测试数据 ====================

const MD = "E:\\Work\\docs\\guide\\index.md";
const MD_NEXT = "E:\\Work\\docs\\guide\\ch2.md";
const MD_MISSING = "E:\\Work\\docs\\gone\\deleted.md";
const MD_DENIED = "E:\\Work\\docs\\denied\\secret.md";
const MD_TRUNCATED = "E:\\Work\\docs\\guide\\huge.md";
const VERSION = "0.0.0-e2e";
const WAIT_MS = Number(process.env.E2E_WAIT_MS ?? 450);

/**
 * 样例文档。刻意包含：
 * - GFM 表格 / 任务列表 / 删除线；
 * - 公式的四种写法（`$…$`、`$$…$$`、`\(…\)`、`\[…\]`）与**不该**被当成公式的价格；
 * - 代码块（可识别语言 + 未知语言）；
 * - 相对链接 / 外链 / 锚点链接 / 相对图片；
 * - 一段注入尝试（script / style / onerror / javascript: URL / iframe）。
 *
 * 用数组拼字符串（而不是模板字符串）：正文里的代码围栏就是反引号，
 * 直接写在模板里会把外层的模板字面量截断。
 */
const DOC_LINES = [
  "# LogLens 文档样例",
  "",
  "普通段落，含中文紧贴的行内公式 $p$ 与价格 $5 到 $10。",
  "",
  "## 表格",
  "",
  "| 名称 | 数值 | 说明 |",
  "| --- | ---: | :---: |",
  "| 生命 | 100 | 满血 |",
  "| 魔法 | 50 | 半血 |",
  "",
  "## 公式",
  "",
  "块级公式：",
  "",
  "$$",
  "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}",
  "$$",
  "",
  "行内 LaTeX 写法 \\(a^2 + b^2 = c^2\\) 也要能渲染。",
  "",
  "\\[",
  "E = mc^2",
  "\\]",
  "",
  "## 代码",
  "",
  "```python",
  "def f(x):",
  "    return x + 1",
  "```",
  "",
  "```not-a-real-lang",
  "<b>原样转义</b>",
  "```",
  "",
  "## 任务",
  "",
  "- [x] 已完成",
  "- [ ] 未完成",
  "",
  "## 链接与图片",
  "",
  "[下一章](./ch2.md) 与 [官网](https://example.com/docs) 与 [回到表格](#表格)",
  "",
  "[带锚点跳到下一章的「任务」一节](./ch2.md#任务)",
  "",
  "[带锚点打开一个还没打开过的文档](./ch3.md#任务)",
  "",
  "![架构图](imgs/arch.png)",
  "",
  "## 注入尝试",
  "",
  "<script>window.__e2eXss = 1</script>",
  "<style>body { display: none !important }</style>",
  '<img src="x" onerror="window.__e2eXss = 2">',
  '<a href="javascript:window.__e2eXss=3">点我看会不会出事</a>',
  '<iframe src="https://example.com"></iframe>',
  "",
  "## 脚注",
  "",
  "正文里的脚注写法[^a]，以及**第二次引用**[^a]，还有另一条[^b]，以及一条带注入的[^evil]。",
  "",
  "[^a]: 第一条脚注，带 `code` 与 [外链](https://example.com/fn)。",
  "[^b]: 第二条脚注。",
  '[^evil]: <style>body{display:none}</style> 注入尝试 <script>window.__e2eXssFootnote = 1</script>',
  "",
].join("\n");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const PORT = Number(arg("port", "9222"));
const URL = arg("url", "http://127.0.0.1:5173/");
const SHOULD_LAUNCH = argv.includes("--launch");
const SHOT_DIR = arg("shot", null);
const THEME = arg("theme", "dark");
const EDGE =
  arg("browser", null) ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ==================== 注入页面的 mock 后端 ====================
//
// 只实现被断言流程用到的命令（真实后端见 src-tauri/src/lib.rs 与 document.rs）：
// 关键是 read_text_file 对「不存在」「无权限」抛出与后端一致的原文字样，
// 这样正文页的错误分流（file-missing / md 页内错误面板）走的才是真实路径。

const buildInitScript = () => `
(() => {
  const MD = ${JSON.stringify(MD)};
  const MD_NEXT = ${JSON.stringify(MD_NEXT)};
  const MD_MISSING = ${JSON.stringify(MD_MISSING)};
  const MD_DENIED = ${JSON.stringify(MD_DENIED)};
  const MD_TRUNCATED = ${JSON.stringify(MD_TRUNCATED)};
  const DOC = ${JSON.stringify(DOC_LINES)};
  const VERSION = ${JSON.stringify(VERSION)};

  // 上次会话：**故意不写 modes**，验证「老存档按扩展名推断」这条路
  // （Markdown 文件恢复后应直接进预览，而不是掉回文本视图）。
  localStorage.setItem("lv-tabs", JSON.stringify({ paths: [MD], active: 0 }));
  localStorage.setItem("lv-lang", "zh");
  localStorage.setItem("lv-theme", ${JSON.stringify(THEME)});

  window.__e2eClipboard = null;
  Object.defineProperty(Object.getPrototypeOf(navigator), "clipboard", {
    configurable: true,
    get: () => ({ writeText: async (t) => { window.__e2eClipboard = t; } }),
  });

  const tabs = new Map();
  const eventHandlers = new Map();
  /** 当前「读不到」的路径：断言里可以移除某一项，模拟文件被恢复。 */
  window.__e2eGone = [MD_MISSING];
  window.__e2eDenied = [MD_DENIED];
  /** 所有 invoke 调用与 opener 调用（断言链接/图片分流用）。 */
  window.__e2eCalls = [];
  window.__e2eOpener = [];
  /** 最近一次 read_text_file 的入参（断言前端传了 maxBytes 上限）。 */
  window.__e2eReadArgs = null;

  const linesFor = (path) => [
    { file_offset: 1, file_line: 1, text: "[INFO] loaded " + path },
    { file_offset: 2, file_line: 2, text: "[WARN] sample line 2" },
    { file_offset: 3, file_line: 3, text: "[ERROR] sample line 3" },
  ];

  function emit(event, payload) {
    const id = eventHandlers.get(event);
    if (id == null) return;
    const fn = window["_" + id];
    if (typeof fn === "function") setTimeout(() => fn({ event, payload }), 0);
  }

  async function invoke(cmd, args = {}) {
    args = args || {};
    window.__e2eCalls.push(cmd);
    switch (cmd) {
      case "read_text_file": {
        window.__e2eReadArgs = args;
        window.__e2eReadCalls = (window.__e2eReadCalls ?? 0) + 1;
        if (window.__e2eGone.includes(args.path)) throw "文件不存在: " + args.path;
        if (window.__e2eDenied.includes(args.path)) throw "读取失败: 拒绝访问。 (os error 5)";
        // 自动刷新用例会改写 __e2eDocText 模拟「文件被外部编辑」
        const text = window.__e2eDocText ?? DOC;
        return { text, bytes: text.length, truncated: args.path === MD_TRUNCATED };
      }
      case "stat_text_file": {
        window.__e2eStatCalls = (window.__e2eStatCalls ?? 0) + 1;
        if (window.__e2eGone.includes(args.path)) throw "文件不存在: " + args.path;
        // 默认与「当前正文」保持一致：真实文件里 size 就是内容的字节数，
        // 假 fixture 若给一个与内容无关的 size，自动刷新会读到一个自相矛盾的快照。
        const current = window.__e2eDocText ?? DOC;
        return window.__e2eStat ?? { mtimeMs: 1000, size: current.length };
      }
      case "open_log_file": {
        if (window.__e2eGone.includes(args.path)) throw "文件不存在: " + args.path;
        if (window.__e2eDenied.includes(args.path)) throw "读取失败: 拒绝访问。 (os error 5)";
        const lines = linesFor(args.path);
        tabs.set(args.tabId, { path: args.path, lines });
        emit("log-lines", {
          tab_id: args.tabId, lines, reset: true, total_lines: lines.length, avg_line_len: 20,
        });
        return null;
      }
      case "get_lines": {
        const t = tabs.get(args.tabId);
        return t ? t.lines : [];
      }
      case "get_total_lines": {
        const t = tabs.get(args.tabId);
        return t ? t.lines.length : 0;
      }
      case "get_range": {
        const t = tabs.get(args.tabId);
        if (!t) return [];
        const start = args.startLine ?? args.start_line ?? 1;
        return t.lines.slice(start - 1, start - 1 + (args.count ?? 0));
      }
      case "get_block_avg_lens":
        return [20];
      case "load_history":
        return { lines: [], has_more: false };
      case "set_filter": {
        const t = tabs.get(args.tabId);
        return t ? t.lines : [];
      }
      case "search_lines":
        return { hits: [], complete: true, scope_total: 0 };
      case "close_tab":
        tabs.delete(args.tabId);
        return null;
      case "plugin:dialog|open":
        return null;
      case "plugin:opener|reveal_item_in_dir":
        window.__e2eOpener.push({ kind: "reveal", path: (args.paths || [])[0] ?? null });
        return null;
      case "plugin:opener|open_url":
        window.__e2eOpener.push({ kind: "url", path: args.url ?? null });
        return null;
      case "plugin:app|version":
        return VERSION;
      case "plugin:event|listen": {
        const ev = args.event || args.target;
        if (ev) eventHandlers.set(ev, args.handler);
        return 1;
      }
      case "plugin:event|unlisten":
        return null;
      case "get_startup_paths":
        return [];
      case "toggle_always_on_top":
        return false;
      default:
        return null;
    }
  }

  window.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: (callback, once) => {
      const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      const prop = "_" + id;
      Object.defineProperty(window, prop, {
        value: (result) => {
          if (once) delete window[prop];
          return callback && callback(result);
        },
        writable: false,
        configurable: true,
      });
      return id;
    },
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main", windowLabel: "main" },
    },
    convertFileSrc: (filePath, protocol) => protocol + "://localhost/" + filePath,
  };
  window.isTauri = true;
})();
`;

// ==================== 页面内断言脚本 ====================

/** 各阶段共用的小工具（每个阶段自带一份，不依赖上一阶段的副作用）。 */
const HELPERS = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const panels = () => [...document.querySelectorAll(".tab-panel")];
  const visiblePanel = () => panels().find((p) => p.getBoundingClientRect().height > 0);
  const view = () => visiblePanel()?.querySelector(".body-view")?.dataset.view ?? null;
  const body = () => visiblePanel()?.querySelector(".md-body") ?? null;
  const text = (sel) => visiblePanel()?.querySelector(sel)?.textContent?.trim() ?? null;
  const all = (sel) => [...(visiblePanel()?.querySelectorAll(sel) ?? [])];
  const tabCount = () => document.querySelectorAll(".tabbar .tab").length;
  const click = async (el, wait = ${WAIT_MS}) => { el.click(); await sleep(wait); };
  const btn = (label) => all(".md-btn").find((b) => b.textContent.trim() === label) ?? null;
  const modeBtn = (label) => all(".md-mode").find((b) => b.textContent.trim() === label) ?? null;
  /** 往 React 受控 input 里写值（必须走原生 setter，否则 onChange 收不到）。 */
  const type = async (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(300);
  };
  const katexBoxes = () => all(".katex").map((el) => el.getBoundingClientRect());
`;

// ---------- 阶段 1：会话恢复 + 自动识别 + 渲染 ----------

const PHASE1 = `
(async () => {
  ${HELPERS}
  const obs = [];
  const fails = [];
  const check = (cond, msg) => { if (!cond) fails.push(msg); };
  const push = (k, v) => obs.push(k.padEnd(34) + " = " + JSON.stringify(v));

  const MD = ${JSON.stringify(MD)};

  try {
    // ---------- 1. 老存档（无 modes）恢复：.md 应自动进 Markdown 预览 ----------
    push("view", view());
    push("tab title", document.querySelector(".tabbar .tab-title")?.textContent);
    check(view() === "md-view", "会话恢复的 .md 文件应自动进 Markdown 预览，实际 " + view());
    check(
      window.__e2eReadArgs && window.__e2eReadArgs.path === MD,
      "应向 read_text_file 传文档路径，实际 " + JSON.stringify(window.__e2eReadArgs)
    );
    check(
      typeof window.__e2eReadArgs?.maxBytes === "number" && window.__e2eReadArgs.maxBytes > 0,
      "应显式传 maxBytes 上限（整篇解析不能无上限），实际 " + JSON.stringify(window.__e2eReadArgs?.maxBytes)
    );

    // 等渲染完成（懒加载 chunk + 解析）
    for (let i = 0; i < 40 && !body(); i++) await sleep(150);
    check(!!body(), "应渲染出 .md-body（懒加载 chunk 与解析都要成功）");
    if (!body()) {
      obs.push("");
      obs.push(fails.length ? "PHASE1 FAILED " + fails.length + ":" : "PHASE1 ALL PASSED");
      fails.forEach((f) => obs.push("  - " + f));
      return obs.join("\\n");
    }

    // ---------- 2. GFM：标题 / 表格 / 任务列表 / 删除线 ----------
    push("h1", body().querySelector("h1")?.textContent);
    push("table rows", body().querySelectorAll("tbody tr").length);
    push("right-aligned th", body().querySelector('th[align="right"]')?.getAttribute("align"));
    push("checkboxes", all(".md-body input[type=checkbox]").length);
    check(body().querySelector("h1")?.textContent.startsWith("LogLens 文档样例"), "应渲染一级标题");
    check(body().querySelectorAll("tbody tr").length === 2, "表格应有 2 行数据");
    check(!!body().querySelector('th[align="right"]'), "列对齐（align 属性）应保留");
    const boxes = all(".md-body input[type=checkbox]");
    check(boxes.length === 2, "任务列表应有两个勾选框，实际 " + boxes.length);
    check(boxes[0]?.checked === true && boxes[1]?.checked === false, "勾选状态应与源码一致");

    // ---------- 3. 公式：四种写法 + 真实排版高度 ----------
    const boxes_ = katexBoxes();
    push("katex count", boxes_.length);
    push("katex display", all(".katex-display").length);
    push("first katex height", Math.round(boxes_[0]?.height ?? 0));
    check(boxes_.length >= 4, "四种写法都应渲染成 .katex，实际 " + boxes_.length);
    check(all(".katex-display").length >= 2, "两个块级公式都应进入 display 模式");
    check(
      boxes_.every((b) => b.height > 4 && b.width > 2),
      "公式必须有真实排版尺寸（高度全为 0 说明 CSS/字体没加载成功）"
    );

    // ---------- 4. 价格不能被当成公式 ----------
    //
    // 注意判据要落在「哪个片段被当成公式」上：同一段落里合法的 $p$ 本来就会渲染成
    // .katex，只看「段落里有没有 .katex」会误报。KaTeX 的 <annotation> 里存着公式源码，
    // 直接断言没有任何公式的源码是价格片段。
    const formulas = all(".md-body .katex annotation").map((a) => a.textContent ?? "");
    const priceP = [...body().querySelectorAll("p")].find((p) => p.textContent.includes("价格"));
    push("formula sources", formulas);
    push("price text", priceP?.textContent);
    check(
      !!priceP && priceP.textContent.includes("$5 到 $10"),
      "「价格 $5 到 $10」应作为普通文本保留"
    );
    check(
      !formulas.some((f) => f.includes("5 到") || f.trim() === "5"),
      "价格片段不能被当成公式渲染，实际公式源码 " + JSON.stringify(formulas)
    );

    // ---------- 5. 代码高亮：识别语言才着色，未知语言保持转义 ----------
    push("hljs code blocks", all(".md-body pre.md-pre code").length);
    push("keyword spans", all(".md-body .hljs-keyword").length);
    push("unknown-lang escaped", !!body().textContent.includes("<b>原样转义</b>"));
    check(all(".md-body pre.md-pre code").length === 2, "应有两个代码块");
    check(all(".md-body .hljs-keyword").length > 0, "python 代码块应被高亮（出现 hljs-keyword）");
    check(
      !all(".md-body pre.md-pre")[1]?.innerHTML.includes("<b>"),
      "未识别语言的代码块必须转义，不能把 <b> 放出来"
    );

    // ---------- 6. 图片容器与降级 ----------
    //
    // 两个容器：一个来自 Markdown 图片语法（.png → 真的去加载），一个来自原始 HTML 的
    // img 标签（src="x" 无图片后缀 → 只保留占位，顺带把 onerror 一起丢掉）。
    // 浏览器里**没有 asset 协议**（mock 的 convertFileSrc 给的是 asset://…），
    // 图片必然加载失败 → 容器退回「图标 + 路径」的占位样式，这正好验证了降级路径。
    const chips = all(".md-body .md-image");
    push("md-image chips", chips.length);
    push("chip states", chips.map((c) => c.dataset.mdState ?? "(pending)"));
    push("chip srcs", chips.map((c) => c.dataset.mdSrc));
    check(chips.length === 2, "两个图片写法都应变成容器，实际 " + chips.length);
    check(
      chips[0]?.dataset.mdState === "missing" && !chips[0].querySelector("img"),
      "asset 协议不可用时应退回占位样式（这是真实环境里图片丢失时的同一条路径），实际 " +
        chips[0]?.dataset.mdState
    );
    check(!!chips[0]?.querySelector(".md-image-src"), "降级后要保留路径文本供排查");
    check(
      chips[0]?.dataset.mdSrc === "E:\\\\Work\\\\docs\\\\guide\\\\imgs\\\\arch.png",
      "容器应带按文档目录解析出的绝对路径，实际 " + chips[0]?.dataset.mdSrc
    );
    check(
      chips[1]?.dataset.mdSrc === "E:\\\\Work\\\\docs\\\\guide\\\\x",
      "原始 HTML 的 <img> 也要按文档目录解析，实际 " + chips[1]?.dataset.mdSrc
    );

    // ---------- 7. 清洗：注入尝试全部失效 ----------
    push("script tags in body", body().querySelectorAll("script").length);
    push("style tags in body", body().querySelectorAll("style").length);
    push("iframe/object in body", body().querySelectorAll("iframe,object,embed").length);
    push("onerror attrs", body().querySelectorAll("[onerror]").length);
    push("javascript: hrefs", all(".md-body a").filter((a) => (a.getAttribute("href") || "").startsWith("javascript:")).length);
    push("xss flag", window.__e2eXss ?? null);
    push("app visible", getComputedStyle(document.querySelector(".loglens, #root")).display);
    check(body().querySelectorAll("script,style,iframe,object,embed").length === 0, "危险标签必须被清洗掉");
    check(body().querySelectorAll("[onerror]").length === 0, "事件属性必须被清洗掉");
    check(
      all(".md-body a").every((a) => !(a.getAttribute("href") || "").startsWith("javascript:")),
      "javascript: 链接必须被清洗掉"
    );
    check(window.__e2eXss === undefined, "注入脚本不能被执行（window.__e2eXss 应为 undefined）");
    check(
      getComputedStyle(document.querySelector(".loglens, #root")).display !== "none",
      "文档里的 <style> 不能把应用藏起来（应被整条丢弃）"
    );

    // ---------- 8. 大纲：默认展开（标题数 ≥ 3）且条目与标题一一对应 ----------
    push("outline items", all(".md-outline-item").length);
    push("heading count", all(".md-body h1, .md-body h2").length);
    check(all(".md-outline-item").length === all(".md-body h1, .md-body h2").length,
      "大纲条目数应等于标题数，实际 " + all(".md-outline-item").length);
    check(all(".md-outline-item")[0]?.textContent.trim() === "LogLens 文档样例", "大纲首项应是文档标题");

    // ---------- 9. 文本视图的 DOM 不应存在（页面是互斥的） ----------
    push("log rows", all(".row").length);
    check(all(".row").length === 0, "Markdown 页面不应渲染日志行");
  } catch (e) {
    fails.push("phase1 threw: " + (e && e.message ? e.message : String(e)));
  }

  obs.push("");
  obs.push(fails.length ? "PHASE1 FAILED " + fails.length + ":" : "PHASE1 ALL PASSED");
  fails.forEach((f) => obs.push("  - " + f));
  return obs.join("\\n");
})()
`;

// ---------- 阶段 2：页内交互（查找 / 大纲 / 链接 / 图片 / 源码） ----------

const PHASE2 = `
(async () => {
  ${HELPERS}
  const obs = [];
  const fails = [];
  const check = (cond, msg) => { if (!cond) fails.push(msg); };
  const push = (k, v) => obs.push(k.padEnd(34) + " = " + JSON.stringify(v));

  const MD_NEXT = ${JSON.stringify(MD_NEXT)};

  try {
    const scroller = visiblePanel().querySelector(".md-scroll");
    window.__e2eOpener.length = 0;

    // ---------- 1. Ctrl+F 打开查找框 + 命中计数 ----------
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
    await sleep(300);
    const input = visiblePanel().querySelector(".md-find-input");
    push("find opened by ctrl+f", !!input);
    check(!!input, "Ctrl+F 应打开页内查找框（文本页的 Ctrl+F 此时不应抢）");

    await type(input, "生命");
    const count = text(".md-find-count");
    push("find count (生命)", count);
    push("marks", all(".md-body mark.md-hit").length);
    check(all(".md-body mark.md-hit").length === 1, "「生命」应命中 1 处（表格里）");
    check(count === "1/1", "计数应显示 1/1，实际 " + count);

    await type(input, "公式");
    push("find count (公式)", text(".md-find-count"));
    push("marks (公式)", all(".md-body mark.md-hit").length);
    check(all(".md-body mark.md-hit").length >= 2, "「公式」应命中标题与正文多处");

    // 按 Enter 循环到下一个命中
    const before = visiblePanel().querySelector(".md-body mark.md-hit-current")?.textContent;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await sleep(250);
    const after = visiblePanel().querySelector(".md-body mark.md-hit-current")?.textContent;
    push("current mark before/after enter", [before, after]);
    check(!!after, "Enter 应选中当前命中（有 md-hit-current 标记）");

    // Esc 关闭查找并清掉标记
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(300);
    push("marks after esc", all(".md-body mark.md-hit").length);
    push("find closed", !visiblePanel().querySelector(".md-find-input"));
    check(all(".md-body mark.md-hit").length === 0, "关闭查找后应清掉所有命中标记");
    check(!visiblePanel().querySelector(".md-find-input"), "Esc 应关闭查找框");

    // ---------- 2. 大纲跳转 ----------
    scroller.scrollTop = 0;
    await sleep(150);
    const tableItem = all(".md-outline-item").find((b) => b.textContent.trim() === "表格");
    await click(tableItem, 700);
    push("scrollTop after outline click", Math.round(scroller.scrollTop));
    check(scroller.scrollTop > 50, "点大纲「表格」应把正文滚下去，实际 scrollTop=" + scroller.scrollTop);
    check(
      !!all(".md-outline-item").find((b) => b.classList.contains("current")),
      "滚动后大纲应高亮当前章节"
    );

    // ---------- 3. 外部链接：交给系统浏览器（绝不能把 WebView 导航走） ----------
    scroller.scrollTop = 0;
    await sleep(200);
    const external = all(".md-body a").find((a) => a.dataset.mdExternal);
    await click(external, 400);
    push("opener calls after external link", window.__e2eOpener);
    push("page url", location.href.startsWith("http://127.0.0.1:5173"));
    check(
      window.__e2eOpener.some((c) => c.kind === "url" && c.path === "https://example.com/docs"),
      "外链应调用 open_url，实际 " + JSON.stringify(window.__e2eOpener)
    );
    check(location.pathname === "/" || location.href.includes("127.0.0.1:5173"), "WebView 不应被导航走");

    // ---------- 4. 锚点链接：同一篇内滚动，不开新 tab ----------
    //
    // 注意要挑正文里的那个锚点链接，而不是标题上自动生成的「复制锚点」小图标
    // （那个指向的是本节标题，点了几乎不动，会测出假阴性）。
    const tabsBefore = tabCount();
    const anchor = all(".md-body a").find((a) => a.textContent.trim() === "回到表格");
    await click(anchor, 900);
    push("tabs after anchor", tabsBefore + " -> " + tabCount());
    push("scrollTop after anchor", Math.round(scroller.scrollTop));
    check(tabCount() === tabsBefore, "锚点链接不应新开 tab");
    check(scroller.scrollTop > 50, "锚点链接应滚动到对应标题，实际 scrollTop=" + scroller.scrollTop);

    // ---------- 5. 图片占位：点击在资源管理器中定位 ----------
    window.__e2eOpener.length = 0;
    await click(all(".md-body .md-image")[0], 400);
    push("opener calls after image click", window.__e2eOpener);
    check(
      window.__e2eOpener.some((c) => c.kind === "reveal" && c.path === "E:\\\\Work\\\\docs\\\\guide\\\\imgs\\\\arch.png"),
      "点图片占位符应在资源管理器中定位绝对路径，实际 " + JSON.stringify(window.__e2eOpener)
    );

    // ---------- 6. 相对链接指向的 .md：在同应用新开一个预览 tab ----------
    const beforeDoc = tabCount();
    const docLink = all(".md-body a").find((a) => a.dataset.mdKind === "doc");
    await click(docLink, 900);
    push("view after doc link", view());
    push("tabs after doc link", beforeDoc + " -> " + tabCount());
    check(tabCount() === beforeDoc + 1, "点相对 .md 链接应新开一个 tab");
    check(view() === "md-view", "新 tab 也应自动是 Markdown 预览，实际 " + view());
    check(
      document.querySelectorAll(".tabbar .tab")[tabCount() - 1]?.textContent.includes("ch2.md"),
      "新 tab 应是链接指向的文件：" + document.querySelectorAll(".tabbar .tab")[tabCount() - 1]?.textContent
    );

    // 回到第一个 tab，继续后面的断言
    document.querySelectorAll(".tabbar .tab")[0].click();
    await sleep(400);

    // ---------- 7. 源码视图：显示 Markdown 原文 ----------
    await click(modeBtn("源码"), 400);
    push("source shown", !!visiblePanel().querySelector(".md-source"));
    push("source starts with h1", visiblePanel().querySelector(".md-source")?.textContent.slice(0, 20));
    check(!!visiblePanel().querySelector(".md-source"), "切到源码应显示 <pre class=md-source>");
    check(
      visiblePanel().querySelector(".md-source")?.textContent.includes("| 名称 | 数值 | 说明 |"),
      "源码视图应展示原始 Markdown（含表格源码）"
    );
    await click(modeBtn("预览"), 500);
    push("preview restored", !!body());
    check(!!body(), "切回预览应重新渲染正文");
  } catch (e) {
    fails.push("phase2 threw: " + (e && e.message ? e.message : String(e)));
  }

  obs.push("");
  obs.push(fails.length ? "PHASE2 FAILED " + fails.length + ":" : "PHASE2 ALL PASSED");
  fails.forEach((f) => obs.push("  - " + f));
  return obs.join("\\n");
})()
`;

// ---------- 阶段 2B：脚注 / 快捷键 / 复制锚点（新增能力的验收） ----------

const PHASE2B = `
(async () => {
  ${HELPERS}
  const obs = [];
  const fails = [];
  const check = (cond, msg) => { if (!cond) fails.push(msg); };
  const push = (k, v) => obs.push(k.padEnd(34) + " = " + JSON.stringify(v));

  try {
    // 回到第一个 tab（Markdown 预览）并确保处于预览态
    document.querySelectorAll(".tabbar .tab")[0].click();
    await sleep(700);
    const scroller = visiblePanel().querySelector(".md-scroll");
    scroller.style.scrollBehavior = "auto";

    // ---------- 1. 脚注：按首次引用编号、同一条只出现一次、定义行不留正文 ----------
    const refs = all(".md-body .md-footnote-ref a");
    const items = all(".md-body .md-footnotes li");
    push("footnote refs", refs.map((a) => a.textContent.trim()));
    push("footnote items", items.map((li) => li.id));
    push("footnote count", refs.length + "/" + items.length);
    check(refs.length === 4, "样例里有 4 处脚注引用，实际 " + refs.length);
    check(items.length === 3, "三条定义各产生一个条目，实际 " + items.length);
    check(
      refs.map((a) => a.textContent.trim()).join("") === "1123",
      "编号按首次引用顺序（甲=1、乙=2、注入条=3，第二次引用甲仍是 1），实际 " +
        refs.map((a) => a.textContent.trim()).join("")
    );
    check(
      !body().textContent.includes("[^a]:"),
      "定义行不应出现在正文里"
    );
    // 脚注区同样要过清洗：定义正文是**文档作者写的**，写一段带 <style> 的定义若绕过
    // sanitize 就足以把整个界面藏起来（此前正是拼在 sanitize 之后，已修）。
    const evilTags = body().querySelectorAll(".md-footnotes style, .md-footnotes script, .md-footnotes iframe");
    push("injected tags in footnotes", evilTags.length);
    push("footnote xss flag", window.__e2eXssFootnote ?? null);
    check(evilTags.length === 0, "脚注区里的危险标签必须被清洗掉，实际 " + evilTags.length);
    check(window.__e2eXssFootnote === undefined, "脚注里的注入脚本不能执行");
    check(
      getComputedStyle(document.querySelector(".loglens, #root")).display !== "none",
      "脚注里的 <style> 不能把应用藏起来"
    );
    check(
      !!body().querySelector(".md-footnotes code") &&
        !!body().querySelector(".md-footnotes .md-external, .md-footnotes [data-md-external]"),
      "脚注正文里的行内代码与外链照常渲染"
    );
    const firstRef = body().querySelector("#footnote-ref-a");
    check(!!firstRef && firstRef.getAttribute("href") === "#footnote-a", "角标要带可分享的锚点");

    // ---------- 2. 点角标跳到条目，再点回跳箭头回到引用处 ----------
    const anchorTarget = document.querySelector("#footnote-a");
    check(!!anchorTarget, "条目应有 footnote-a 这个 id");
    await click(firstRef, 900);
    const itemBox = anchorTarget.getBoundingClientRect();
    const scrollBox = scroller.getBoundingClientRect();
    push("item top vs scrollport", [Math.round(itemBox.top - scrollBox.top), Math.round(scrollBox.height)]);
    push("flash class applied", anchorTarget.className);
    check(
      itemBox.top - scrollBox.top > -8 && itemBox.top - scrollBox.top < scrollBox.height,
      "点角标应把对应条目滚进视野"
    );
    check(/md-flash/.test(anchorTarget.className), "跳转目标应有一闪而过的高亮（md-flash）");

    const back = anchorTarget.querySelector(".md-footnote-back");
    await click(back, 900);
    const refBox = body().querySelector("#footnote-ref-a").getBoundingClientRect();
    const refTop = refBox.top - scroller.getBoundingClientRect().top;
    push("ref top after back", Math.round(refTop));
    // 与跨文档锚点同样的判据：脚注区在文末，滚到底也贴不住顶部时只要求「进了视口」。
    const backReached =
      Math.round(scroller.scrollTop) >= scroller.scrollHeight - scroller.clientHeight - 2
        ? refTop > -8 && refTop < scroller.clientHeight * 0.9
        : Math.abs(refTop) < 60;
    push("back reached", backReached);
    check(backReached, "点回跳箭头应回到引用处，实际偏移 " + Math.round(refTop));

    // ---------- 3. Ctrl+E 在预览与源码之间切换 ----------
    const key = (k) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, ctrlKey: true, bubbles: true }));
    key("e");
    await sleep(400);
    push("after ctrl+e", !!visiblePanel().querySelector(".md-source"));
    check(!!visiblePanel().querySelector(".md-source"), "Ctrl+E 应切到源码视图");
    key("e");
    await sleep(700);
    for (let i = 0; i < 30 && !body(); i++) await sleep(150);
    push("after second ctrl+e", !!body());
    check(!!body(), "再按一次 Ctrl+E 应切回预览");
    check(scroller.scrollTop > 0, "切换往返不该把阅读位置丢回文首");

    // ---------- 4. 点标题的复制锚点：链接进剪贴板 + 瞬时提示 ----------
    window.__e2eClipboard = null;
    const copyAnchor = all(".md-body .md-anchor").find((a) => a.dataset.mdAnchor === "表格");
    push("copy anchor found", !!copyAnchor);
    await click(copyAnchor, 400);
    push("clipboard after copy anchor", window.__e2eClipboard);
    push("copied toast", text(".md-copied"));
    check(
      typeof window.__e2eClipboard === "string" && window.__e2eClipboard.endsWith("#表格"),
      "点 ¶ 应把带锚点的完整链接写进剪贴板，实际 " + JSON.stringify(window.__e2eClipboard)
    );
    check(text(".md-copied") !== null, "复制后应有「链接已复制」提示");

    // 收尾：把位置放回文首，避免影响后续阶段对滚动的判断
    scroller.scrollTop = 0;
    await sleep(200);
  } catch (e) {
    fails.push("phase2b threw: " + (e && e.message ? e.message : String(e)));
  }

  obs.push("");
  obs.push(fails.length ? "PHASE2B FAILED " + fails.length + ":" : "PHASE2B ALL PASSED");
  fails.forEach((f) => obs.push("  - " + f));
  return obs.join("\\n");
})()
`;

// ---------- 阶段 3：视图模式往返 + 失败与截断路径 ----------

const PHASE3 = `
(async () => {
  ${HELPERS}
  const obs = [];
  const fails = [];
  const check = (cond, msg) => { if (!cond) fails.push(msg); };
  const push = (k, v) => obs.push(k.padEnd(34) + " = " + JSON.stringify(v));

  const MD_MISSING = ${JSON.stringify(MD_MISSING)};
  const MD_DENIED = ${JSON.stringify(MD_DENIED)};
  const MD_TRUNCATED = ${JSON.stringify(MD_TRUNCATED)};
  const MD = ${JSON.stringify(MD)};

  try {
    // ---------- 1. 切到文本视图：Markdown tab 从没开过 tail 会话，必须补一次 ----------
    await click(visiblePanel().querySelector(".view-toggle"), 400);
    const textItem = [...document.querySelectorAll(".viewmode-item")]
      .find((b) => b.textContent.includes("文本视图"));
    await click(textItem, 1200);
    push("view after switch to text", view());
    push("log rows after switch", all(".row").length);
    check(view() === "text-log", "应切到文本视图，实际 " + view());
    check(
      all(".row").length === 3,
      "切回文本视图应补开 tail 会话并显示 3 行日志（否则是空正文），实际 " + all(".row").length
    );

    // ---------- 2. 再切回 Markdown：模式切换要双向可用 ----------
    await click(visiblePanel().querySelector(".view-toggle"), 400);
    const mdItem = [...document.querySelectorAll(".viewmode-item")]
      .find((b) => b.textContent.includes("Markdown 预览"));
    await click(mdItem, 1200);
    for (let i = 0; i < 30 && !body(); i++) await sleep(150);
    push("view after switch back", view());
    push("re-rendered table rows", body()?.querySelectorAll("tbody tr").length);
    check(view() === "md-view", "应切回 Markdown 预览，实际 " + view());
    check(
      body()?.querySelectorAll("tbody tr").length === 2,
      "切回后应重新渲染（表格 2 行）"
    );
    push("persisted modes", JSON.parse(localStorage.getItem("lv-tabs") || "{}").modes);

    // ---------- 3. 大文件截断：横幅提示，而不是假装全文 ----------
    window.__lvOpenPath(MD_TRUNCATED);
    await sleep(1200);
    push("truncated view", view());
    push("banner", text(".md-banner"));
    check(view() === "md-view", "截断的文件仍应能预览");
    check(
      (text(".md-banner") ?? "").includes("超过预览上限"),
      "应显示截断横幅，实际 " + JSON.stringify(text(".md-banner"))
    );

    // ---------- 4. 读取失败：留在 Markdown 页并给「重试」 ----------
    window.__lvOpenPath(MD_DENIED);
    await sleep(1200);
    push("denied view", view());
    push("denied error", text(".md-error p.md-error-title") + " / " + text(".md-error p:not(.md-error-title)"));
    const retry = all(".md-btn").find((b) => b.textContent.trim() === "重试");
    push("retry button", !!retry);
    check(view() === "md-view", "读取失败应留在 Markdown 页（那里才有重试），实际 " + view());
    check(
      (text(".md-error p:not(.md-error-title)") ?? "").includes("拒绝访问"),
      "错误面板应展示后端原文"
    );
    check(
      text(".md-error p.md-error-title") === "读取失败",
      "错误面板应有标题（后端原文常带 os error 之类措辞，没有标题读者不知道看哪儿）"
    );
    check(!!retry, "失败面板必须有「重试」按钮（页面自带的重读入口）");

    // 修好权限后点重试 → 直接出内容
    window.__e2eDenied = window.__e2eDenied.filter((p) => p !== MD_DENIED);
    await click(retry, 1200);
    for (let i = 0; i < 30 && !body(); i++) await sleep(150);
    push("view after retry", view());
    push("table rows after retry", body()?.querySelectorAll("tbody tr").length);
    check(!!body() && body().querySelectorAll("tbody tr").length === 2, "重试成功后应渲染出正文");

    // ---------- 5. 文件不存在：交给框架的「文件不存在」页，恢复后自动回来 ----------
    window.__lvOpenPath(MD_MISSING);
    await sleep(1200);
    push("missing view", view());
    push("missing line", text(".notice-line"));
    check(view() === "file-missing", "文件不存在时应走状态页，实际 " + view());
    check(
      text(".notice-line") === "文件不存在：" + MD_MISSING,
      "状态页应给出完整路径，实际 " + JSON.stringify(text(".notice-line"))
    );

    window.__e2eGone = window.__e2eGone.filter((p) => p !== MD_MISSING);
    window.__lvOpenPath(MD_MISSING);
    await sleep(1400);
    for (let i = 0; i < 30 && !body(); i++) await sleep(150);
    push("view after restore", view());
    check(view() === "md-view", "文件恢复后应自动回到 Markdown 预览，实际 " + view());
    check(!!body(), "恢复后应渲染出正文");

    // ---------- 6. 原 tab 仍在且仍是预览（没有被上面的流程弄坏） ----------
    document.querySelectorAll(".tabbar .tab")[0].click();
    await sleep(600);
    push("first tab view", view());
    check(view() === "md-view", "回到第一个 tab 应仍是 Markdown 预览");
    push("total lines label", document.querySelector(".total-lines")?.textContent);
  } catch (e) {
    fails.push("phase3 threw: " + (e && e.message ? e.message : String(e)));
  }

  obs.push("");
  obs.push(fails.length ? "PHASE3 FAILED " + fails.length + ":" : "PHASE3 ALL PASSED");
  fails.forEach((f) => obs.push("  - " + f));
  return obs.join("\\n");
})()
`;

// ---------- 阶段 4：大纲位置与折叠 / 正文宽度 / 深色滚动条 ----------

const PHASE4 = `
(async () => {
  ${HELPERS}
  const obs = [];
  const fails = [];
  const check = (cond, msg) => { if (!cond) fails.push(msg); };
  const push = (k, v) => obs.push(k.padEnd(34) + " = " + JSON.stringify(v));

  try {
    // 回到第一个 tab（Markdown 预览）并把滚动位置归零
    document.querySelectorAll(".tabbar .tab")[0].click();
    await sleep(700);
    const scroller = visiblePanel().querySelector(".md-scroll");
    scroller.style.scrollBehavior = "auto";
    scroller.scrollTop = 0;
    await sleep(200);

    // ---------- 1. 大纲在正文左侧 ----------
    const start = performance.now();
    while (!visiblePanel().querySelector(".md-outline") && performance.now() - start < 5000) {
      await sleep(150);
    }
    const outline = visiblePanel().querySelector(".md-outline");
    const content = visiblePanel().querySelector(".md-content");
    push("outline right edge", Math.round(outline.getBoundingClientRect().right));
    push("content left edge", Math.round(content.getBoundingClientRect().left));
    check(
      outline.getBoundingClientRect().right <= content.getBoundingClientRect().left + 1,
      "大纲应位于正文左侧（大纲右边缘 ≤ 正文左边缘）"
    );

    // ---------- 2. 折叠：面板消失、竖轨出现、偏好落盘 ----------
    await click(visiblePanel().querySelector(".md-outline-collapse"), 400);
    push("panel after collapse", !!visiblePanel().querySelector(".md-outline"));
    push("rail after collapse", !!visiblePanel().querySelector(".md-outline-rail"));
    push("stored outline pref", localStorage.getItem("lv-md-outline"));
    check(!visiblePanel().querySelector(".md-outline"), "折叠后大纲面板应消失");
    check(!!visiblePanel().querySelector(".md-outline-rail"), "折叠后应留一条可点的竖轨");
    check(localStorage.getItem("lv-md-outline") === "closed", "折叠状态应持久化");
    // 折叠后正文可用宽度应变大（说明面板确实让位了）
    const wideAfterCollapse = visiblePanel().querySelector(".md-scroll").clientWidth;
    push("scroll width collapsed", wideAfterCollapse);

    // ---------- 3. 展开：点整条竖轨 ----------
    await click(visiblePanel().querySelector(".md-outline-rail"), 400);
    push("panel after expand", !!visiblePanel().querySelector(".md-outline"));
    push("stored outline pref after expand", localStorage.getItem("lv-md-outline"));
    check(!!visiblePanel().querySelector(".md-outline"), "点竖轨应重新展开大纲");
    check(!visiblePanel().querySelector(".md-outline-rail"), "展开后竖轨应消失");
    check(localStorage.getItem("lv-md-outline") === "open", "展开状态同样要持久化");
    const narrowAfterExpand = visiblePanel().querySelector(".md-scroll").clientWidth;
    push("scroll width expanded", narrowAfterExpand);
    check(wideAfterCollapse > narrowAfterExpand, "折叠大纲后正文可用宽度应变大");

    // ---------- 4. 源码视图下点大纲：切回预览并滚到目标 ----------
    await click(modeBtn("源码"), 400);
    // 用样例文档里靠后的一个标题（「任务」在第 5 节，跳过去必然产生明显滚动）
    const target = all(".md-outline-item").find((b) => b.textContent.trim() === "任务");
    push("outline item in source mode", !!target);
    check(!!target, "源码视图下大纲也应可用");
    await click(target, 1000);
    push("mode after outline click from source", !!visiblePanel().querySelector(".md-source"));
    push("scrollTop after jump", Math.round(scroller.scrollTop));
    check(!visiblePanel().querySelector(".md-source"), "源码视图点大纲应切回预览");
    check(scroller.scrollTop > 100, "并且滚动到目标标题，实际 scrollTop=" + scroller.scrollTop);

    // ---------- 5. 正文宽度：20–100%、1% 步进、按百分比生效、持久化 ----------
    const range = visiblePanel().querySelector(".md-width-range");
    push("range attrs", range ? [range.min, range.max, range.step] : null);
    check(!!range, "工具栏应有宽度滑块");
    check(
      range.min === "20" && range.max === "100" && range.step === "1",
      "滑块范围应是 20–100、步进 1%，实际 " + (range ? [range.min, range.max, range.step] : null)
    );

    await type(range, "55");
    const col = visiblePanel().querySelector(".md-column");
    const scroll = visiblePanel().querySelector(".md-scroll");
    const pct = (col.getBoundingClientRect().width / scroll.clientWidth) * 100;
    push("column width %", Number(pct.toFixed(1)));
    push("width label", text(".md-width-value"));
    push("stored width", localStorage.getItem("lv-md-width"));
    check(Math.abs(pct - 55) < 2, "列宽应约为可用宽度的 55%，实际 " + pct.toFixed(1) + "%");
    check(text(".md-width-value") === "55%", "数值标签应显示 55%");
    check(localStorage.getItem("lv-md-width") === "55", "宽度应持久化");

    // 1% 精度：连点范围键盘步进（模拟 ←/→）
    await type(range, "56");
    const pct56 = (visiblePanel().querySelector(".md-column").getBoundingClientRect().width / scroll.clientWidth) * 100;
    push("column width % after 56", Number(pct56.toFixed(1)));
    check(Math.abs(pct56 - 56) < 2, "56% 应生效（1% 精度）");
    check(Math.abs(pct56 - pct - 1) < 1.5, "55% → 56% 应只差约 1 个百分点");

    // 100% 应铺满可用宽度
    await type(range, "100");
    const pct100 = (visiblePanel().querySelector(".md-column").getBoundingClientRect().width / scroll.clientWidth) * 100;
    push("column width % at 100", Number(pct100.toFixed(1)));
    check(pct100 > 99, "100% 时应铺满可用宽度，实际 " + pct100.toFixed(1) + "%");

    // 点数值回默认
    await click(visiblePanel().querySelector(".md-width-value"), 400);
    push("label after reset", text(".md-width-value"));
    push("stored width after reset", localStorage.getItem("lv-md-width"));
    check(text(".md-width-value") === "70%" && localStorage.getItem("lv-md-width") === "70", "点数值应回默认 70%");

    // ---------- 6. 主题声明 color-scheme，原生滚动条不再跟着系统走 ----------
    // 断言的是「跟随主题」，不是写死 dark：浅色主题下同理必须是 light。
    const themeAttr = document.documentElement.getAttribute("data-theme");
    const expectedScheme = themeAttr === "light" ? "light" : "dark";
    push("data-theme", themeAttr);
    push("document color-scheme", getComputedStyle(document.documentElement).colorScheme);
    check(
      getComputedStyle(document.documentElement).colorScheme === expectedScheme,
      "color-scheme 必须跟随 data-theme（期望 " + expectedScheme + "，实际 " +
        getComputedStyle(document.documentElement).colorScheme + "）"
    );
    // 滚动条外观由 ::-webkit-scrollbar 规则绘制：确认这条规则真的进了样式表
    const hasRule = [...document.styleSheets].some((sheet) => {
      try {
        return [...sheet.cssRules].some((r) => (r.selectorText || "").includes("::-webkit-scrollbar"));
      } catch (e) {
        return false;
      }
    });
    push("webkit-scrollbar rule present", hasRule);
    check(hasRule, "样式表里应有 ::-webkit-scrollbar 规则（深色拇指、透明轨道）");
  } catch (e) {
    fails.push("phase4 threw: " + (e && e.message ? e.message : String(e)));
  }

  obs.push("");
  obs.push(fails.length ? "PHASE4 FAILED " + fails.length + ":" : "PHASE4 ALL PASSED");
  fails.forEach((f) => obs.push("  - " + f));
  return obs.join("\\n");
})()
`;

// ---------- 阶段 5A：跨文档锚点 + 阅读位置落盘（随后由 Node 侧刷新页面） ----------

const PHASE5A = `
(async () => {
  ${HELPERS}
  const obs = [];
  const fails = [];
  const check = (cond, msg) => { if (!cond) fails.push(msg); };
  const push = (k, v) => obs.push(k.padEnd(34) + " = " + JSON.stringify(v));

  const MD = ${JSON.stringify(MD)};

  try {
    document.querySelectorAll(".tabbar .tab")[0].click();
    await sleep(700);
    const scroller = visiblePanel().querySelector(".md-scroll");
    scroller.style.scrollBehavior = "auto";

    // ---------- 1. 跨文档锚点 ----------
    // 两条路径都要验：
    //   a) 目标文档**还没打开** → 新建 tab 并跳到锚点；
    //   b) 目标文档**已经打开**（PHASE2 点过 ch2.md）→ 复用该 tab 并跳到锚点。
    const before = tabCount();
    const fragLinks = all(".md-body a").filter((a) => a.dataset.mdFrag);
    push("frag links", fragLinks.map((a) => a.textContent.trim() + " -> #" + a.dataset.mdFrag));
    check(fragLinks.length >= 2, "fixture 里应有两处带锚点的跨文档链接，实际 " + fragLinks.length);

    const offsetOfTask = (scroller) => {
      const t = visiblePanel().querySelector('.md-body [id="任务"]');
      if (!t) return null;
      return Math.round(t.getBoundingClientRect().top - scroller.getBoundingClientRect().top);
    };

    // a) 新文档
    await click(fragLinks[1], 1600);
    const s1 = visiblePanel().querySelector(".md-scroll");
    const off1 = offsetOfTask(s1);
    push("new-doc tabs", before + " -> " + tabCount());
    push("new-doc view", view());
    push("new-doc scrollTop", Math.round(s1?.scrollTop ?? -1));
    push("new-doc anchor offset", off1);
    // 落点的判据分两种，取决于「目标更靠近文末还是文档更长」：
    //   - 目标在文档中部 → 必须贴住视口顶部（差 < 40px）；
    //   - 目标靠近文末（滚到底也够不着）→ 只要求它确实出现在视口内。
    // 这里做成数据驱动的断言，是因为「贴顶」在短文档里物理上不可能：
    // 示例文档总量不足两屏时，跳到最后一节必然只能停在容器底部。
    const reached = (s, off) => {
      const max = s.scrollHeight - s.clientHeight;
      if (off == null) return false;
      return Math.round(s.scrollTop) >= max - 2 ? off > -8 && off < s.clientHeight * 0.7 : Math.abs(off) < 40;
    };
    push("new-doc reached", reached(s1, off1));
    check(
      reached(s1, off1),
      "新文档应跳到锚点（中部贴顶；靠近文末时只要出现在视口内），实际 " + off1
    );
    check(tabCount() === before + 1, "打开没打开过的文档应新建 tab");
    check(view() === "md-view", "新 tab 应是 Markdown 预览");

    // b) 已打开的文档
    document.querySelectorAll(".tabbar .tab")[0].click();
    await sleep(600);
    const tabsBeforeB = tabCount();
    await click(all(".md-body a").find((a) => a.dataset.mdPath?.endsWith("ch2.md") && a.dataset.mdFrag), 1600);
    const s2 = visiblePanel().querySelector(".md-scroll");
    const off2 = offsetOfTask(s2);
    push("open-doc tabs", tabsBeforeB + " -> " + tabCount());
    push("open-doc scrollTop", Math.round(s2?.scrollTop ?? -1));
    push("open-doc anchor offset", off2);
    push("open-doc reached", reached(s2, off2));
    check(tabCount() === tabsBeforeB, "同一路径不应重复开 tab");
    check(reached(s2, off2), "已打开的文档应跳到锚点，实际 " + off2);

    // ---------- 2. 阅读位置：滚到中部，等落盘 ----------
    document.querySelectorAll(".tabbar .tab")[0].click();
    await sleep(600);
    const home = visiblePanel().querySelector(".md-scroll");
    home.style.scrollBehavior = "auto";
    const max = home.scrollHeight - home.clientHeight;
    home.scrollTop = Math.round(max * 0.5);
    await sleep(500); // 等 rAF 那次写入
    const stored = JSON.parse(localStorage.getItem("lv-md-scroll") || "{}");
    const ratio = stored[${JSON.stringify(MD)}.toLowerCase()] ?? null;
    push("scroll max", max);
    push("stored ratio", ratio);
    check(max > 200, "示例文档应足够长，能产生可测的滚动范围");
    check(ratio !== null && Math.abs(ratio - 0.5) < 0.05, "滚动比例应落盘（约 0.5），实际 " + ratio);
  } catch (e) {
    fails.push("phase5a threw: " + (e && e.message ? e.message : String(e)));
  }

  obs.push("");
  obs.push(fails.length ? "PHASE5A FAILED " + fails.length + ":" : "PHASE5A ALL PASSED");
  fails.forEach((f) => obs.push("  - " + f));
  return obs.join("\\n");
})()
`;

// ---------- 阶段 5B：刷新后恢复位置 + 自动刷新（跟随文件变化） ----------

const PHASE5B = `
(async () => {
  ${HELPERS}
  const obs = [];
  const fails = [];
  const check = (cond, msg) => { if (!cond) fails.push(msg); };
  const push = (k, v) => obs.push(k.padEnd(34) + " = " + JSON.stringify(v));

  const DOC = ${JSON.stringify(DOC_LINES)};

  try {
    for (let i = 0; i < 60 && !visiblePanel()?.querySelector(".md-body"); i++) await sleep(200);
    const scroller = visiblePanel().querySelector(".md-scroll");
    scroller.style.scrollBehavior = "auto";
    await sleep(600);

    // ---------- 1. 位置恢复：刷新页面后应回到上次的比例附近 ----------
    const max = scroller.scrollHeight - scroller.clientHeight;
    const ratio = max > 0 ? scroller.scrollTop / max : 0;
    push("restored ratio", Number(ratio.toFixed(3)));
    check(Math.abs(ratio - 0.5) < 0.08, "刷新后应恢复到约 50% 处，实际 " + ratio.toFixed(3));

    // ---------- 2. 自动刷新默认开启 ----------
    //
    // 「跟随」按钮是唯一带 aria-pressed 且文案在「跟随 / 已刷新 / 无变化」之间切换的按钮
    // （大纲按钮也有 aria-pressed，它的文案永远是「大纲」——按 .md-btn.on 取会选错）。
    const followBtn = all(".md-btn").find((b) => b.getAttribute("aria-pressed") !== null && /跟随|Follow/.test(b.textContent));
    const tickText = () => all(".md-btn").find((b) => b.getAttribute("aria-pressed") !== null && /跟随|Follow|已刷新|无变化|Updated|Unchanged/.test(b.textContent))?.textContent ?? "";
    push("follow button", followBtn ? followBtn.textContent.trim() : null);
    push("follow pressed", followBtn?.getAttribute("aria-pressed"));
    check(!!followBtn && followBtn.getAttribute("aria-pressed") === "true", "「跟随」应默认开启");

    // ---------- 3. 文件被外部修改 → 自动刷新，且不打断阅读位置 ----------
    const beforeScroll = scroller.scrollTop;
    const callsBefore = window.__e2eStatCalls ?? 0;
    window.__e2eDocText = DOC + "\\n\\n## 自动刷新小节\\n\\n这一段是外部编辑进来的。\\n";
    window.__e2eStat = { mtimeMs: 987654321, size: 1 };
    let appeared = false;
    for (let i = 0; i < 40 && !appeared; i++) {
      await sleep(300);
      appeared = !!visiblePanel()?.querySelector('.md-body [id="自动刷新小节"]');
    }
    push("stat polls", (window.__e2eStatCalls ?? 0) - callsBefore);
    push("auto-refresh marker", visiblePanel().querySelector(".md-scroll")?.dataset.mdAutoRefresh ?? null);
    push("read calls", window.__e2eReadCalls ?? 0);
    push("last read len", window.__e2eLastReadLen ?? null);
    push("auto-refresh picked up", appeared);
    push("scrollTop before/after", [Math.round(beforeScroll), Math.round(scroller.scrollTop)]);
    check(appeared, "外部修改后应自动出现新小节（轮询 mtime 触发重读）");
    check(
      Math.abs(scroller.scrollTop - beforeScroll) < 40,
      "自动刷新不该把阅读位置拽走，实际 " + Math.round(beforeScroll) + " -> " + Math.round(scroller.scrollTop)
    );

    // ---------- 3b. 「文件动了但内容没变」：不重读正文，只闪一下提示 ----------
    //
    // 场景：编辑器空保存（或只改了行尾）会更新 mtime，但正文逐字相同。
    // 此时应当既不重解析也不抖动阅读位置，只在「跟随」按钮上闪一下「无变化」。
    window.__e2eReadCalls = 0;
    const renderedBeforeTouch = visiblePanel().querySelectorAll(".md-body [id]").length;
    window.__e2eStat = { mtimeMs: 987654322, size: (window.__e2eDocText ?? DOC).length };
    let idleChip = null;
    for (let i = 0; i < 40 && !idleChip; i++) {
      await sleep(300);
      idleChip = /无变化|Unchanged/.test(tickText()) ? tickText().trim() : null;
    }
    push("unchanged chip", idleChip);
    push("read calls while touched", window.__e2eReadCalls);
    push("anchor count after touch", visiblePanel().querySelectorAll(".md-body [id]").length);
    check(!!idleChip, "内容未变时「跟随」按钮应闪一下「无变化」（而不是假装刷新过）");
    check(
      visiblePanel().querySelectorAll(".md-body [id]").length === renderedBeforeTouch,
      "内容未变时不应重建正文 DOM（否则白重排版一次）"
    );

    // ---------- 4. 关掉「跟随」后不再自动刷新 ----------
    await click(followBtn, 300);
    push("follow pressed after toggle", followBtn?.getAttribute("aria-pressed"));
    check(followBtn?.getAttribute("aria-pressed") === "false", "点一下应关掉跟随");
    window.__e2eDocText = DOC + "\\n\\n## 不该出现的小节\\n";
    window.__e2eStat = { mtimeMs: 111111111, size: 2 };
    await sleep(3500);
    const leaked = !!visiblePanel()?.querySelector('.md-body [id="不该出现的小节"]');
    push("refreshed while follow off", leaked);
    check(!leaked, "关掉跟随之后不应再自动刷新");

    // 收拾现场：恢复文档与跟随开关，避免影响后续人工查看
    await click(followBtn, 300);
    window.__e2eDocText = null;
    window.__e2eStat = null;
  } catch (e) {
    fails.push("phase5b threw: " + (e && e.message ? e.message : String(e)));
  }

  obs.push("");
  obs.push(fails.length ? "PHASE5B FAILED " + fails.length + ":" : "PHASE5B ALL PASSED");
  fails.forEach((f) => obs.push("  - " + f));
  return obs.join("\\n");
})()
`;

// ==================== CDP 客户端 ====================
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 1;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) {
          rej(new Error(JSON.stringify(msg.error)));
        } else {
          res(msg.result);
        }
      }
    });
    ws.addEventListener("error", () => reject(new Error("CDP websocket error")));
    ws.addEventListener("open", () => {
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const id = nextId++;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          }),
        close: () => ws.close(),
      });
    });
  });
}

/** 求值一个表达式并返回其值（awaitPromise，异常直接抛出）。 */
async function evaluate(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      "页面内异常: " + (r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails))
    );
  }
  return r.result.value;
}

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(250);
  }
  throw new Error(`等待超时：${what}`);
}

async function fetchTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

/** 导出当前页面截图（--shot 时才做）。 */
async function shoot(cdp, file) {
  if (!SHOT_DIR) {
    return;
  }
  mkdirSync(SHOT_DIR, { recursive: true });
  const r = await cdp.send("Page.captureScreenshot", { format: "png" });
  const out = join(SHOT_DIR, file);
  writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log("screenshot:", out);
}

/** 起一个无头浏览器（用完就关）。 */
function launchBrowser() {
  return spawn(
    EDGE,
    [
      "--headless=new",
      "--disable-gpu",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${process.env.TEMP ?? "."}\\loglens-e2e-md-profile`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: "ignore", detached: false }
  );
}

// ==================== 主流程 ====================

let browser = null;
let exitCode = 1;

try {
  if (SHOULD_LAUNCH) {
    browser = launchBrowser();
    await waitFor(async () => {
      try {
        await fetchTargets();
        return true;
      } catch {
        return false;
      }
    }, 20000, "无头浏览器 CDP 端口");
  }

  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:5173/`)).ok;
    } catch {
      return false;
    }
  }, 15000, "Vite dev server (127.0.0.1:5173)");

  // 预热 Vite 的按需转译缓存。
  //
  // 为什么需要：dev server 刚起来时，首次请求每个模块都要现转译（App / 懒加载的 md chunk /
  // 管线），冷启动那一次会让「等首屏」看起来像失败 —— 实测一次全阶段红，重跑即全绿，
  // 全是时序。这里先按真实路径把几个入口抓一遍，把它们塞进缓存再导航。
  for (const path of ["/src/main.tsx", "/src/App.tsx", "/src/views/MarkdownView.tsx", "/src/markdown/markdown.ts"]) {
    try {
      await fetch(`http://127.0.0.1:5173${path}`);
    } catch {
      /* 预热失败不影响主流程：真有问题会在下面的等待里暴露 */
    }
  }

  const targets = await fetchTargets();
  const page = targets.find((t) => t.type === "page");
  if (!page) {
    throw new Error("没有可用的 page target");
  }

  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: buildInitScript() });
  await cdp.send("Page.navigate", { url: URL });

  await waitFor(
    async () =>
      await evaluate(
        cdp,
        `!!document.querySelector(".body-view") && !!document.querySelector(".tabbar .tab")`
      ),
    20000,
    "LogLens 首屏"
  );
  await sleep(600);

  const phase1 = await evaluate(cdp, PHASE1);
  console.log("===== 会话恢复 → 自动识别 → 渲染（表格/公式/高亮/清洗） =====");
  console.log(phase1);
  await shoot(cdp, "01-markdown-preview.png");

  const phase2 = await evaluate(cdp, PHASE2);
  console.log("===== 页内交互（查找 / 大纲 / 链接分流 / 图片 / 源码） =====");
  console.log(phase2);
  await shoot(cdp, "02-markdown-interactions.png");

  const phase2b = await evaluate(cdp, PHASE2B);
  console.log("===== 脚注 / 快捷键 / 复制锚点 =====");
  console.log(phase2b);
  await shoot(cdp, "02b-footnotes.png");

  const phase3 = await evaluate(cdp, PHASE3);
  console.log("===== 视图模式往返 / 截断 / 读取失败 / 文件不存在 =====");
  console.log(phase3);
  await shoot(cdp, "03-markdown-failure-paths.png");

  const phase4 = await evaluate(cdp, PHASE4);
  console.log("===== 大纲位置与折叠 / 正文宽度 / 深色滚动条 =====");
  console.log(phase4);
  await shoot(cdp, "04-outline-and-width.png");

  const phase5a = await evaluate(cdp, PHASE5A);
  console.log("===== 跨文档锚点 / 阅读位置落盘 =====");
  console.log(phase5a);
  await shoot(cdp, "05-anchor-jump.png");

  // 刷新页面：验证阅读位置恢复（刷新必须在 Node 侧做，页面内 await 会被导航打断）
  //
  // 注意这段要能容忍「导航把正在跑的 evaluate 打断」：`Page.reload` 之后浏览器随时可能
  // 把当前执行上下文拆掉，此时 CDP 会回 `Inspected target navigated or closed`，
  // 属于**预期内的竞态**而不是失败。所以重试到「新文档确实就绪」为止。
  await waitFor(async () => {
    try {
      await cdp.send("Page.reload", { ignoreCache: false });
      await sleep(700);
      await evaluate(
        cdp,
        `(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          for (let i = 0; i < 80 && !document.querySelector(".tabbar .tab"); i++) await sleep(200);
          for (let i = 0; i < 80 && !document.querySelector(".md-body"); i++) await sleep(200);
          await sleep(800);
          return true;
        })()`
      );
      return true;
    } catch (e) {
      console.log("刷新页面重试（预期内的导航竞态）:", e?.message ?? e);
      await sleep(1000);
      return false;
    }
  }, 60000, "刷新后的页面就绪");

  const phase5b = await evaluate(cdp, PHASE5B);
  console.log("===== 位置恢复 / 自动刷新（跟随） =====");
  console.log(phase5b);
  await shoot(cdp, "06-auto-refresh.png");

  cdp.close();
  exitCode =
    /ALL PASSED/.test(phase1) &&
    /ALL PASSED/.test(phase2) &&
    /ALL PASSED/.test(phase2b) &&
    /ALL PASSED/.test(phase3) &&
    /ALL PASSED/.test(phase4) &&
    /ALL PASSED/.test(phase5a) &&
    /ALL PASSED/.test(phase5b)
      ? 0
      : 1;
} catch (e) {
  console.error("E2E 运行失败:", e?.stack ?? e);
} finally {
  if (browser) {
    browser.kill();
  }
}

process.exit(exitCode);
