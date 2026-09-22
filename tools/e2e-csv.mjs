// e2e-csv.mjs — 用真实浏览器（Edge/Chrome + CDP）验收「CSV 默认进表格视图」这条主线。
//
// 为什么需要它：CSV 的解析规则（引号、CRLF、编码）在后端，`cargo test --lib csv_table`
// 已经逐一钉住了；纯前端规则由 `node --test tools/verify-csv.test.mjs` 覆盖。这个脚本
// 补的是**两者之间的接线**，也就是只有真的跑起来才看得出来的那部分：
//   * .csv 打开时是不是真的默认落在表格视图（而不是先闪一下文本再切）；
//   * 工具栏换分隔符会不会真的重新解析、并把结果换成新的一列；
//   * 「首行为表头」开关是不是纯前端切换（不重新解析，也不丢数据行）；
//   * 超过行数上限时有没有那条截断横幅；
//   * 「复制当前视图」产出的是不是 TSV；
//   * 切回文本视图后还能不能正常看到原文（CSV tab 没有 tail 会话，要补 open_log_file）。
//
// 用法：
//   1) pnpm run dev                    # Vite dev server（127.0.0.1:5173）
//   2) node tools/e2e-csv.mjs --launch
//      （--launch 自己拉起无头 Edge 并在结束时关掉；也可以先手动起浏览器再省略该参数，
//        用 --port 指定 CDP 端口。--shot <目录> 导出截图，--theme light 换浅色主题）
//
// 所有断言在最后统一汇总（失败不中断，保证 CDP 调用方总能拿到观测结果）。

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ==================== 测试数据 ====================

/** 逗号分隔：默认就该进表格视图。 */
const CSV = "D:\\Logs\\export\\items.csv";
/** 制表符分隔：不手动指定分隔符时应当**不是**表格（列数为 1）—— 用来验证扩展名推断。 */
const TSV = "D:\\Logs\\export\\items.tsv";
const LOG = "D:\\Logs\\game_inst21.log";
/** 大表：500 行 × 4 列，用来验证「查找会滚到远处那一行、也会横向滚到那一列」。 */
const BIG = "D:\\Logs\\export\\big.csv";
const BIG_ROWS = 500;
/** 大表里唯一那一处「远处 + 靠右列」的命中标记。 */
const BIG_NEEDLE_ROW = 480;
const BIG_NEEDLE = "needle-marker";
const VERSION = "0.0.0-e2e";
const WAIT_MS = Number(process.env.E2E_WAIT_MS ?? 450);

/** CSV 文件内容（mock 后端解析它）。含空字段与一行多余的数据（用于截断场景）。 */
const CSV_BODY = "name,qty,note\napple,3,fresh\npear,,juicy\n";

/** 截断场景的上限：小到让上面的文件「正好超一行」，横幅才有机会出现。 */
const ROW_LIMIT = 2;

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
// 只实现被断言流程用到的命令。`parse_csv_table` 是这里的重点：它按**请求里的分隔符**
// 切列（真实后端的成套规则由 cargo 单测覆盖，这里只要保证「换分隔符 → 表格跟着变」）。

