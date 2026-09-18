// e2e-file-missing.mjs — 用真实浏览器（Edge/Chrome + CDP）验收正文区的多页面框架。
//
// 为什么需要它：单元测试只能覆盖纯规则（页面选择 / 错误分类，见
// tools/verify-body-views.test.mjs），而「打开历史记录里已不存在的文件时，正文区
// 是不是真的显示了那一行提示、切 tab / 重新打开会不会卡在错误态」属于端到端行为，
// 必须跑起来看。
//
// 做法：用 CDP 在页面脚本之前注入一份 mock 的 Tauri 后端（repro/mock-tauri.js 的
// 自动化版本），再驱动真实交互，断言 DOM。
//
// 用法：
//   1) pnpm run dev                    # Vite dev server（127.0.0.1:5173）
//   2) node tools/e2e-file-missing.mjs --launch
//      （--launch 会自己拉起无头 Edge 并在结束时关掉；也可以先手动起浏览器
//        再省略该参数，用 --port 指定 CDP 端口）
//
// 覆盖的场景：
//   1. 会话恢复到一个已被删除的文件 → 正文是一行「文件不存在：<路径>」提示
//      （不是空白，也没有任何按钮）；
//   2. 提示文字要用后端的原始判定（不是前端猜的），并且 tab 上有 ⚠ 标记；
//   3. 同一路径再次打开 → 不新增重复 tab（仍然是那一行提示）；
//   4. 文件恢复后再次打开同一路径 → 自动切回文本视图并加载内容（不会卡在错误态）；
//   5. 「拒绝访问」→ 走通用错误页的一行说明；
//   6. 表格视图：选 schema → 渲染 → 复制（回归 CfgTableTab 的公共生命周期改造）→ 切回文本。
//
// 传 --shot <目录> 时会在阶段之间导出截图（人工确认观感，也可直接用作文档配图）。
//
// 所有断言在最后统一汇总（失败不中断，保证 CDP 调用方总能拿到观测结果）。

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ==================== 测试数据 ====================

const MISSING = "D:\\Logs\\deleted\\game_inst21.log";
/** 第二个「不存在」的路径：用来验证「新 tab 也会显示提示」而不与上面那个 tab 冲突。 */
const MISSING2 = "D:\\Logs\\deleted\\moved_away.log";
const DENIED = "D:\\Logs\\denied\\secret.log";
const BIN = "D:\\Logs\\cfg\\client_cfg\\default\\pic_guide_data.bin";
const SCHEMA = "C:\\Users\\me\\AppData\\Roaming\\com.loglens.LogLens\\schemas\\cfg_table_slots.json";
const VERSION = "0.0.0-e2e";
const WAIT_MS = Number(process.env.E2E_WAIT_MS ?? 450);

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const PORT = Number(arg("port", "9222"));
const URL = arg("url", "http://127.0.0.1:5173/");
const SHOULD_LAUNCH = argv.includes("--launch");
/** 传 --shot <目录> 时顺便导出三张成品截图（人工确认观感，也可直接用作文档配图）。 */
const SHOT_DIR = arg("shot", null);
/** 界面主题（dark / light）：浅色主题的观感也要能一眼确认。 */
const THEME = arg("theme", "dark");
const EDGE =
  arg("browser", null) ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ==================== 注入页面的 mock 后端 ====================
//
// 只实现被断言流程用到的命令（真实后端行为见 src-tauri/src/lib.rs）：
// 关键点是 open_log_file 对「不存在的文件」抛后端原文错误，对「无权限」抛另一种。

