// e2e-settings.mjs — 用真实浏览器（Edge/Chrome + CDP）验收「设置页 + 字体定制」。
//
// 为什么需要它：单测只能覆盖纯规则（字体栈拼装、CSS 是否引用了变量，见
// tools/verify-settings.test.mjs）。而「改成某个字体后，日志正文 / Markdown 正文 /
// 表格单元格**真的**用上了它」属于端到端行为 —— 中间隔着 CSS 变量作用域、
// portal 到 body 的浮层、Markdown 的懒加载 chunk 等一堆单测看不见的地方。
//
// 做法：用 CDP 在页面脚本之前注入一份 mock 的 Tauri 后端（与 e2e-file-missing.mjs
// 同一套路），再驱动真实交互，断言 DOM 与**渲染结果**。
//
// 字体断言分两层：
//   1. CSS 层：计算样式里的 font-family 是否包含所选字体、顺序是否正确；
//   2. 渲染层：用元素的计算字体在 canvas 上量一段西文样本，与该字体单独量的宽度比对 ——
//      相等即证明这些字形真的是那个字体画的（不只是样式表里写着）。
//      注：中文侧做不到同样的判据 —— 所有中文字体的全角汉字都是一个 em 宽，
//      换字体只变字形不变宽度；因此中文以「顺序 + 已安装 + 计算样式」为准，
//      另外把汉字的墨迹高度（actualBoundingBoxAscent）作为观测值打印出来供人工比对。
//
// 用法：
//   1) pnpm run dev                 # Vite dev server（127.0.0.1:5173）
//   2) node tools/e2e-settings.mjs --launch
//      （--launch 自己拉起无头 Edge 并在结束时关掉；也可先手动起浏览器再用 --port 指定端口）
//
// 覆盖的场景：
//   1. 工具栏齿轮打开设置模态框（内容齐全：外观 / 非中文字体 / 中文字体 / 字号 / 预览）；
//   2. 选「非中文字体 = Courier New」「中文字体 = SimSun」→ CSS 变量、日志正文计算样式、
//      渲染宽度、预览区、实际字体栈展示、localStorage 全部同步；
//   3. 字号滑块（含从旧版 lv-fontsize 迁移进来的初值）；
//   4. 关掉设置页后，日志 / Markdown 正文 / Markdown 源码 / 表格单元格三种视图统一生效；
//      portal 到 <body> 的菜单浮层也生效（字体变量写在 <html> 上的意义）；
//   5. 刷新页面 → 设置仍在（持久化）；
//   6. 「恢复默认设置」→ 变量与正文回到内置字体栈。
//
// 传 --shot <目录> 时会在阶段之间导出截图（人工确认观感，也可直接用作文档配图）。
//
// 所有断言在最后统一汇总（失败不中断，保证 CDP 调用方总能拿到观测结果）。

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ==================== 测试数据 ====================

const LOG = "D:\\Logs\\game_inst21.log";
const MD = "D:\\Logs\\notes\\readme.md";
const BIN = "D:\\Logs\\cfg\\client_cfg\\default\\pic_guide_data.bin";
const SCHEMA = "C:\\Users\\me\\AppData\\Roaming\\com.loglens.LogLens\\schemas\\cfg_table_slots.json";
const VERSION = "0.0.0-e2e";

/** 两个「字体族名」的选用原则：本机（Windows）默认就装，且宽度差异明显。 */
const LATIN_FONT = "Courier New";
const CJK_FONT = "SimSun";

/**
 * mock 的系统字体集（后端 `list_system_fonts` 的返回）。
 *
 * 字段与后端一致：`cjk` / `mono` 是**字体自己声明的事实**
 * （DirectWrite `HasCharacter` / `IsMonospacedFont`），前端不再自己探测 ——
 * 汉字在所有中文字体里都是一个 em 宽，页面上量宽度分不出中文字体。
 *
 * `en` / `zh` 是同一族的两条本地化名：mock 会按请求的界面语言选展示名，
 * 另一条放进 `aliases` —— 与后端 `list_system_fonts(lang)` 的行为一致。
 *
 * 覆盖三种分组：等宽 2（Consolas / Courier New）、含中文字形 2
 * （SimSun 宋体 / Microsoft YaHei 微软雅黑）、其它 1（Segoe UI）。
 */