const buildInitScript = () => `
(() => {
  const CSV = ${JSON.stringify(CSV)};
  const TSV = ${JSON.stringify(TSV)};
  const BIG = ${JSON.stringify(BIG)};
  const CSV_BODY = ${JSON.stringify(CSV_BODY)};
  const ROW_LIMIT = ${ROW_LIMIT};
  const BIG_ROWS = ${BIG_ROWS};
  const BIG_NEEDLE_ROW = ${BIG_NEEDLE_ROW};
  const BIG_NEEDLE = ${JSON.stringify(BIG_NEEDLE)};
  const VERSION = ${JSON.stringify(VERSION)};

  // 只在**首次**加载时清空会话：后面的阶段要刷新页面来验「会话恢复」，
  // 那时存档必须留着（sessionStorage 在同一次浏览器会话里跨刷新保留）。
  if (!sessionStorage.getItem("__e2eInited")) {
    sessionStorage.setItem("__e2eInited", "1");
    localStorage.removeItem("lv-tabs");
    localStorage.removeItem("lv-recent");
    localStorage.setItem("lv-lang", "zh");
    localStorage.setItem("lv-theme", ${JSON.stringify(THEME)});
  }
  // 记录复制到剪贴板的内容（表格视图的「复制当前视图」走 navigator.clipboard）。
  window.__e2eClipboard = null;
  Object.defineProperty(Object.getPrototypeOf(navigator), "clipboard", {
    configurable: true,
    get: () => ({ writeText: async (t) => { window.__e2eClipboard = t; } }),
  });

  const tabs = new Map();
  const eventHandlers = new Map();
  window.__e2eCalls = [];
  /** 谁被解析过、用的什么分隔符 —— 断言「换分隔符真的重新解析了」用。 */
  window.__e2eParseCalls = [];
  /** 置 true 后解析结果故意截断（用来验截断横幅；默认关，正常文件不截断）。 */
  window.__e2eTruncate = false;

  const linesFor = (path) => [
    { file_offset: 1, file_line: 1, text: "name,qty,note" },
    { file_offset: 2, file_line: 2, text: "apple,3,fresh" },
    { file_offset: 3, file_line: 3, text: "pear,,juicy" },
  ];

  function emit(event, payload) {
    const id = eventHandlers.get(event);
    if (id == null) return;
    const fn = window["_" + id];
    if (typeof fn === "function") setTimeout(() => fn({ event, payload }), 0);
  }

  /** 极简 CSV：只按分隔符切列（真实后端还处理引号 / CRLF / 编码）。 */
  function parseCsv(text, delimiter) {
    const rows = [];
    for (const line of text.split(/\\r?\\n/)) {
      if (line === "") continue;
      rows.push(line.split(delimiter));
    }
    return rows;
  }

  /** 大表：id / name / qty / note，其中第 BIG_NEEDLE_ROW 行的 note 是唯一标记。 */
  function bigMatrix() {
    const rows = [["id", "name", "qty", "note"]];
    for (let i = 1; i <= BIG_ROWS; i++) {
      rows.push([
        String(i),
        "item-" + i,
        String(i * 3),
        i === BIG_NEEDLE_ROW ? BIG_NEEDLE : "plain-" + i,
      ]);
    }
    return rows;
  }

  async function invoke(cmd, args = {}) {
    args = args || {};
    window.__e2eCalls.push(cmd);
    switch (cmd) {
      case "parse_csv_table": {
        window.__e2eParseCalls.push({
          path: args.path, delimiter: args.delimiter, encoding: args.encoding,
        });
        await new Promise((r) => setTimeout(r, 120));   // 模拟后端解析耗时
        const delimiter = args.delimiter ?? ",";
        const big = args.path === BIG;
        const all = big ? bigMatrix() : parseCsv(CSV_BODY, delimiter);
        // 截断只在这个开关打开时发生（真实后端的行数上限是 20 万，测试文件够不着）。
        const cap = window.__e2eTruncate ? ROW_LIMIT : all.length;
        const rows = all.slice(0, cap);
        return {
          rows,
          width: Math.max(...rows.map((r) => r.length), 0),
          delimiter,
          truncated: all.length > rows.length,
          max_rows: window.__e2eTruncate ? ROW_LIMIT : 200000,
          bytes: big ? 20000 : CSV_BODY.length,
          encoding: {
            choice: args.encoding || "auto", id: "utf-8", name: "UTF-8", note: "Unicode",
            group: "unicode", source: "utf8", bom: false,
          },
        };
      }
      case "open_log_file": {
        const lines = linesFor(args.path);
        tabs.set(args.tabId, { path: args.path, lines });
        emit("log-lines", {
          tab_id: args.tabId, lines, reset: true, total_lines: lines.length, avg_line_len: 18,
        });
        return {
          choice: args.encoding || "auto", id: "utf-8", name: "UTF-8", note: "Unicode",
          group: "unicode", source: "utf8", bom: false,
        };
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
        return [18];
      case "load_history":
        return { lines: [], has_more: false };
      case "set_filter": {
        const t = tabs.get(args.tabId);
        return t ? t.lines : [];
      }
      case "set_encoding": {
        const t = tabs.get(args.tabId);
        return t ? { choice: args.encoding, id: "utf-8", name: "UTF-8", note: "Unicode",
                     group: "unicode", source: "manual", bom: false } : null;
      }
      case "get_encoding":
        return null;
      case "detect_encoding":
        return { choice: args.encoding || "auto", id: "utf-8", name: "UTF-8", note: "Unicode",
                 group: "unicode", source: "utf8", bom: false };
      case "list_encodings":
        // 编码弹窗的目录（真实后端给的是完整目录，这里给三条够用的）。
        return [
          { id: "utf-8", name: "UTF-8", note: "Unicode", group: "unicode" },
          { id: "gbk", name: "GBK", note: "ANSI 936", group: "chinese" },
          { id: "windows-1252", name: "Windows-1252", note: "ANSI 1252", group: "western" },
        ];
      case "read_text_file": {
        // 编码弹窗的实时预览：回一段 CSV 原文（真实后端会真按所选编码解码）。
        const info = {
          choice: args.encoding || "auto", id: args.encoding && args.encoding !== "auto" ? args.encoding : "utf-8",
          name: "UTF-8", note: "Unicode", group: "unicode", source: "utf8", bom: false,
        };
        return { text: CSV_BODY, bytes: CSV_BODY.length, truncated: false, encoding: info };
      }
      case "search_lines":
        return { hits: [], complete: true, scope_total: 0 };
      case "close_tab":
        tabs.delete(args.tabId);
        return null;
      case "plugin:dialog|open":
        return null;
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

const HELPERS = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const panels = () => [...document.querySelectorAll(".tab-panel")];
  const visiblePanel = () => panels().find((p) => p.getBoundingClientRect().height > 0);
  const view = () => visiblePanel()?.querySelector(".body-view")?.dataset.view ?? null;
  const tabCount = () => document.querySelectorAll(".tabbar .tab").length;
  const q = (sel) => visiblePanel().querySelector(sel);
  const heads = () => [...visiblePanel().querySelectorAll(".cfg-head-cell")].map((c) => c.textContent.trim());
  const firstRow = () => [...visiblePanel().querySelectorAll(".cfg-row .cfg-cell")].map((c) => c.textContent);
  const bodyRows = () => [...visiblePanel().querySelectorAll(".cfg-row")].map((r) =>
    [...r.querySelectorAll(".cfg-cell")].map((c) => c.textContent));
  const setDelimiter = (char) => {
    const sel = q(".cfg-delim-select");
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(sel, char);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  };
  // React 受控输入：必须走原生 value setter + input 事件，直接改 .value 不会触发 onChange
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const pressCtrlF = () => document.dispatchEvent(new KeyboardEvent("keydown", {
    key: "f", ctrlKey: true, bubbles: true, cancelable: true,
  }));
  const pressKey = (el, key, shift = false) => el.dispatchEvent(new KeyboardEvent("keydown", {
    key, shiftKey: shift, bubbles: true, cancelable: true,
  }));
  const click = async (btn, wait = ${WAIT_MS}) => { btn.click(); await sleep(wait); };
`;