/** 生成注入脚本；路径用 JSON.stringify 注入，避免反斜杠转义地狱。 */
const buildInitScript = () => `
(() => {
  const MISSING = ${JSON.stringify(MISSING)};
  const MISSING2 = ${JSON.stringify(MISSING2)};
  const DENIED = ${JSON.stringify(DENIED)};
  const VERSION = ${JSON.stringify(VERSION)};

  // 上次会话 + 历史记录都指向那个已被删除的文件（复现用户场景）。
  localStorage.setItem("lv-tabs", JSON.stringify({ paths: [MISSING], active: 0 }));
  localStorage.setItem("lv-recent", JSON.stringify([MISSING]));
  localStorage.setItem("lv-lang", "zh");
  localStorage.setItem("lv-theme", ${JSON.stringify(THEME)});

  // 记录复制到剪贴板的内容（表格视图的「复制当前视图」走 navigator.clipboard）。
  window.__e2eClipboard = null;
  Object.defineProperty(Object.getPrototypeOf(navigator), "clipboard", {
    configurable: true,
    get: () => ({ writeText: async (t) => { window.__e2eClipboard = t; } }),
  });

  const tabs = new Map();
  const eventHandlers = new Map();
  window.__e2eDialogPath = null;
  /** 当前「不存在」的路径列表：断言里可以移除某一项，模拟文件被恢复。 */
  window.__e2eGone = [MISSING, MISSING2];
  window.__e2eCalls = [];

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
      case "open_log_file": {
        if (window.__e2eGone.includes(args.path)) {
          throw "文件不存在: " + args.path;
        }
        if (args.path === DENIED) throw "读取失败: 拒绝访问。 (os error 5)";
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
      case "parse_client_cfg_bin":
        // 表格视图：返回一张两行两列的小表（字段名与前端的 ClientCfgTable 对齐）。
        return {
          name: "pic_guide_data",
          columns: [
            { name: "id", field_type: "int" },
            { name: "name", field_type: "str" },
          ],
          keys: [1, 2],
          rows: [
            [{ t: "int", v: 1 }, { t: "str", v: "sword" }],
            [{ t: "int", v: 2 }, { t: "str", v: "shield" }],
          ],
        };
      case "save_schema": {
        // 与后端 save_schema 对齐：备份到应用数据目录后返回备份路径。
        const name = String(args.path).split(/[\\/]/).pop() || "schema.json";
        return "C:\\\\Users\\\\me\\\\AppData\\\\Roaming\\\\com.loglens.LogLens\\\\schemas\\\\" + name;
      }
      case "plugin:dialog|open":
        return window.__e2eDialogPath;
      case "plugin:opener|reveal_item_in_dir":
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

/** 页面里共用的小工具（每个阶段脚本自带一份，避免依赖上一个阶段的副作用）。 */
const HELPERS = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const panels = () => [...document.querySelectorAll(".tab-panel")];
  const visiblePanel = () => panels().find((p) => p.getBoundingClientRect().height > 0);
  const view = () => visiblePanel()?.querySelector(".body-view")?.dataset.view ?? null;
  const text = (sel) => visiblePanel().querySelector(sel)?.textContent?.trim() ?? null;
  const tabCount = () => document.querySelectorAll(".tabbar .tab").length;
  const warnCount = () => document.querySelectorAll(".tabbar .tab-warn").length;
  const click = async (btn, wait = ${WAIT_MS}) => { btn.click(); await sleep(wait); };
`;

const PHASE1 = `
(async () => {
  ${HELPERS}
  const obs = [];
  const fails = [];
  const check = (cond, msg) => { if (!cond) fails.push(msg); };
  const push = (k, v) => obs.push(k.padEnd(30) + " = " + JSON.stringify(v));

  const MISSING = ${JSON.stringify(MISSING)};

  try {
    // ---------- 1. 会话恢复到一个已删除的文件 ----------
    push("view", view());
    push("line", text(".notice-line"));
    push("buttons in panel", visiblePanel().querySelectorAll("button").length);
    push("tab warns", warnCount());
    push("tab title", document.querySelector(".tabbar .tab-title")?.textContent);
    push("total lines label", document.querySelector(".statusbar-lines")?.textContent);
    push("copy-view disabled", document.querySelector("button.copy-view")?.disabled);
    push("log rows in panel", visiblePanel().querySelectorAll(".row").length);

    check(view() === "file-missing", "恢复会话后正文应是 file-missing 页面，实际 " + view());
    check(
      text(".notice-line") === "文件不存在：" + MISSING,
      "应显示一行「文件不存在：<完整路径>」，实际 " + JSON.stringify(text(".notice-line"))
    );
    check(
      visiblePanel().querySelectorAll("button").length === 0,
      "状态页不该有任何按钮（方案已简化为一行文字）"
    );
    check(warnCount() === 1, "tab 栏应有一个警告标记，实际 " + warnCount());
    check(visiblePanel().querySelectorAll(".row").length === 0, "状态页不该渲染日志行");
    check(document.querySelector("button.copy-view")?.disabled === true, "状态页应禁用「复制当前视图」");
    check(
      !/\d/.test(document.querySelector(".statusbar-lines")?.textContent ?? ""),
      "状态页不该显示总行数（状态栏左侧应是无数字的占位）"
    );

    // ---------- 2. 同一路径再次打开：不新增 tab，仍是那一行提示 ----------
    const before = tabCount();
    window.__lvOpenPath(MISSING);
    await sleep(800);
    push("tabs after reopen", before + " -> " + tabCount());
    push("view after reopen", view());
    check(tabCount() === before, "同一路径重复打开不应新增 tab：" + before + " -> " + tabCount());
    check(view() === "file-missing", "文件仍不存在时应保持那一行提示，实际 " + view());

    // ---------- 3. 文件恢复后再次打开：自动切回内容视图 ----------
    // 这是「没有按钮」之后唯一的恢复路径：再次打开同一路径会重新检测。
    window.__e2eGone = window.__e2eGone.filter((p) => p !== MISSING);
    window.__lvOpenPath(MISSING);
    await sleep(900);
    push("view after restore", view());
    push("rows after restore", [...visiblePanel().querySelectorAll(".row .text")].map((e) => e.textContent));
    push("tab warns after restore", warnCount());
    push("tabs after restore", tabCount());
    check(view() === "text-log", "文件恢复后应自动切回文本视图，实际 " + view());
    check(visiblePanel().querySelectorAll(".row").length === 3, "应加载到 3 行内容");
    check(warnCount() === 0, "恢复后警告标记应消失");
    check(tabCount() === before, "恢复不应新增 tab");
  } catch (e) {
    fails.push("phase1 threw: " + (e && e.message ? e.message : String(e)));
  }

  obs.push("");
  obs.push(fails.length ? "PHASE1 FAILED " + fails.length + ":" : "PHASE1 ALL PASSED");
  fails.forEach((f) => obs.push("  - " + f));
  return obs.join("\\n");
})()
`;