const SYSTEM_FONTS = [
  { family: "Consolas", en: "Consolas", zh: "Consolas", cjk: false, mono: true },
  { family: "Courier New", en: "Courier New", zh: "Courier New", cjk: false, mono: true },
  { family: "Segoe UI", en: "Segoe UI", zh: "Segoe UI", cjk: false, mono: false },
  { family: "SimSun", en: "SimSun", zh: "宋体", cjk: true, mono: false },
  { family: "Microsoft YaHei", en: "Microsoft YaHei", zh: "微软雅黑", cjk: true, mono: false },
];

/** 生成注入页面用的 mock 字体表（按语言投影，与后端同样把另一条名字放进 aliases）。 */
const mockSystemFontsJs = () => `
  window.__e2eFontsFor = (lang) => {
    const useEn = lang === "en";
    return ${JSON.stringify(SYSTEM_FONTS)}.map((f) => {
      const display = useEn ? f.en : f.zh;
      return {
        family: f.family,
        display,
        aliases: [useEn ? f.zh : f.en].filter((n) => n && n !== display),
        cjk: f.cjk,
        mono: f.mono,
      };
    });
  };
`;

/** 老的字号存档：验证旧键会被迁移进来（见 lv-fontsize）。 */
const LEGACY_FONT_SIZE = 18;
/** 滑块调到的新字号。 */
const NEW_FONT_SIZE = 16;

/** 内置默认字体栈（App.css 的 --font-latin / --font-cjk 初值）。 */
const DEFAULT_LATIN = '"Consolas", "Cascadia Mono", "Courier New"';

/** 渲染层判据用的西文样本：字符宽度差异大，字体不对时宽度差很远。 */
const SAMPLE = "iiiiiiiiiiiiWWWWWWWWWWWW";

const WAIT_MS = Number(process.env.E2E_WAIT_MS ?? 450);

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

/** Markdown 文档：中英文混排，覆盖正文与代码两种字体口径。 */
const DOC_LINES = [
  "# 字体设置验收",
  "",
  "正文段落：中文与 Latin 混排，**加粗**。",
  "",
  "```js",
  "const answer = 42; // 代码块",
  "```",
].join("\n");