const PHASE1 = `
(async () => {
  ${HELPERS}
  const obs = [];
  const fails = [];
  const check = (cond, msg) => { if (!cond) fails.push(msg); };
  const push = (k, v) => obs.push(k.padEnd(30) + " = " + JSON.stringify(v));

  const CSV = ${JSON.stringify(CSV)};

  try {
    // ---------- 1. .csv 打开即表格视图 ----------
    window.__lvOpenPath(CSV);
    await sleep(900);
    push("view after open", view());
    push("tab count", tabCount());
    push("head cells", heads());
    push("rows", bodyRows());
    push("count label", q(".cfg-count")?.textContent);
    push("parse calls", window.__e2eParseCalls);

    check(view() === "csv-table", ".csv 应默认进表格视图，实际 " + view());
    check(
      JSON.stringify(heads()) === JSON.stringify(["name", "qty", "note"]),
      "表头应是首行，实际 " + JSON.stringify(heads())
    );
    check(
      JSON.stringify(bodyRows()) === JSON.stringify([["apple", "3", "fresh"], ["pear", "", "juicy"]]),
      "数据行不对，实际 " + JSON.stringify(bodyRows())
    );
    check((q(".cfg-count")?.textContent ?? "").includes("2 行"), "行数/列数显示不对");
    check(!q(".cfg-banner"), "未截断时不该有横幅");
    check(
      window.__e2eParseCalls.length === 1 && window.__e2eParseCalls[0].path === CSV
        && window.__e2eParseCalls[0].delimiter === ",",
      "打开时应只解析一次，且默认逗号，实际 " + JSON.stringify(window.__e2eParseCalls)
    );
    // 默认模式直接进表格：文本会话一次都不该被开起来（否则会白读一遍文件）
    check(!window.__e2eCalls.includes("open_log_file"), "默认表格视图不该建文本 tail 会话");

    // ---------- 2. 「首行为表头」是纯前端开关（不重新解析） ----------
    const parseCountBefore = window.__e2eParseCalls.length;
    const headerToggle = q(".cfg-check input");
    check(!!headerToggle, "工具栏应有「首行为表头」开关");
    headerToggle.click();
    await sleep(300);
    push("heads after toggle off", heads());
    push("rows after toggle off", bodyRows());
    check(
      JSON.stringify(heads()) === JSON.stringify(["列1", "列2", "列3"]),
      "关掉表头后列名应变成「列1/列2/列3」，实际 " + JSON.stringify(heads())
    );
    check(bodyRows().length === 3, "关掉表头后首行应回到数据里（3 行）");
    check(
      window.__e2eParseCalls.length === parseCountBefore,
      "切表头开关不该重新解析（表头只是首行的另一种解读）"
    );
    headerToggle.click();
    await sleep(300);
    check(bodyRows().length === 2, "再打开表头应恢复 2 行数据");

    // ---------- 3. 换分隔符 → 真的重新解析，列数随之变化 ----------
    setDelimiter(";");
    await sleep(900);
    push("parse calls after delimiter", window.__e2eParseCalls);
    push("heads with ;", heads());
    check(
      window.__e2eParseCalls.length === parseCountBefore + 1,
      "换分隔符应触发一次重新解析"
    );
    check(
      window.__e2eParseCalls[window.__e2eParseCalls.length - 1].delimiter === ";",
      "重新解析应带上新分隔符，实际 " + JSON.stringify(window.__e2eParseCalls.at(-1))
    );
    check(
      heads().length === 1,
      "整份文件里没有分号 → 只剩一列，实际 " + JSON.stringify(heads())
    );
    setDelimiter(",");
    await sleep(900);
    check(heads().length === 3, "换回逗号应恢复三列，实际 " + JSON.stringify(heads()));

    // ---------- 4. 重新解析：表格不跟随文件变化，得有个手动入口 ----------
    const reloadBtn = [...visiblePanel().querySelectorAll(".cfg-toolbar .cfg-btn")].find((b) =>
      b.textContent.includes("重新解析")
    );
    const beforeReload = window.__e2eParseCalls.length;
    check(!!reloadBtn, "工具栏上应有「重新解析」按钮（表格不跟随外部改动）");
    await click(reloadBtn, 900);
    push("parse calls after reload", window.__e2eParseCalls.length);
    check(
      window.__e2eParseCalls.length === beforeReload + 1,
      "点「重新解析」应重新解析一次"
    );

    // ---------- 5. 复制当前视图 = TSV ----------
    const copyBtn = document.querySelector("button.copy-view");
    push("copy enabled", copyBtn?.disabled === false);
    check(copyBtn?.disabled === false, "表格视图激活时应注册「复制当前视图」");
    copyBtn.click();
    await sleep(250);
    const tsv = window.__e2eClipboard ?? "";
    push("copied tsv", tsv.split("\\r\\n"));
    check(tsv.startsWith("name\\tqty\\tnote"), "复制的表头不对: " + tsv.split("\\r\\n")[0]);
    check(tsv.includes("apple\\t3\\tfresh"), "复制内容缺少数据行");
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

  const CSV = ${JSON.stringify(CSV)};
  const TSV = ${JSON.stringify(TSV)};
  const LOG = ${JSON.stringify(LOG)};

  try {
    // ---------- 5. 切回文本视图：补一次 open_log_file，正文是原文 ----------
    await click(visiblePanel().querySelector(".view-toggle"), 400);
    const textItem = [...document.querySelectorAll(".viewmode-item")].find((b) =>
      b.textContent.includes("文本视图")
    );
    await click(textItem, 900);
    push("view back to text", view());
    push("text rows", [...visiblePanel().querySelectorAll(".row .text")].map((e) => e.textContent));
    check(view() === "text-log", "应切回文本视图，实际 " + view());
    check(
      window.__e2eCalls.includes("open_log_file"),
      "CSV tab 没有文本会话，切回文本视图时必须补一次 open_log_file"
    );
    check(visiblePanel().querySelectorAll(".row").length === 3, "文本视图应加载到 3 行原文");

    // 再切回表格：本次会话里已经解析过，但切换本身仍应重新解析一次（数据可能已变）
    await click(visiblePanel().querySelector(".view-toggle"), 400);
    const tableItem = [...document.querySelectorAll(".viewmode-item")].find((b) =>
      b.textContent.includes("表格视图")
    );
    push("table item desc mentions csv", tableItem?.textContent.includes("csv"));
    await click(tableItem, 900);
    push("view back to table", view());
    check(view() === "csv-table", "应能切回表格视图，实际 " + view());
    check(
      tableItem?.textContent.includes(".csv"),
      "视图模式弹窗的说明应提到 .csv（一个入口、两种后端）"
    );

    // ---------- 6. .tsv：按扩展名推断分隔符 ----------
    window.__lvOpenPath(TSV);
    await sleep(900);
    push("tsv view", view());
    push("tsv parse call", window.__e2eParseCalls.at(-1));
    check(view() === "csv-table", ".tsv 也应默认进表格视图，实际 " + view());
    check(
      window.__e2eParseCalls.at(-1).delimiter === "\\t",
      ".tsv 的默认分隔符应是制表符，实际 " + JSON.stringify(window.__e2eParseCalls.at(-1))
    );

    // ---------- 7. 普通日志仍从文本视图起步 ----------
    window.__lvOpenPath(LOG);
    await sleep(900);
    push("log view", view());
    check(view() === "text-log", ".log 应仍从文本视图起步，实际 " + view());
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

  try {
    // ---------- 8. 截断横幅 ----------
    // 回到第一个 tab（CSV），打开「解析结果截断」开关后再切一次表格视图
    // （切视图模式会重新解析 —— 顺便验了「切回来会重读」这条路径）。
    document.querySelectorAll(".tabbar .tab")[0]?.click();
    await sleep(400);
    window.__e2eTruncate = true;
    await click(visiblePanel().querySelector(".view-toggle"), 400);
    const tableItem = [...document.querySelectorAll(".viewmode-item")].find((b) =>
      b.textContent.includes("表格视图")
    );
    await click(tableItem, 900);
    push("csv view", view());
    push("banner", q(".cfg-banner")?.textContent);
    check(view() === "csv-table", "应回到 CSV 表格 tab，实际 " + view());
    const banner = q(".cfg-banner")?.textContent ?? "";
    check(!!banner, "超过行数上限时应显示截断横幅");
    check(banner.includes(String(${ROW_LIMIT})), "横幅里应写出实际上限，实际 " + JSON.stringify(banner));
    // 上限 2 行含表头 → 实际显示 1 行数据；横幅说明的是「文件的前 2 行」。
    check(
      q(".cfg-count")?.textContent.includes("1 行"),
      "截断后仍按实际解析到的行数显示，实际 " + JSON.stringify(q(".cfg-count")?.textContent)
    );
    check(
      bodyRows().length === 1,
      "截断后应只渲染解析到的数据行，实际 " + bodyRows().length
    );
  } catch (e) {
    fails.push("phase3 threw: " + (e && e.message ? e.message : String(e)));
  }

  obs.push("");
  obs.push(fails.length ? "PHASE3 FAILED " + fails.length + ":" : "PHASE3 ALL PASSED");
  fails.forEach((f) => obs.push("  - " + f));
  return obs.join("\\n");
})()
`;