const PHASE2 = `
(async () => {
  ${HELPERS}
  const obs = [];
  const fails = [];
  const check = (cond, msg) => { if (!cond) fails.push(msg); };
  const push = (k, v) => obs.push(k.padEnd(30) + " = " + JSON.stringify(v));

  const DENIED = ${JSON.stringify(DENIED)};
  const MISSING2 = ${JSON.stringify(MISSING2)};

  try {
    // ---------- 4. 拒绝访问：通用错误页的一行说明 ----------
    window.__lvOpenPath(DENIED);
    await sleep(700);
    push("denied view", view());
    push("denied line", text(".notice-line"));
    push("denied buttons", visiblePanel().querySelectorAll("button").length);
    push("tabs", tabCount());
    check(view() === "open-error", "拒绝访问应走通用错误页，实际 " + view());
    check(
      text(".notice-line") === "没有权限读取：" + DENIED,
      "权限失败应给出「没有权限读取：<路径>」，实际 " + JSON.stringify(text(".notice-line"))
    );
    check(visiblePanel().querySelectorAll("button").length === 0, "状态页不该有任何按钮");

    // ---------- 5. 同一路径再次打开：不新建 tab ----------
    const before = tabCount();
    window.__lvOpenPath(DENIED);
    await sleep(800);
    push("tabs after reopen", before + " -> " + tabCount());
    push("view after reopen", view());
    check(tabCount() === before, "同一路径重复打开不应新增 tab：" + before + " -> " + tabCount());
    check(view() === "open-error", "仍打不开时应保持错误页，实际 " + view());

    // ---------- 6. 新开一个不存在的文件：新建 tab + 一行「文件不存在」 ----------
    window.__lvOpenPath(MISSING2);
    await sleep(800);
    push("missing view", view());
    push("missing line", text(".notice-line"));
    push("tabs total", tabCount());
    push("warn markers", warnCount());
    check(view() === "file-missing", "新开的不存在文件应显示「文件不存在」，实际 " + view());
    check(
      text(".notice-line") === "文件不存在：" + MISSING2,
      "提示文字不对: " + JSON.stringify(text(".notice-line"))
    );
    check(tabCount() === before + 1, "应新建一个 tab");
    check(warnCount() === 2, "两个失败 tab 都应有警告标记，实际 " + warnCount());
  } catch (e) {
    fails.push("phase2 threw: " + (e && e.message ? e.message : String(e)));
  }

  obs.push("");
  obs.push(fails.length ? "PHASE2 FAILED " + fails.length + ":" : "PHASE2 ALL PASSED");
  fails.forEach((f) => obs.push("  - " + f));
  return obs.join("\\n");
})()
`;