/** 生成注入脚本；路径用 JSON.stringify 注入，避免反斜杠转义地狱。 */
const buildInitScript = () => `
(() => {
  const LOG = ${JSON.stringify(LOG)};
  const MD = ${JSON.stringify(MD)};
  const DOC = ${JSON.stringify(DOC_LINES)};
  const VERSION = ${JSON.stringify(VERSION)};
  const LEGACY_FONT_SIZE = ${JSON.stringify(String(LEGACY_FONT_SIZE))};

  // 只在本标签页会话的**首次**加载时播种：刷新页面（持久化用例）时必须保留
  // 应用自己写下的 lv-settings，否则「设置存下来了」这件事根本测不到。
  // sessionStorage 恰好跨刷新存活、跨新标签页不共享。
  if (!sessionStorage.getItem("__lvE2ESeeded")) {
    sessionStorage.setItem("__lvE2ESeeded", "1");
    localStorage.removeItem("lv-settings");
    // 旧版本只存标量字号：用它验证启动时的迁移
    localStorage.setItem("lv-fontsize", LEGACY_FONT_SIZE);
    localStorage.setItem("lv-tabs", JSON.stringify({ paths: [LOG], active: 0 }));
    localStorage.setItem("lv-recent", JSON.stringify([LOG]));
    localStorage.setItem("lv-lang", "zh");
    localStorage.setItem("lv-theme", ${JSON.stringify(THEME)});
  }

  window.__e2eClipboard = null;
  Object.defineProperty(Object.getPrototypeOf(navigator), "clipboard", {
    configurable: true,
    get: () => ({ writeText: async (t) => { window.__e2eClipboard = t; } }),
  });

  const tabs = new Map();
  const eventHandlers = new Map();
  window.__e2eDialogPath = null;
  window.__e2eCalls = [];
  /**
   * mock 的「系统字体集」：形状与后端 DirectWrite 枚举一致（family = CSS 名，
   * display = 界面语言对应的本地化名，aliases = 其它本地化名）。
   * 全部取自本机真装了的字体 —— 设置页会用它们真的去渲染，断言才有意义。
   */
  ${mockSystemFontsJs()}

  const linesFor = (path) => [
    { file_offset: 1, file_line: 1, text: "[INFO] loaded " + path },
    { file_offset: 2, file_line: 2, text: "[WARN] sample line 2 iiilllOOO0" },
    { file_offset: 3, file_line: 3, text: "[ERROR] sample line 3 中文日志行" },
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
        const lines = linesFor(args.path);
        tabs.set(args.tabId, { path: args.path, lines });
        emit("log-lines", {
          tab_id: args.tabId, lines, reset: true, total_lines: lines.length, avg_line_len: 20,
        });
        return null;
      }
      case "read_text_file": {
        return { text: DOC, bytes: DOC.length, truncated: false };
      }
      case "stat_text_file": {
        return { mtimeMs: 1000, size: DOC.length };
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
        const name = String(args.path).split(/[\\\\/]/).pop() || "schema.json";
        return "C:\\\\Users\\\\me\\\\AppData\\\\Roaming\\\\com.loglens.LogLens\\\\schemas\\\\" + name;
      }
      case "plugin:dialog|open":
        return window.__e2eDialogPath;
      case "plugin:opener|reveal_item_in_dir":
        return null;
      case "list_system_fonts":
        // 设置页的字体下拉：真实后端走 DirectWrite 枚举（src-tauri/src/fonts.rs）
        return window.__e2eFontsFor ? window.__e2eFontsFor(args.lang) : null;
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
  const q = (sel) => document.querySelector(sel);
  const panels = () => [...document.querySelectorAll(".tab-panel")];
  const visiblePanel = () => panels().find((p) => p.getBoundingClientRect().height > 0);
  const view = () => visiblePanel()?.querySelector(".body-view")?.dataset.view ?? null;
  const click = async (el, wait = ${WAIT_MS}) => { el.click(); await sleep(wait); };
  const cssVar = (name) => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return v.trim();
  };
  /** 元素的最终字体族列表（var() 已解析）。 */
  const fontFamilyOf = (el) => (el ? getComputedStyle(el).fontFamily : null);
  const fontSizeOf = (el) => (el ? getComputedStyle(el).fontSize : null);
  /** 取某个元素上解析后的自定义属性值（--log-font-size 是内联在 .loglens 上的）。 */
  const cssVar2 = (sel, name) => {
    const el = q(sel);
    return el ? getComputedStyle(el).getPropertyValue(name).trim() : null;
  };
  /**
   * 字体族在计算样式列表里的位置（不在列表里返回 -1）。
   * 注意：计算值会把 "SimSun" 这类合法标识符上的引号去掉，只保留 "Courier New"
   * 这种含空格的引号，所以比较前必须把引号统一剥掉。
   */
  const familyIndex = (list, family) => {
    if (!list) return -1;
    const flat = String(list).replace(/["']/g, "");
    return flat.toLowerCase().indexOf(family.replace(/["']/g, "").toLowerCase());
  };
  /** 用「元素自己量到的字体」与「期望字体」分别量同一段文字，宽度一致即证明用的就是它。 */
  const renderedWith = (el, sample, family) => {
    if (!el) return { stack: null, family: null, same: false };
    const cs = getComputedStyle(el);
    const ctx = document.createElement("canvas").getContext("2d");
    const spec = (f) => cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " " + f;
    ctx.font = spec(cs.fontFamily);
    const withStack = ctx.measureText(sample).width;
    ctx.font = spec('"' + family + '"');
    const withFamily = ctx.measureText(sample).width;
    return { stack: withStack, family: withFamily, same: Math.abs(withStack - withFamily) < 0.5 };
  };
  /** 汉字在指定字体下的墨迹高度（所有中文字体汉字都是全角，宽度没有区分度，用高度观测）。 */
  const cjkInkHeight = (el, ch) => {
    const cs = getComputedStyle(el);
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
    const m = ctx.measureText(ch);
    return { ascent: m.actualBoundingBoxAscent, width: m.width };
  };
  /** 给受控的 <select> / <input> 赋值并触发 React 的 onChange。 */
  const setControl = (el, value) => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const openSettings = async () => {
    await click(q("button.settings-btn"), ${WAIT_MS});
    return !!q(".settings-modal");
  };
  const pickFont = async (role, family) => {
    const field = q('[data-font-role="' + role + '"]');
    setControl(field.querySelector(".settings-select"), family);
    await sleep(${WAIT_MS});
  };
`;