const PHASE4 = `
(async () => {
  ${HELPERS}
  const obs = [];
  const fails = [];
  const check = (cond, msg) => { if (!cond) fails.push(msg); };
  const push = (k, v) => obs.push(k.padEnd(30) + " = " + JSON.stringify(v));

  try {
    // ---------- 9. CSV 表格页也能换编码（它是文本后端，不是二进制） ----------
    // 先把分隔符换成一个非默认值，等会儿连存档一起验（阶段 5 刷新页面后要它还在）。
    setDelimiter(";");
    await sleep(900);
    // 状态栏在 tab 面板之外，得从 document 上找。
    const encBtn = document.querySelector("button.statusbar-encoding");
    push("encoding button disabled", encBtn?.disabled);
    check(encBtn?.disabled === false, "CSV 是文本，状态栏的编码项应可点（配置表才是灰的）");
    await click(encBtn, 500);
    push("encoding modal", !!document.querySelector(".encoding-modal"));
    check(!!document.querySelector(".encoding-modal"), "点编码项应打开编码弹窗");

    const gbk = [...document.querySelectorAll(".encoding-item")].find((b) =>
      b.querySelector(".encoding-item-name")?.textContent === "GBK"
    );
    check(!!gbk, "编码列表里应有 GBK 项");
    await click(gbk, 400);
    await click(document.querySelector(".encoding-btn.primary"), 1200);
    const last = window.__e2eParseCalls.at(-1);
    push("last parse call", last);
    check(
      last?.encoding === "gbk",
      "换编码后应按新编码重新解析 CSV（而不是走 set_encoding），实际 " + JSON.stringify(last)
    );
    check(!window.__e2eCalls.includes("set_encoding"), "CSV 表格没有 tail 会话，不该调 set_encoding");
    push("view after encoding", view());
    check(view() === "csv-table", "换编码后仍应停在表格视图，实际 " + view());
  } catch (e) {
    fails.push("phase4 threw: " + (e && e.message ? e.message : String(e)));
  }

  obs.push("");
  obs.push(fails.length ? "PHASE4 FAILED " + fails.length + ":" : "PHASE4 ALL PASSED");
  fails.forEach((f) => obs.push("  - " + f));
  return obs.join("\\n");
})()
`;