const PHASE3 = `
(async () => {
  ${HELPERS}
  const obs = [];
  const fails = [];
  const check = (cond, msg) => { if (!cond) fails.push(msg); };
  const push = (k, v) => obs.push(k.padEnd(30) + " = " + JSON.stringify(v));
  const q = (sel) => visiblePanel().querySelector(sel);

  const BIN = ${JSON.stringify(BIN)};
  const SCHEMA = ${JSON.stringify(SCHEMA)};

  try {
    // ---------- 7. 表格视图（顺带回归 CfgTableTab 的公共生命周期改造） ----------
    window.__lvOpenPath(BIN);
    await sleep(700);
    push("bin tab view", view());
    check(view() === "text-log", "bin 默认按文本视图打开，实际 " + view());

    // 打开视图模式选择框 → 添加 schema（对话框返回一个 json 路径）
    window.__e2eDialogPath = SCHEMA;
    await click(q(".view-toggle"), 300);
    push("modal open", !!document.querySelector(".viewmode-modal"));
    await click(document.querySelector(".viewmode-schema-add"), 500);
    const chosen = document.querySelector(".viewmode-schema-item.current .viewmode-schema-name");
    push("schema selected", chosen?.textContent ?? null);
    check(!!chosen, "添加 schema 后应被选中");

    // 切到表格视图
    const item = [...document.querySelectorAll(".viewmode-item")].find((b) =>
      b.textContent.includes("表格视图")
    );
    await click(item, 900);
    push("table view", view());
    push("table head cells", [...document.querySelectorAll(".cfg-head-cell")].map((c) => c.textContent));
    push("table rows", document.querySelectorAll(".cfg-row").length);
    push("table first row", [...document.querySelectorAll(".cfg-row .cfg-cell")].slice(0, 3).map((c) => c.textContent));
    push("table count", document.querySelector(".cfg-count")?.textContent);
    check(view() === "cfg-table", "应切到表格视图，实际 " + view());
    check(document.querySelectorAll(".cfg-row").length === 2, "应渲染 2 行数据");
    check(
      JSON.stringify([...document.querySelectorAll(".cfg-row .cfg-cell")].slice(0, 3).map((c) => c.textContent)) ===
        JSON.stringify(["1", "1", "sword"]),
      "首行内容不对"
    );
    check((document.querySelector(".cfg-count")?.textContent ?? "").includes("2 行"), "行数/列数显示不对");

    // 复制当前视图：注册与产出都要走公共生命周期 hook
    const copyBtn = document.querySelector("button.copy-view");
    push("copy view enabled", copyBtn?.disabled === false);
    check(copyBtn?.disabled === false, "表格视图激活时应注册「复制当前视图」");
    copyBtn.click();
    await sleep(200);
    const tsv = window.__e2eClipboard ?? "";
    push("copied tsv", tsv.split("\\r\\n"));
    check(tsv.startsWith("key\\tid\\tname"), "复制的表头不对: " + tsv.split("\\r\\n")[0]);
    check(tsv.includes("1\\t1\\tsword") && tsv.includes("2\\t2\\tshield"), "复制内容缺少数据行");

    // 切回文本视图（表格视图工具栏最左侧的图标按钮）
    await click(q(".view-toggle"), 300);
    const textItem = [...document.querySelectorAll(".viewmode-item")].find((b) =>
      b.textContent.includes("文本视图")
    );
    await click(textItem, 700);
    push("back to text view", view());
    check(view() === "text-log", "应能切回文本视图，实际 " + view());
  } catch (e) {
    fails.push("phase3 threw: " + (e && e.message ? e.message : String(e)));
  }

  obs.push("");
  obs.push(fails.length ? "PHASE3 FAILED " + fails.length + ":" : "PHASE3 ALL PASSED");
  fails.forEach((f) => obs.push("  - " + f));
  return obs.join("\\n");
})()
`;

// ==================== CDP 客户端 ====================

/** 连到 CDP 的页面 target，返回 { send, close }。 */
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
  const child = spawn(
    EDGE,
    [
      "--headless=new",
      "--disable-gpu",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${process.env.TEMP ?? "."}\\loglens-e2e-profile`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: "ignore", detached: false }
  );
  return child;
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

  // 等应用挂载：出现 tab + 正文页面。
  await waitFor(
    async () =>
      await evaluate(
        cdp,
        `!!document.querySelector(".body-view") && !!document.querySelector(".tabbar .tab")`
      ),
    20000,
    "LogLens 首屏"
  );
  await sleep(500);

  await shoot(cdp, "01-file-missing.png");
  const phase1 = await evaluate(cdp, PHASE1);
  console.log("===== 恢复会话 → 文件不存在 → 修复流程 =====");
  console.log(phase1);
  await shoot(cdp, "02-after-restore.png");

  const phase2 = await evaluate(cdp, PHASE2);
  console.log("===== 通用错误页 / 重复打开 =====");
  console.log(phase2);
  // 切回「拒绝访问」那个 tab（第 2 个），截一张通用错误页的图。
  await evaluate(cdp, `document.querySelectorAll(".tabbar .tab")[1]?.click(); true`);
  await sleep(400);
  await shoot(cdp, "03-open-error.png");

  const phase3 = await evaluate(cdp, PHASE3);
  console.log("===== 表格视图（回归 CfgTableTab 生命周期改造） =====");
  console.log(phase3);
  await shoot(cdp, "04-cfg-roundtrip.png");

  cdp.close();
  exitCode =
    /ALL PASSED/.test(phase1) && /ALL PASSED/.test(phase2) && /ALL PASSED/.test(phase3)
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