const PHASE1 = `
(async () => {
  ${HELPERS}
  const obs = [];
  const fails = [];
  const check = (cond, msg) => { if (!cond) fails.push(msg); };
  const push = (k, v) => obs.push(k.padEnd(32) + " = " + JSON.stringify(v));

  const LATIN = ${JSON.stringify(LATIN_FONT)};
  const CJK = ${JSON.stringify(CJK_FONT)};
  const SAMPLE = ${JSON.stringify(SAMPLE)};
  const DEFAULT_LATIN = ${JSON.stringify(DEFAULT_LATIN)};
  const LEGACY = ${JSON.stringify(LEGACY_FONT_SIZE)};
  const NEW_SIZE = ${JSON.stringify(NEW_FONT_SIZE)};

  try {
    // ---------- 1. 打开设置页 ----------
    push("modal opened", await openSettings());
    const modal = q(".settings-modal");
    check(!!modal, "工具栏齿轮应打开设置模态框");
    const text = modal ? modal.textContent : "";
    push("has appearance", /外观/.test(text));
    push("has latin field", !!q('[data-font-role="latin"] .settings-select'));
    push("has cjk field", !!q('[data-font-role="cjk"] .settings-select'));
    push("has preview", !!q(".settings-preview"));
    push("has size slider", !!q(".settings-range"));
    check(/外观/.test(text) && /字体/.test(text), "设置页应包含外观与字体两节");
    check(!!q('[data-font-role="latin"] .settings-select'), "缺少「非中文字体」选择框");
    check(!!q('[data-font-role="cjk"] .settings-select'), "缺少「中文字体」选择框");
    check(!!q(".settings-preview-table"), "预览区应含表格样例");
    check(!!q(".settings-preview-md"), "预览区应含 Markdown 样例");

    // 下拉里应有分类分组（等宽 / 含中文字形 / 其它）
    const groups = [...document.querySelectorAll('[data-font-role="latin"] optgroup')].map((g) => g.label);
    push("latin optgroups", groups);
    check(groups.some((g) => /等宽/.test(g)), "非中文字体下拉应把等宽字体分组");
    /**
     * 取某个分组的条数。注意：本文件是模板字符串，页面里跑的代码**不能写
     * 反斜杠转义**（\\s 会先被 Node 吃掉变成 s）—— 这里只用字符类，不用转义。
     */
    const countIn = (label) => {
      const label2 = groups.find((x) => x.indexOf(label) === 0);
      if (!label2) return null;
      const digits = label2.replace(/[^0-9]/g, "");
      return digits === "" ? null : Number(digits);
    };

    // ---------- 1b. 字体列表来自后端枚举的系统字体集 ----------
    const source = q('[data-font-role="latin"] .settings-count')?.textContent ?? "";
    push("font source label", source);
    check(/系统字体/.test(source), "应显示字体来源是系统字体，实际 " + source);
    check(source.indexOf("5") >= 0, "应显示系统字体条数（mock 给了 5 个），实际 " + source);

    const optionValues = [...document.querySelectorAll('[data-font-role="latin"] option')].map((o) => o.value);
    push("latin option values", optionValues);
    for (const f of ${JSON.stringify(SYSTEM_FONTS.map((f) => f.family))}) {
      check(optionValues.includes(f), "下拉里缺少系统字体 " + f);
    }
    // 本地化名要出现在展示文本里（中文界面下「微软雅黑」而不是 "Microsoft YaHei"）
    const yaheiOption = [...document.querySelectorAll('[data-font-role="latin"] option')]
      .find((o) => o.value === "Microsoft YaHei");
    push("yahei option text", yaheiOption?.textContent ?? null);
    check(/微软雅黑/.test(yaheiOption?.textContent ?? ""), "选项应显示本地化名（微软雅黑）");
    // 分组计数：等宽 2（Consolas / Courier New）、含中文字形 2（SimSun / 微软雅黑）、其它 1（Segoe UI）
    push("group labels", groups);
    push("group counts", [countIn("等宽字体"), countIn("含中文字形"), countIn("其它字体")]);
    check(countIn("等宽字体") === 2, "等宽组计数不对：" + JSON.stringify(groups));
    check(countIn("含中文字形") === 2, "中文字形组计数不对：" + JSON.stringify(groups));
    check(countIn("其它字体") === 1, "其它组计数不对：" + JSON.stringify(groups));

    // 搜索框：中文名与英文名都要能搜到，搜不到时给出显式提示
    const search = q('[data-font-role="latin"] .settings-search');
    check(!!search, "长列表需要搜索框");
    setControl(search, "宋体");
    await sleep(${WAIT_MS});
    const filtered = [...document.querySelectorAll('[data-font-role="latin"] option')].map((o) => o.value);
    push("filtered by 宋体", filtered);
    check(
      filtered.includes("SimSun") && filtered.length < optionValues.length,
      "按中文名搜索应把列表收窄到 SimSun，实际 " + JSON.stringify(filtered)
    );
    setControl(search, "yahei");
    await sleep(${WAIT_MS});
    const filteredEn = [...document.querySelectorAll('[data-font-role="latin"] option')].map((o) => o.value);
    push("filtered by yahei", filteredEn);
    check(
      filteredEn.includes("Microsoft YaHei"),
      "按英文名搜索也应命中（family 名参与匹配），实际 " + JSON.stringify(filteredEn)
    );
    setControl(search, "zzzz");
    await sleep(${WAIT_MS});
    push("no-match note", q('[data-font-role="latin"] .settings-note')?.textContent ?? null);
    check(
      /没有匹配/.test(q('[data-font-role="latin"] .settings-note')?.textContent ?? ""),
      "搜不到时应给出「没有匹配…」提示，而不是让下拉空着"
    );
    setControl(search, "");
    await sleep(${WAIT_MS});

    // ---------- 1c. 跨语言搜索：英文界面下按中文名也要能搜到 ----------
    // 界面切成英文后展示名变成 "Microsoft YaHei"，中文名只剩在 aliases 里
    // （后端同样如此）。用户在系统里认的是「雅黑」，所以这条不能断。
    const enBtn = [...document.querySelectorAll(".settings-seg button")].find((b) => /English/.test(b.textContent));
    await click(enBtn, ${WAIT_MS});
    const enOption = [...document.querySelectorAll('[data-font-role="latin"] option')]
      .find((o) => o.value === "Microsoft YaHei");
    push("option text (en UI)", enOption?.textContent ?? null);
    check(
      /Microsoft YaHei/.test(enOption?.textContent ?? ""),
      "切到英文界面后展示名应为英文名，实际 " + enOption?.textContent
    );
    setControl(search, "雅黑");
    await sleep(${WAIT_MS});
    const crossLang = [...document.querySelectorAll('[data-font-role="latin"] option')].map((o) => o.value);
    push("cross-language search in en UI", crossLang);
    check(
      crossLang.includes("Microsoft YaHei"),
      "英文界面下按中文名搜索应命中别名，实际 " + JSON.stringify(crossLang)
    );
    setControl(search, "");
    await sleep(${WAIT_MS});
    // 切回中文：后面的断言都在中文界面下进行
    const zhBtn = [...document.querySelectorAll(".settings-seg button")].find((b) => /中文/.test(b.textContent));
    await click(zhBtn, ${WAIT_MS});

    // ---------- 2. 字号：旧键迁移 + 滑块 ----------
    push("size after migration", q(".font-label")?.textContent);
    check(q(".font-label")?.textContent === LEGACY + "px", "旧版 lv-fontsize 应被迁移为初始字号，实际 " + q(".font-label")?.textContent);
    const rowBefore = q(".tab-panel .row");
    push("row font-size (migrated)", fontSizeOf(rowBefore));
    check(fontSizeOf(rowBefore) === LEGACY + "px", "迁移后的字号应作用到日志正文");

    setControl(q(".settings-range"), String(NEW_SIZE));
    await sleep(${WAIT_MS});
    push("size after slider", q(".font-label")?.textContent);
    push("row font-size (slider)", fontSizeOf(q(".tab-panel .row")));
    push("--log-font-size (on .loglens)", cssVar2(".loglens", "--log-font-size"));
    check(q(".font-label")?.textContent === NEW_SIZE + "px", "滑块应改变工具栏字号显示");
    check(fontSizeOf(q(".tab-panel .row")) === NEW_SIZE + "px", "滑块应作用到日志正文");

    // ---------- 3. 选字体 ----------
    push("--font-latin before", cssVar("--font-latin"));
    check(cssVar("--font-latin") === DEFAULT_LATIN, "初始 --font-latin 应为内置默认栈");

    await pickFont("latin", LATIN);
    await pickFont("cjk", CJK);

    push("--font-latin", cssVar("--font-latin"));
    push("--font-cjk", cssVar("--font-cjk"));
    check(cssVar("--font-latin") === '"' + LATIN + '"', "选中的非中文字体应写进 --font-latin，实际 " + cssVar("--font-latin"));
    check(cssVar("--font-cjk") === '"' + CJK + '"', "选中的中文字体应写进 --font-cjk，实际 " + cssVar("--font-cjk"));

    // 设置页自己展示的「实际字体栈」
    const stackText = q(".settings-stack-value")?.textContent ?? "";
    push("stack shown in modal", stackText);
    check(stackText === '"' + LATIN + '", "' + CJK + '", monospace', "实际字体栈展示不对: " + stackText);

    // ---------- 4. 日志正文：计算样式 + 真实渲染宽度 ----------
    const row = q(".tab-panel .row");
    const ff = fontFamilyOf(row);
    push("log row font-family", ff);
    check(familyIndex(ff, LATIN) >= 0, "日志正文应包含所选非中文字体");
    check(
      familyIndex(ff, CJK) > familyIndex(ff, LATIN),
      "中文字体必须排在非中文字体之后（顺序即优先级），实际 " + ff
    );

    const rendered = renderedWith(row, SAMPLE, LATIN);
    push("log rendered width", rendered);
    check(rendered.same, "日志正文的西文字形应真的由 " + LATIN + " 渲染（宽度不符）");

    const inkDefault = cjkInkHeight(row, "中");
    push("log CJK ink (chosen)", inkDefault);

    // 预览区也跟随（它就是 .row 那套样式的缩影）
    const previewRow = q(".settings-preview-log");
    push("preview font-family", fontFamilyOf(previewRow));
    check(familyIndex(fontFamilyOf(previewRow), LATIN) >= 0, "预览区应跟随所选字体");

    // ---------- 5. 持久化 ----------
    const stored = localStorage.getItem("lv-settings");
    push("lv-settings", stored);
    const parsed = stored ? JSON.parse(stored) : null;
    check(parsed?.latinFont === LATIN, "lv-settings 应记下非中文字体");
    check(parsed?.cjkFont === CJK, "lv-settings 应记下中文字体");
    check(parsed?.fontSize === NEW_SIZE, "lv-settings 应记下新字号");
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
  const push = (k, v) => obs.push(k.padEnd(32) + " = " + JSON.stringify(v));

  const LATIN = ${JSON.stringify(LATIN_FONT)};
  const CJK = ${JSON.stringify(CJK_FONT)};
  const SAMPLE = ${JSON.stringify(SAMPLE)};
  const MD = ${JSON.stringify(MD)};
  const BIN = ${JSON.stringify(BIN)};
  const SCHEMA = ${JSON.stringify(SCHEMA)};
  const NEW_SIZE = ${JSON.stringify(NEW_FONT_SIZE)};

  /** 三个视图共用的断言：计算样式 + 渲染宽度 + 字号。 */
  const checkView = (name, sel) => {
    const el = q(sel);
    check(!!el, name + ": 找不到 " + sel);
    if (!el) return;
    const ff = fontFamilyOf(el);
    push(name + " font-family", ff);
    check(familyIndex(ff, LATIN) >= 0, name + " 未跟随非中文字体设置");
    check(
      familyIndex(ff, CJK) > familyIndex(ff, LATIN),
      name + " 的中文字体顺序不对（实际 " + ff + "）"
    );
    const r = renderedWith(el, SAMPLE, LATIN);
    push(name + " rendered", r);
    check(r.same, name + " 的西文字形没有真的用上 " + LATIN);
    push(name + " font-size", fontSizeOf(el));
    check(fontSizeOf(el) === NEW_SIZE + "px", name + " 未跟随正文字号（实际 " + fontSizeOf(el) + "）");
  };

  try {
    // ---------- 6. 关掉设置页，正文保持 ----------
    await click(q(".settings-close"), ${WAIT_MS});
    push("modal closed", !q(".settings-modal"));
    check(!q(".settings-modal"), "点「关闭」应收起设置页");
    checkView("log", ".tab-panel .row");

    // portal 到 <body> 的浮层：字体变量必须写在 <html> 上才能覆盖它
    await click(q("button.menu-btn"), 250);
    const menu = q(".app-menu");
    push("portal menu font-family", fontFamilyOf(menu));
    check(!!menu, "总菜单应能打开");
    check((fontFamilyOf(menu) ?? "").indexOf('"' + LATIN + '"') >= 0, "portal 到 body 的菜单未跟随字体设置");
    await click(q("button.menu-btn"), 250);

    // ---------- 7. Markdown 视图 ----------
    window.__lvOpenPath(MD);
    await sleep(900);
    push("md view", view());
    check(view() === "md-view", "Markdown 文件应打开为预览页，实际 " + view());
    checkView("markdown body", ".md-body");

    // 预览 → 源码（.md-mode 两个按钮里的「源码」）
    const srcBtn = [...document.querySelectorAll(".md-mode")].find((b) => /源码/.test(b.textContent));
    await click(srcBtn, 400);
    checkView("markdown source", ".md-source");

    // ---------- 8. 表格视图 ----------
    window.__lvOpenPath(BIN);
    await sleep(700);
    window.__e2eDialogPath = SCHEMA;
    await click(q(".view-toggle"), 300);
    await click(q(".viewmode-schema-add"), 500);
    const item = [...document.querySelectorAll(".viewmode-item")].find((b) => b.textContent.includes("表格视图"));
    await click(item, 900);
    push("cfg view", view());
    check(view() === "cfg-table", "应切到表格视图，实际 " + view());
    checkView("table cell", ".cfg-cell");
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
  const push = (k, v) => obs.push(k.padEnd(32) + " = " + JSON.stringify(v));

  const LATIN = ${JSON.stringify(LATIN_FONT)};
  const CJK = ${JSON.stringify(CJK_FONT)};
  const SAMPLE = ${JSON.stringify(SAMPLE)};
  const DEFAULT_LATIN = ${JSON.stringify(DEFAULT_LATIN)};
  const NEW_SIZE = ${JSON.stringify(NEW_FONT_SIZE)};

  try {
    // ---------- 9. 刷新后设置仍在 ----------
    // 刷新后活动 tab 是上次激活的那个（表格），先切回第一个（日志）tab。
    push("tabs restored", document.querySelectorAll(".tabbar .tab").length);
    check(document.querySelectorAll(".tabbar .tab").length === 3, "刷新后应恢复 3 个 tab");
    await click(document.querySelectorAll(".tabbar .tab")[0], 700);
    push("active view", view());
    check(view() === "text-log", "应能切回日志 tab，实际 " + view());

    push("--font-latin (after reload)", cssVar("--font-latin"));
    push("--font-cjk (after reload)", cssVar("--font-cjk"));
    push("row font-size (after reload)", fontSizeOf(q(".tab-panel .row")));
    check(cssVar("--font-latin") === '"' + LATIN + '"', "刷新后应恢复所选非中文字体");
    check(cssVar("--font-cjk") === '"' + CJK + '"', "刷新后应恢复所选中文字体");
    check(fontSizeOf(q(".tab-panel .row")) === NEW_SIZE + "px", "刷新后应恢复字号");

    const r = renderedWith(q(".tab-panel .row"), SAMPLE, LATIN);
    push("log rendered (after reload)", r);
    check(r.same, "刷新后日志正文的西文字形应仍由 " + LATIN + " 渲染");

    const stored = localStorage.getItem("lv-settings");
    push("lv-settings (after reload)", stored);
    check(JSON.parse(stored ?? "null")?.latinFont === LATIN, "刷新后 localStorage 里的设置应保持");

    // ---------- 10. 恢复默认 ----------
    await openSettings();
    await click(q(".settings-reset"), ${WAIT_MS});
    push("--font-latin (after reset)", cssVar("--font-latin"));
    push("--font-cjk (after reset)", cssVar("--font-cjk"));
    check(cssVar("--font-latin") === DEFAULT_LATIN, "恢复默认后 --font-latin 应回到内置栈");
    check(/Microsoft YaHei/.test(cssVar("--font-cjk")), "恢复默认后 --font-cjk 应回到内置栈");

    const row = q(".tab-panel .row");
    push("log font-family (after reset)", fontFamilyOf(row));
    check((fontFamilyOf(row) ?? "").indexOf("Consolas") >= 0, "恢复默认后日志正文应回到内置字体栈");
    check(fontSizeOf(row) === "12px", "恢复默认后字号应回到 12px，实际 " + fontSizeOf(row));

    const after = JSON.parse(localStorage.getItem("lv-settings") ?? "null");
    push("lv-settings (after reset)", after);
    check(after?.latinFont === "" && after?.cjkFont === "" && after?.fontSize === 12, "恢复默认后存档也应是默认值");

    // 设置页里两个下拉都应显示回「默认」项（value=""）
    push("latin select value", q('[data-font-role="latin"] .settings-select')?.value);
    check(q('[data-font-role="latin"] .settings-select')?.value === "", "恢复默认后非中文字体下拉应回到「默认」");
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
      `--user-data-dir=${process.env.TEMP ?? "."}\\loglens-e2e-settings-profile`,
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

  const waitForApp = () =>
    waitFor(
      async () =>
        await evaluate(
          cdp,
          `!!document.querySelector(".body-view") && !!document.querySelector(".tabbar .tab")`
        ),
      20000,
      "LogLens 首屏"
    );

  await waitForApp();
  await sleep(500);

  const phase1 = await evaluate(cdp, PHASE1);
  console.log("===== 设置页 / 字体选择 / 字号 / 持久化 =====");
  console.log(phase1);
  await shoot(cdp, "01-settings-modal.png");

  const phase2 = await evaluate(cdp, PHASE2);
  console.log("===== 日志 / Markdown / 表格三视图统一生效 =====");
  console.log(phase2);
  await shoot(cdp, "02-views-table.png");
  // 切回 Markdown tab（并回到预览模式）再截一张：中英混排的正文与源码都该是新字体
  await evaluate(cdp, `document.querySelectorAll(".tabbar .tab")[1]?.click(); true`);
  await sleep(600);
  await evaluate(
    cdp,
    `(() => {
       const btn = [...document.querySelectorAll(".md-mode")].find((b) => /预览|Preview/.test(b.textContent));
       if (btn && !btn.classList.contains("on")) btn.click();
       return true;
     })()`
  );
  await sleep(500);
  await shoot(cdp, "03-views-markdown.png");

  // 刷新页面：设置应从 localStorage 恢复
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitForApp();
  await sleep(400);

  const phase3 = await evaluate(cdp, PHASE3);
  console.log("===== 刷新持久化 / 恢复默认 =====");
  console.log(phase3);
  await shoot(cdp, "04-after-reload.png");

  cdp.close();
  exitCode =
    /ALL PASSED/.test(phase1) && /ALL PASSED/.test(phase2) && /ALL PASSED/.test(phase3) ? 0 : 1;
} catch (e) {
  console.error("E2E 运行失败:", e?.stack ?? e);
} finally {
  if (browser) {
    browser.kill();
  }
}

process.exit(exitCode);