const PHASE5 = `
(async () => {
  ${HELPERS}
  const obs = [];
  const fails = [];
  const check = (cond, msg) => { if (!cond) fails.push(msg); };
  const push = (k, v) => obs.push(k.padEnd(18) + " = " + JSON.stringify(v));

  const CSV = ${JSON.stringify(CSV)};

  try {
    // ---------- 10. 会话恢复：视图模式与分隔符一起回来 ----------
    // 刷新前把分隔符设成了 ";"（阶段 4），它随会话存档（lv-tabs 的 delims）持久化。
    const archive = JSON.parse(localStorage.getItem("lv-tabs") ?? "null");
    push("archive delims", archive?.delims);
    push("archive heads", archive?.heads);
    check(
      Array.isArray(archive?.delims) && archive.delims[0] === ";",
      "分隔符应写进会话存档，实际 " + JSON.stringify(archive?.delims)
    );
    check(
      Array.isArray(archive?.modes) && archive.modes[0] === "table",
      "视图模式应写进会话存档（取值 table），实际 " + JSON.stringify(archive?.modes)
    );

    const csvTab = visiblePanel();
    push("view after reload", csvTab?.querySelector(".body-view")?.dataset.view);
    check(
      csvTab?.querySelector(".body-view")?.dataset.view === "csv-table",
      ".csv 恢复后应仍是表格视图，实际 " + csvTab?.querySelector(".body-view")?.dataset.view
    );
    const sel = visiblePanel().querySelector(".cfg-delim-select");
    push("delimiter after reload", sel?.value);
    check(sel?.value === ";", "恢复后分隔符应是存档里的 ;，实际 " + JSON.stringify(sel?.value));
    // 恢复是逐个 tab 重新打开的（顺序由存档决定），所以看「有没有那次解析」而不是最后一次。
    const csvCall = window.__e2eParseCalls.find((c) => c.path === CSV);
    push("csv parse after reload", csvCall ?? null);
    check(
      csvCall?.delimiter === ";",
      "恢复时应按存档的分隔符解析，实际 " + JSON.stringify(csvCall ?? window.__e2eParseCalls)
    );
  } catch (e) {
    fails.push("phase5 threw: " + (e && e.message ? e.message : String(e)));
  }

  obs.push("");
  obs.push(fails.length ? "PHASE5 FAILED " + fails.length + ":" : "PHASE5 ALL PASSED");
  fails.forEach((f) => obs.push("  - " + f));
  return obs.join("\\n");
})()
`;

const PHASE6 = `
(async () => {
  ${HELPERS}
  const obs = [];
  const fails = [];
  const check = (cond, msg) => { if (!cond) fails.push(msg); };
  const push = (k, v) => obs.push(k.padEnd(26) + " = " + JSON.stringify(v));

  const CSV = ${JSON.stringify(CSV)};

  try {
    // ---------- 11. 老存档迁移：0.5.0 的 modes["text"] 不是用户选择 ----------
    // 升级前 CSV 的默认视图就是文本（那时表格视图只服务 .bin），所以老存档里
    // 记下的 "text" 必须按新默认（表格）重新推断，否则老会话里的 .csv 会一直
    // 停在文本视图 —— 正好与「CSV 默认表格」相反。
    push("view", view());
    check(view() === "csv-table", "老存档里的 CSV 也应按新默认进表格视图，实际 " + view());
    const archive = JSON.parse(localStorage.getItem("lv-tabs") ?? "null");
    push("archive after migrate", { version: archive?.version, modes: archive?.modes });
    check(archive?.version === 2, "重新保存时应写上存档版本号 version=2，实际 " + JSON.stringify(archive?.version));
    check(
      archive?.modes?.[0] === "table",
      "迁移后存档里的模式应变成 table，实际 " + JSON.stringify(archive?.modes)
    );
    check(
      visiblePanel().querySelector(".body-view")?.dataset.view === "csv-table",
      "迁移后 tab 应停在表格视图"
    );
  } catch (e) {
    fails.push("phase6 threw: " + (e && e.message ? e.message : String(e)));
  }

  obs.push("");
  obs.push(fails.length ? "PHASE6 FAILED " + fails.length + ":" : "PHASE6 ALL PASSED");
  fails.forEach((f) => obs.push("  - " + f));
  return obs.join("\\n");
})()
`;

const PHASE7 = `
(async () => {
  ${HELPERS}
  const obs = [];
  const fails = [];
  const check = (cond, msg) => { if (!cond) fails.push(msg); };
  const push = (k, v) => obs.push(k.padEnd(26) + " = " + JSON.stringify(v));

  try {
    // ---------- 12. 新存档里的 "text" 是用户选择，必须尊重 ----------
    // 迁移只能碰「老存档的当年默认值」；用户在新版本里手动把某个 CSV 切回文本视图
    // 之后，重启后它就该还在文本视图 —— 否则每次重启都把用户的选择抹掉。
    push("view", view());
    check(view() === "text-log", "新存档里显式的 text 应被尊重，实际 " + view());
  } catch (e) {
    fails.push("phase7 threw: " + (e && e.message ? e.message : String(e)));
  }

  obs.push("");
  obs.push(fails.length ? "PHASE7 FAILED " + fails.length + ":" : "PHASE7 ALL PASSED");
  fails.forEach((f) => obs.push("  - " + f));
  return obs.join("\\n");
})()
`;

const PHASE8 = `
(async () => {
  ${HELPERS}
  const obs = [];
  const fails = [];
  const check = (cond, msg) => { if (!cond) fails.push(msg); };
  const push = (k, v) => obs.push(k.padEnd(28) + " = " + JSON.stringify(v));

  const BIG = ${JSON.stringify(BIG)};
  const BIG_NEEDLE = ${JSON.stringify(BIG_NEEDLE)};
  const BIG_NEEDLE_ROW = ${BIG_NEEDLE_ROW};

  /** 当前命中的那个单元格（.find-mark.current）与它所在行的首列。 */
  const currentMark = () => q(".cfg-cell .find-mark.current")?.textContent ?? null;
  const currentRowId = () =>
    q(".cfg-cell .find-mark.current")?.closest(".cfg-row")?.querySelector(".cfg-cell")?.textContent ?? null;
  const renderedIds = () => [...visiblePanel().querySelectorAll(".cfg-row .cfg-cell:first-child")]
    .map((c) => c.textContent);
  const findInput = () => q(".find-input");

  try {
    // ---------- 13. 页内查找：Ctrl+F → 命中计数 → 跳到远处那一行 ----------
    window.__lvOpenPath(BIG);
    await sleep(1000);
    push("view", view());
    check(view() === "csv-table", "大表也应默认进表格视图，实际 " + view());
    push("rendered rows", renderedIds().length);
    check(renderedIds().length > 0 && renderedIds().length < 100,
      "表应有 500 行但只渲染可视区（虚拟滚动），实际渲染 " + renderedIds().length);
    check(!renderedIds().includes(String(BIG_NEEDLE_ROW)),
      "打开时远处那一行不该在可视区里（否则下面的滚动断言没意义）");

    pressCtrlF();
    await sleep(300);
    push("find widget open", !!q(".find-widget"));
    check(!!q(".find-widget"), "Ctrl+F 应打开查找框");
    check(document.activeElement === findInput(), "查找框打开后应自动聚焦");

    setVal(findInput(), BIG_NEEDLE);
    await sleep(600);   // 扫描走 useDeferredValue，等一拍
    push("count", q(".find-count")?.textContent);
    check(q(".find-count")?.textContent === "1/1", "唯一命中应显示 1/1，实际 " + JSON.stringify(q(".find-count")?.textContent));
    push("current mark", currentMark());
    check(currentMark() === BIG_NEEDLE, "当前命中应被标成 find-mark.current");
    push("rendered ids (after find)", renderedIds());
    check(renderedIds().includes(String(BIG_NEEDLE_ROW)),
      "查找应把第 " + BIG_NEEDLE_ROW + " 行滚进可视区，实际可视行 " + JSON.stringify(renderedIds()));

    // 当前命中在靠右的 note 列：横向也应被拉进视野（列宽自适应，窄窗口下必然溢出）
    const markBox = await (async () => {
      const el = visiblePanel().querySelector(".cfg-cell .find-mark.current");
      const scroll = visiblePanel().querySelector(".cfg-scroll");
      if (!el || !scroll) return null;
      const a = el.getBoundingClientRect(), b = scroll.getBoundingClientRect();
      return { inView: a.left >= b.left - 1 && a.right <= b.right + 1, a, b };
    })();
    push("current mark in view", markBox?.inView);
    check(markBox?.inView === true, "当前命中的单元格应横向滚进可视区");

    // Esc 关闭
    pressKey(findInput(), "Escape");
    await sleep(250);
    push("widget after Esc", !!q(".find-widget"));
    check(!q(".find-widget"), "Esc 应关闭查找框");

    // ---------- 14. 多命中：计数、步进、Aa / ab| 开关 ----------
    pressCtrlF();
    await sleep(250);
    setVal(findInput(), "plain-4");
    await sleep(600);
    const countText = q(".find-count")?.textContent ?? "";
    const total = Number((countText.split("/")[1] ?? "0").replace(/\\D/g, ""));
    push("count (plain-4)", countText);
    check(total > 1, "plain-4 应有多处命中，实际 " + JSON.stringify(countText));
    check(countText.startsWith("1/"), "命中表变了应回到第一处，实际 " + JSON.stringify(countText));

    pressKey(findInput(), "Enter");
    await sleep(400);
    push("count after Enter", q(".find-count")?.textContent);
    check((q(".find-count")?.textContent ?? "").startsWith("2/"), "Enter 应步进到下一处");
    check(renderedIds().includes(currentRowId()), "步进后当前命中所在行应可见");

    pressKey(findInput(), "Enter", true);
    await sleep(400);
    push("count after Shift+Enter", q(".find-count")?.textContent);
    check((q(".find-count")?.textContent ?? "").startsWith("1/"), "Shift+Enter 应回到上一处");

    // Aa：大写查询在区分大小写后应一处都不命中
    setVal(findInput(), "PLAIN-4");
    await sleep(600);
    push("count (PLAIN-4 ci)", q(".find-count")?.textContent);
    check(q(".find-count")?.textContent !== "0/0", "不区分大小写时大写查询也应命中");
    await click(q(".find-toggle"), 600);
    push("count (PLAIN-4 cs)", q(".find-count")?.textContent);
    check(q(".find-count")?.textContent === "0/0", "开了 Aa 之后大写查询应无命中，实际 " + JSON.stringify(q(".find-count")?.textContent));
    await click(q(".find-toggle"), 400);   // 关掉 Aa，避免影响后续

    // ab|（全字）：name 列的值是 item-N / plain-N，搜 "item-4" 子串能命中 item-4x，
    // 开了全字就只剩独立的那一个（如果存在）。
    setVal(findInput(), "item-4");
    await sleep(600);
    const subCount = q(".find-count")?.textContent ?? "";
    await click([...visiblePanel().querySelectorAll(".find-toggle")][1], 600);
    const wordCount = q(".find-count")?.textContent ?? "";
    push("count item-4 (sub → word)", subCount + " → " + wordCount);
    check(subCount !== wordCount, "全字开关应改变命中数（子串 " + subCount + " vs 全字 " + wordCount + "）");
    await click([...visiblePanel().querySelectorAll(".find-toggle")][1], 400);
  } catch (e) {
    fails.push("phase8 threw: " + (e && e.message ? e.message : String(e)));
  }

  obs.push("");
  obs.push(fails.length ? "PHASE8 FAILED " + fails.length + ":" : "PHASE8 ALL PASSED");
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
      `--user-data-dir=${process.env.TEMP ?? "."}\\loglens-e2e-csv-profile`,
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

  await waitFor(
    async () => await evaluate(cdp, `!!document.querySelector(".open-first, .tabbar .tab")`),
    20000,
    "LogLens 首屏"
  );
  await sleep(500);

  const phase1 = await evaluate(cdp, PHASE1);
  console.log("===== CSV 默认表格 / 分隔符 / 表头开关 / 复制 =====");
  console.log(phase1);
  await shoot(cdp, "01-csv-table.png");

  const phase2 = await evaluate(cdp, PHASE2);
  console.log("===== 切回文本 / 再切表格 / .tsv / .log =====");
  console.log(phase2);
  await shoot(cdp, "02-csv-after-roundtrip.png");

  const phase3 = await evaluate(cdp, PHASE3);
  console.log("===== 截断横幅 =====");
  console.log(phase3);
  await shoot(cdp, "03-csv-truncated.png");

  const phase4 = await evaluate(cdp, PHASE4);
  console.log("===== 换编码（CSV 是文本后端） =====");
  console.log(phase4);

  // 刷新页面：验「会话恢复」把视图模式与分隔符一起带回来。
  await cdp.send("Page.reload", { ignoreCache: false });
  await waitFor(
    async () => await evaluate(cdp, `!!document.querySelector(".tabbar .tab") && !!document.querySelector(".body-view")`),
    20000,
    "刷新后恢复标签页"
  );
  await sleep(1200);

  const phase5 = await evaluate(cdp, PHASE5);
  console.log("===== 会话恢复：视图模式 + 分隔符 =====");
  console.log(phase5);
  await shoot(cdp, "04-csv-restored.png");

  // 把存档改写成 0.5.0 的形态（没有版本号、modes 记着当年的默认 text），
  // 再刷新一次：验「老存档里的 CSV 迁移到表格视图」。
  await evaluate(
    cdp,
    `localStorage.setItem("lv-tabs", JSON.stringify({
       paths: [${JSON.stringify(CSV)}], active: 0, modes: ["text"],
     })); true`
  );
  await cdp.send("Page.reload", { ignoreCache: false });
  await waitFor(
    async () => await evaluate(cdp, `!!document.querySelector(".tabbar .tab") && !!document.querySelector(".body-view")`),
    20000,
    "旧存档刷新后恢复标签页"
  );
  await sleep(1200);
  const phase6 = await evaluate(cdp, PHASE6);
  console.log("===== 老存档迁移（CSV 默认表格） =====");
  console.log(phase6);

  // 再写一份「新版本存档」：显式把该 CSV 放在文本视图，重启后应当保持。
  const migrated = await evaluate(cdp, `localStorage.getItem("lv-tabs")`);
  const archive = JSON.parse(migrated);
  await evaluate(
    cdp,
    `localStorage.setItem("lv-tabs", JSON.stringify({
       version: 2, paths: [${JSON.stringify(CSV)}], active: 0, modes: ["text"],
       delims: ${JSON.stringify(archive.delims ?? [null])},
     })); true`
  );
  await cdp.send("Page.reload", { ignoreCache: false });
  await waitFor(
    async () => await evaluate(cdp, `!!document.querySelector(".tabbar .tab") && !!document.querySelector(".body-view")`),
    20000,
    "新存档刷新后恢复标签页"
  );
  await sleep(1200);
  const phase7 = await evaluate(cdp, PHASE7);
  console.log("===== 新存档：显式的文本视图要被尊重 =====");
  console.log(phase7);
  await shoot(cdp, "05-csv-text-view.png");

  const phase8 = await evaluate(cdp, PHASE8);
  console.log("===== 页内查找：Ctrl+F / 计数 / 滚动定位 / Aa / 全字 =====");
  console.log(phase8);
  await shoot(cdp, "06-csv-find.png");

  cdp.close();
  exitCode =
    /ALL PASSED/.test(phase1) &&
    /ALL PASSED/.test(phase2) &&
    /ALL PASSED/.test(phase3) &&
    /ALL PASSED/.test(phase4) &&
    /ALL PASSED/.test(phase5) &&
    /ALL PASSED/.test(phase6) &&
    /ALL PASSED/.test(phase7) &&
    /ALL PASSED/.test(phase8)
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
