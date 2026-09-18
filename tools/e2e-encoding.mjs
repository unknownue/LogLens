// e2e-encoding.mjs — 用真实浏览器（Edge/Chrome + CDP）验收「底部状态栏 + 编码弹窗」。
//
// 为什么需要它：单测（tools/verify-encoding.test.mjs）只能覆盖纯规则（分组顺序、
// 显示名、预览裁剪、前后端契约）与「模块有没有接上线」。而「行数真的出现在窗口最
// 底部」「点编码名真的弹出可选列表、选中项真的换预览、点应用正文真的换一种解码」
// 属于端到端行为 —— 中间隔着 React 状态、Tauri 的 log-lines 事件通道、虚拟滚动的
// 分段缓存，这些都是单测看不见的地方。
//
// 做法：用 CDP 在页面脚本之前注入一份 mock 的 Tauri 后端（与 e2e-settings.mjs /
// e2e-file-missing.mjs 同一套路），再驱动真实交互，断言 DOM。
//
// mock 的保真度（宁可多写十几行，也不要把「解出来是什么」写死）：
//   - **目录**逐项照抄 src-tauri/src/encoding.rs 的 CATALOG（id / 展示名 / 别名 / 分组）；
//   - **解码是真的**：两个夹具都在内存里造出**真实字节**（UTF-8 + BOM / GBK），mock 用
//     浏览器自己的 TextDecoder 按所选编码解码。GBK 的字节由 TextDecoder("gb18030")
//     反查出来的小字节表拼出 —— 浏览器与 Node 都只能解这些传统编码（TextEncoder
//     只支持 UTF-8），反查一遍双字节空间是零依赖拿到真实字节的唯一办法；
//   - **探测是真的**：`auto` 走 BOM → 合法 UTF-8 → 兜底 GB18030，顺序同 detect_sample；
//   - **事件是真的**：open_log_file / set_encoding 都往 log-lines 通道推事件
//     （set_encoding 带 reset = true），且载荷的 `apply_when_paused` 与后端
//     `LinesPayload` 同一口径（用户动作 = true / 实时批次 = false）；
//     前端跑的就是生产的那条数据链路。
//
// 用法：
//   1) pnpm run dev                    # Vite dev server（127.0.0.1:5173）
//   2) node tools/e2e-encoding.mjs --launch
//      （--launch 自己拉起无头 Edge 并在结束时关掉；也可先手动起浏览器，再用 --port 指定端口）
//
// 覆盖的场景：
//   1. 状态栏贴在窗口最底部：左侧是活动 tab 的总行数（带千分位），右侧是可点的编码名；
//   2. 带 BOM 的 UTF-8 文件显示成 `UTF-8 BOM`（有没有 BOM 是排查首行怪问题的第一线索）；
//   3. 点编码名 → 弹窗列出「自动 + 后端目录」的全部编码，含中 / 日 / 韩 / 西文分组标题；
//   4. 选中项一变，右侧预览就换成「按这个编码解出来的文本」，选中态同时跟着走；
//   5. 选中与生效编码不同时「应用」才可用；应用后：弹窗关闭、后端收到带 id 的
//      set_encoding、状态栏换成新解析出来的编码名、**正文真的按新编码重解**；
//   6. 新打开时默认选中「自动检测」，此时「应用」不可用（没得应用）；
//   7. 回归：工具栏右上角的旧行数（.total-lines）不该还在 DOM 里；
//   8. Esc 关闭弹窗；
//   9. 用 `window.__lvOpenPath` 打开第二个文件（等价于用户从文件对话框选中它）→ 新 tab
//      的状态栏是它自己的行数与编码；切回第一个 tab 又换回它自己的（都是 per-tab 的）；
//  10. 刷新 → 手动选过的编码随会话存档恢复（状态栏与正文都还是那份选择），
//      而 `auto` 的 tab 不会被固化成上次探测到的具体编码。
//  11. **关掉「自动刷新」后换编码，正文仍要真的重解**（`apply_when_paused` 的回归点）：
//      暂停跟随时 `log-lines` 监听器曾把**每一批**都丢掉，换编码于是「状态栏换了、
//      正文没换」且永不自愈（那个事件不会再发第二次）。现在用户动作引起的会话重建
//      （打开文件 / 换编码）载荷带 `apply_when_paused = true`，越得过暂停闸门；
//  12. 负向对照：同一时刻推一批**实时**数据（轮转 / 截断那种 reset 批次，
//      `apply_when_paused = false`），暂停跟随时正文与总行数都必须纹丝不动；
//  13. 正向对照：把自动刷新打开，同一批实时数据立刻生效 —— 反证 12 的「没变」
//      不是「mock 没发出去 / 前端没收到」，而是暂停闸门真的在按载荷字段分流。
//
// 传 --shot <目录> 时会在阶段之间导出截图（人工确认观感，也可直接用作文档配图）。
//
// 所有断言在最后统一汇总（失败不中断，保证 CDP 调用方总能拿到观测结果）。

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ==================== 测试数据 ====================

/** 主用例：UTF-8 + BOM、1234 行 —— 既要有千分位，也要有 `UTF-8 BOM` 这个后缀。 */
const LOG_A = "D:\\Logs\\e2e\\zh_utf8_bom.log";
/** 第二个文件：GBK（代码页 936）写出来的中文日志、120 行 —— 验证切 tab 后状态栏换了人。 */
const LOG_B = "D:\\Logs\\e2e\\zh_gbk_120.log";

/** 两个夹具的行数刻意不同（四位数 / 三位数）：切 tab 时状态栏才看得出换了文件。 */
const LINES_A = 1234;
const LINES_B = 120;

const VERSION = "0.0.0-e2e";

/**
 * mock 的后端编码目录：逐项照抄 `src-tauri/src/encoding.rs` 的 CATALOG。
 *
 * `bom` 是后端目录里每种编码自己的 BOM 字节（`EncodingDef::bom`）。它只供 mock
 * 判断「文件是不是真的有这个 BOM」，不发给前端 —— 后端的 `EncodingOption` 也只有
 * id / name / note / group 四个字段。
 */
const CATALOG = [
  { id: "utf-8", name: "UTF-8", note: "Unicode", group: "unicode", bom: true },
  { id: "utf-16le", name: "UTF-16 LE", note: "Unicode", group: "unicode", bom: true },
  { id: "utf-16be", name: "UTF-16 BE", note: "Unicode", group: "unicode", bom: true },
  { id: "gb18030", name: "GB18030", note: "GBK / GB2312", group: "chinese", bom: false },
  { id: "gbk", name: "GBK", note: "ANSI 936", group: "chinese", bom: false },
  { id: "big5", name: "Big5", note: "ANSI 950", group: "chinese", bom: false },
  { id: "shift_jis", name: "Shift_JIS", note: "ANSI 932", group: "japanese", bom: false },
  { id: "euc-jp", name: "EUC-JP", note: "", group: "japanese", bom: false },
  { id: "euc-kr", name: "EUC-KR", note: "ANSI 949", group: "korean", bom: false },
  {
    id: "windows-1252",
    name: "Windows-1252",
    note: "ANSI 1252 / Latin-1",
    group: "western",
    bom: false,
  },
  { id: "windows-1251", name: "Windows-1251", note: "ANSI 1251", group: "western", bom: false },
  { id: "windows-1250", name: "Windows-1250", note: "ANSI 1250", group: "western", bom: false },
];

/**
 * 一行日志的文本模板（`{n}` 换成行号）。
 *
 * 汉字是刻意的：状态栏两侧的断言之外，「GBK 日志解出来是正常中文而不是一片 U+FFFD」
 * 这条核心行为要看得见，所以每一行都得有中文。
 */
const LINE_TEMPLATE = "[INFO] 第{n}行 中文日志";

/**
 * 用 `TextDecoder("gb18030")` 反查出一张「汉字 → 字节对」的小表。
 *
 * 为什么不用现成的编码库：浏览器与 Node 都只能**解**这些传统编码，而本测试要造一个
 * 「真的是 GBK 字节」的中文日志 —— 否则「GBK 日志不再变成一堆问号」这条最核心的行为
 * 无从验证。反查整个双字节空间（约 2.4 万次 decode）只在启动时做一遍，换来的是
 * 零依赖 + 真实字节；表里缺字就直接报错，绝不静默降级成 '?'（那会让断言形同虚设）。
 */
function buildGbkPairs(text) {
  const needed = new Set([...text].filter((ch) => ch.codePointAt(0) > 0x7f));
  const decoder = new TextDecoder("gb18030");
  const pairs = {};
  let left = needed.size;
  for (let hi = 0x81; hi <= 0xfe && left > 0; hi += 1) {
    for (let lo = 0x40; lo <= 0xfe && left > 0; lo += 1) {
      if (lo === 0x7f) {
        continue;
      }
      const ch = decoder.decode(Uint8Array.of(hi, lo));
      if (ch.length === 1 && needed.has(ch) && pairs[ch] === undefined) {
        pairs[ch] = [hi, lo];
        left -= 1;
      }
    }
  }
  if (left > 0) {
    throw new Error(`GBK 反查表缺 ${left} 个字（共需 ${needed.size} 个），夹具无法造出真实字节`);
  }
  return pairs;
}

const GBK_PAIRS = buildGbkPairs(LINE_TEMPLATE);

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
//
// 只实现被断言流程用到的命令（真实后端见 src-tauri/src/lib.rs 与 encoding.rs）。
// 关键点是「按所选编码真的解一遍字节」，而不是把解出来的文本写死：
// 否则「换编码后正文变了」这句断言只是在替 mock 自己背书。

/** 生成注入脚本；路径/文本用 JSON.stringify 注入，避免反斜杠转义地狱。 */
const buildInitScript = () => `
(() => {
  const LOG_A = ${JSON.stringify(LOG_A)};
  const LOG_B = ${JSON.stringify(LOG_B)};
  const LINES_A = ${JSON.stringify(LINES_A)};
  const LINES_B = ${JSON.stringify(LINES_B)};
  const VERSION = ${JSON.stringify(VERSION)};
  const CATALOG = ${JSON.stringify(CATALOG)};
  const GBK_PAIRS = ${JSON.stringify(GBK_PAIRS)};
  const LINE_TEMPLATE = ${JSON.stringify(LINE_TEMPLATE)};

  // 只在本标签页会话的**首次**加载时播种：刷新用例要看到应用自己写下的
  // lv-tabs（含各 tab 的编码选择），覆盖掉就等于没测。
  // sessionStorage 恰好跨刷新存活、跨新标签页不共享。
  if (!sessionStorage.getItem("__lvE2ESeeded")) {
    sessionStorage.setItem("__lvE2ESeeded", "1");
    localStorage.removeItem("lv-settings");
    localStorage.setItem("lv-tabs", JSON.stringify({ paths: [LOG_A], active: 0 }));
    localStorage.setItem("lv-recent", JSON.stringify([LOG_A]));
    // 界面固定中文：断言直接比对「1,234 行」这类中文文案，不靠界面语言的默认值。
    localStorage.setItem("lv-lang", "zh");
    localStorage.setItem("lv-theme", ${JSON.stringify(THEME)});
  }

  const tabs = new Map();
  /**
   * 事件 → (监听 id → 回调 id)。
   *
   * 一个事件可以有**多份**监听（真后端就是这样）：本测试同时开两个文本 tab，
   * 两个 LogTab 各听一份 log-lines。只留最后一份监听是错的 —— 那样「推给 tab A
   * 的行」会发到 tab B 的监听上，被 tab_id 过滤掉，表现为「换编码后正文没变」。
   */
  const eventHandlers = new Map();
  let nextListenerId = 1;
  window.__e2eCalls = [];
  /** 编码相关调用（带参数）：用来验证「应用」真的把选中的 id 传给了后端。 */
  window.__e2eEncodingCalls = [];

  // ---------- 夹具：真实字节 ----------

  const FIXTURES = [
    { path: LOG_A, lines: LINES_A, onDisk: "utf-8", bom: true },
    { path: LOG_B, lines: LINES_B, onDisk: "gbk", bom: false },
  ];

  /** 路径 → 夹具（Windows 路径大小写不敏感）。 */
  const fixtureOf = (path) => {
    const key = String(path).toLowerCase();
    return FIXTURES.find((f) => f.path.toLowerCase() === key) || null;
  };

  /** 第 n 行的文本。 */
  const lineText = (n) => LINE_TEMPLATE.replace("{n}", String(n));

  /** 整个文件的文本（CRLF 结尾，与 Windows 上写出来的日志一致）。 */
  function fileText(lines) {
    let out = "";
    for (let i = 1; i <= lines; i += 1) {
      out += lineText(i) + "\\r\\n";
    }
    return out;
  }

  /** 每个编码的 BOM 字节（与 encoding.rs 的 EncodingDef::bom 一致）。 */
  const BOM_BYTES = {
    "utf-8": [0xef, 0xbb, 0xbf],
    "utf-16le": [0xff, 0xfe],
    "utf-16be": [0xfe, 0xff],
  };

  function startsWith(bytes, prefix) {
    if (bytes.length < prefix.length) {
      return false;
    }
    for (let i = 0; i < prefix.length; i += 1) {
      if (bytes[i] !== prefix[i]) {
        return false;
      }
    }
    return true;
  }

  /**
   * 夹具文件在磁盘上的真实字节。
   * utf-8 交给 TextEncoder；GBK 只能用注入的字节表逐字拼（TextEncoder 只支持 UTF-8）。
   */
  function fileBytes(fx) {
    const text = fileText(fx.lines);
    if (fx.onDisk === "utf-8") {
      const body = new TextEncoder().encode(text);
      if (!fx.bom) {
        return body;
      }
      const out = new Uint8Array(body.length + 3);
      out.set(BOM_BYTES["utf-8"], 0);
      out.set(body, 3);
      return out;
    }
    const out = [];
    for (const ch of text) {
      const code = ch.codePointAt(0);
      if (code < 0x80) {
        out.push(code);
        continue;
      }
      const pair = GBK_PAIRS[ch];
      if (!pair) {
        throw new Error("GBK 字节表缺字: " + ch);
      }
      out.push(pair[0], pair[1]);
    }
    return Uint8Array.from(out);
  }

  const byId = (id) => CATALOG.find((d) => d.id === id);

  /** 组装 IPC 载荷（字段与后端 encoding::EncodingInfo 一一对应）。 */
  const infoFor = (def, choice, source, bom) => ({
    choice: choice,
    id: def.id,
    name: def.name,
    note: def.note,
    group: def.group,
    source: source,
    bom: bom === true,
  });

  /** 目录 id 恰好都是 WHATWG 的编码标签：可以直接交给 TextDecoder。 */
  function decodeBytes(bytes, id) {
    try {
      return new TextDecoder(id).decode(bytes);
    } catch (e) {
      return null;
    }
  }

  /** 是不是合法 UTF-8（等价于 Rust 的 is_utf8_prefix；夹具很小，不存在采样边界截断）。 */
  function isUtf8(bytes) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 探测：BOM → 合法 UTF-8 → 兜底 GB18030，顺序与 encoding.rs::detect_sample 一致。 */
  function detect(fx) {
    const bytes = fileBytes(fx);
    for (const id of ["utf-8", "utf-16le", "utf-16be"]) {
      if (startsWith(bytes, BOM_BYTES[id])) {
        return infoFor(byId(id), "auto", "bom", true);
      }
    }
    if (isUtf8(bytes)) {
      return infoFor(byId("utf-8"), "auto", "utf8", false);
    }
    // 兜底：非 UTF-8 的中文日志绝大多数是代码页 936 写的，GB18030 是它的严格超集。
    return infoFor(byId("gb18030"), "auto", "fallback", false);
  }

  /** 解析用户的编码选择：auto / 空 → 探测文件；目录 id → 直接用（source = manual）。 */
  function resolve(fx, choice) {
    const raw = String(choice == null ? "" : choice).trim().toLowerCase();
    if (raw === "" || raw === "auto") {
      return detect(fx);
    }
    // 认不出的 id 退化为自动探测，不报错（后端也是这个口径：编码是显示层的东西）。
    const def = byId(raw) || byId(raw.replace("_", "-"));
    if (!def) {
      return detect(fx);
    }
    const bomBytes = BOM_BYTES[def.id];
    return infoFor(def, def.id, "manual", !!bomBytes && startsWith(fileBytes(fx), bomBytes));
  }

  /**
   * 按指定编码把文件解成行（与前端口径一致：CRLF 折行、末尾不产空行）。
   *
   * file_offset 用行号而不是真实字节偏移：前端只把它当分段的键，夹具是多行等长文本，
   * 真实偏移对断言没有任何影响（虚拟滚动与「跳到第 N 行」都不在本测试范围内）。
   */
  function linesOf(fx, id) {
    const text = decodeBytes(fileBytes(fx), id) || "";
    const all = text.split("\\r\\n").join("\\n").split("\\n");
    if (all.length > 1 && all[all.length - 1] === "") {
      all.pop();
    }
    return all.map((t, i) => ({ file_offset: i + 1, file_line: i + 1, text: t }));
  }

  function emit(event, payload) {
    const list = eventHandlers.get(event);
    if (!list || list.size === 0) return;
    for (const id of [...list.values()]) {
      const fn = window["_" + id];
      if (typeof fn === "function") setTimeout(() => fn({ event, payload }), 0);
    }
  }

  /**
   * 按 log-lines 契约推一批行：reset 表示整体替换（打开文件与换编码都如此）。
   *
   * applyPaused 逐字对齐后端 LinesPayload::apply_when_paused（见 src-tauri/src/state.rs）：
   *   - 打开文件 / 换编码是「用户动作」引起的会话重建 → true：暂停跟随（自动刷新关掉）
   *     时也必须生效，否则正文会永远停在旧结果上 —— 那个事件不会再发第二次，不会自愈；
   *   - 监控线程的「实时」批次（追加 / 轮转 / 截断）→ false：暂停跟随时按设计丢弃。
   *
   * mock 少写这一个字段，PHASE4 就变成「替一个不镜像真实契约的 mock 背书」了。
   */
  const emitLines = (tabId, lines, applyPaused) =>
    emit("log-lines", {
      tab_id: tabId,
      lines: lines,
      reset: true,
      apply_when_paused: applyPaused === true,
      total_lines: lines.length,
      avg_line_len: 24,
    });

  /**
   * 造一批「实时」数据：模拟监控线程发现文件被轮转 / 截断后推的那种 reset 批次。
   *
   * 真后端这一类事件由后台线程推、没有对应的 IPC 命令，用例没法从「命令」侧触发它，
   * 只能由 mock 留一个后门 —— 它是 PHASE4 负向对照的抓手（apply_when_paused = false，
   * 暂停跟随时应当被前端丢掉）。按「路径」而不是 tab id 找 tab：前端的 tab id 是它自己
   * 生成的，用例拿不到；路径才是两边都知道的东西。行文本刻意带 LIVE-ROTATED 标记：
   * 万一这批漏进了正文，断言里的观测值一眼就能看出是它。
   */
  window.__e2eEmitLive = (path, count) => {
    const key = String(path).toLowerCase();
    const hit = [...tabs.entries()].find(([, t]) => t.path.toLowerCase() === key);
    if (!hit) return false;
    const [tabId, t] = hit;
    const lines = [];
    for (let i = 1; i <= (count == null ? 5 : count); i += 1) {
      lines.push({ file_offset: i, file_line: i, text: "LIVE-ROTATED 第" + i + "行 轮转后的新内容" });
    }
    t.lines = lines;
    emitLines(tabId, lines, false);
    return true;
  };

  async function invoke(cmd, args = {}) {
    args = args || {};
    window.__e2eCalls.push(cmd);
    switch (cmd) {
      case "open_log_file": {
        const fx = fixtureOf(args.path);
        if (!fx) throw "文件不存在: " + args.path;
        const info = resolve(fx, args.encoding);
        const lines = linesOf(fx, info.id);
        tabs.set(args.tabId, { path: args.path, info: info, lines: lines });
        // apply_when_paused=true：打开文件是用户动作，暂停跟随也得生效。
        emitLines(args.tabId, lines, true);
        return info;
      }
      // 换编码：整体重建会话 + 用 reset 事件把**按新编码重新解出来的**正文推给前端
      //（后端 set_encoding 就是这个行为，前端不需要为换编码写专门的刷新逻辑）。
      case "set_encoding": {
        const t = tabs.get(args.tabId);
        if (!t) throw "tab 不存在: " + args.tabId;
        const fx = fixtureOf(t.path);
        const info = resolve(fx, args.encoding);
        const lines = linesOf(fx, info.id);
        tabs.set(args.tabId, { path: t.path, info: info, lines: lines });
        window.__e2eEncodingCalls.push({
          cmd: cmd,
          args: { tabId: args.tabId, encoding: args.encoding },
        });
        // apply_when_paused=true：换编码也是用户动作 —— 这一条正是 PHASE4 要守的那个契约。
        emitLines(args.tabId, lines, true);
        return info;
      }
      case "get_encoding": {
        const t = tabs.get(args.tabId);
        return t ? t.info : null;
      }
      case "detect_encoding": {
        const fx = fixtureOf(args.path);
        if (!fx) throw "文件不存在: " + args.path;
        return detect(fx);
      }
      case "list_encodings":
        // 后端只发四个字段：BOM 与解码句柄是后端自己的事。
        return CATALOG.map((d) => ({ id: d.id, name: d.name, note: d.note, group: d.group }));
      case "read_text_file": {
        const fx = fixtureOf(args.path);
        if (!fx) throw "文件不存在: " + args.path;
        const bytes = fileBytes(fx);
        const cap = Math.min(args.maxBytes == null ? bytes.length : args.maxBytes, bytes.length);
        const info = resolve(fx, args.encoding);
        // 与后端一致：按字节上限截断后再解码（截断点可能切在多字节字符中间 → U+FFFD）。
        return {
          text: decodeBytes(bytes.subarray(0, cap), info.id) || "",
          bytes: bytes.length,
          truncated: bytes.length > cap,
          encoding: info,
        };
      }
      case "stat_text_file": {
        const fx = fixtureOf(args.path);
        if (!fx) throw "文件不存在: " + args.path;
        return { mtimeMs: 1000, size: fileBytes(fx).length };
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
        const start = args.startLine == null ? 1 : args.startLine;
        return t.lines.slice(start - 1, start - 1 + (args.count == null ? 0 : args.count));
      }
      case "get_block_avg_lens":
        return [24];
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
      case "plugin:event|listen": {
        const ev = args.event || args.target;
        const id = nextListenerId++;
        if (ev) {
          const list = eventHandlers.get(ev) || new Map();
          list.set(id, args.handler);
          eventHandlers.set(ev, list);
        }
        return id;
      }
      case "plugin:event|unlisten": {
        const list = eventHandlers.get(args.event || args.target);
        if (list) list.delete(args.eventId ?? args.id);
        return null;
      }
      case "plugin:app|version":
        return VERSION;
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

  // 启动自检：GBK 夹具必须能按 gb18030 还原回原文。造字节的那张表若缺字，
  // 「GBK 日志解出来是正常中文」这条断言就变成替一个坏掉的 mock 背书了。
  window.__e2eSelfCheck = {
    gbkRoundTrip: decodeBytes(fileBytes(FIXTURES[1]), "gb18030") === fileText(LINES_B),
    utf8Bom: startsWith(fileBytes(FIXTURES[0]), BOM_BYTES["utf-8"]),
  };
})();
`;

// ==================== 页面内断言脚本 ====================

/** 页面里共用的小工具（每个阶段脚本自带一份，避免依赖上一个阶段的副作用）。 */
const HELPERS = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel) => document.querySelector(sel);
  const click = async (el, wait = ${WAIT_MS}) => { el.click(); await sleep(wait); };
  /**
   * 轮询等一个条件成立（有上限）。
   *
   * 断言的是**最终状态**而不是「一个固定 sleep 之后恰好如此」：IPC → setState →
   * 重渲染这条链上任何一段慢一点，固定 sleep 都会变成随机失败。
   */
  const until = async (fn, ms = 5000) => {
    const t0 = Date.now();
    for (;;) {
      let ok = false;
      try { ok = !!fn(); } catch (e) { ok = false; }
      if (ok) return true;
      if (Date.now() - t0 > ms) return false;
      await sleep(40);
    }
  };
  /** 状态栏左侧：活动 tab 的总行数。 */
  const barLines = () => q(".statusbar-lines")?.textContent ?? null;
  /** 状态栏右侧：活动 tab 的编码名（按钮里那一段文本，不含别名）。 */
  const barEncoding = () => q(".statusbar-encoding-name")?.textContent ?? null;
  /** 当前可见的 tab 面板（非激活面板是 display:none，高度为 0）。 */
  const activePanel = () => [...document.querySelectorAll(".tab-panel")]
    .find((p) => p.getBoundingClientRect().height > 0) ?? null;
  /** 可见面板里已渲染的日志行文本（虚拟滚动只渲染视口内那几十行）。 */
  const visibleRows = () =>
    [...(activePanel()?.querySelectorAll(".row .text") ?? [])].map((e) => e.textContent);
  /** 编码项按**显示名**找：列表项里名字与别名是两段文本，只认名字那一段。 */
  const itemByName = (name) => [...document.querySelectorAll(".encoding-item")]
    .find((b) => b.querySelector(".encoding-item-name")?.textContent === name) ?? null;
  /** 当前选中的编码项名字（正常情况下只有一个）。 */
  const selectedNames = () => [...document.querySelectorAll(".encoding-item.selected")]
    .map((b) => b.querySelector(".encoding-item-name")?.textContent ?? null);
  /** 预览正文（左侧列表选中什么，它就是那个编码解出来的头几行）。 */
  const previewText = () => q(".encoding-preview-body")?.textContent ?? "";
  /** 取前 n 行做观测值（预览很长，没必要全打印）。 */
  const headLines = (text, n = 2) => text.split("\\n").slice(0, n);
  /** 点状态栏右侧的编码项打开弹窗。 */
  const openEncodingModal = async () => {
    await click(q("button.statusbar-encoding"), ${WAIT_MS});
    return !!q(".encoding-modal");
  };
  /** Esc 关弹窗（弹窗自己监听 keydown，与 App 的全局快捷键互不干扰）。 */
  const pressEscape = () =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
`;

const PHASE1 = `
(async () => {
  ${HELPERS}
  const obs = [];
  const fails = [];
  const check = (cond, msg) => { if (!cond) fails.push(msg); };
  const push = (k, v) => obs.push(k.padEnd(34) + " = " + JSON.stringify(v));

  const CATALOG_NAMES = ${JSON.stringify(CATALOG.map((d) => d.name))};
  const GROUP_HEADINGS = ${JSON.stringify(["自动", "Unicode", "中文", "日文", "韩文", "西文"])};
  const REPLACEMENT = "\\uFFFD";

  try {
    // ---------- 0. mock 自检：夹具的字节必须能按声明的编码还原 ----------
    push("mock self-check", window.__e2eSelfCheck ?? null);
    check(window.__e2eSelfCheck?.gbkRoundTrip === true, "GBK 夹具的字节按 gb18030 解不回原文（mock 有问题）");
    check(window.__e2eSelfCheck?.utf8Bom === true, "UTF-8 夹具应以 BOM 开头");

    // ---------- 1. 状态栏在窗口最底部 ----------
    const bar = q(".statusbar");
    const rect = bar ? bar.getBoundingClientRect() : null;
    push("statusbar rect", rect ? { top: Math.round(rect.top), bottom: Math.round(rect.bottom), h: Math.round(rect.height) } : null);
    push("window.innerHeight", window.innerHeight);
    check(!!bar, "窗口底部应有状态栏（.statusbar）");
    check(!!rect && Math.abs(rect.bottom - window.innerHeight) <= 1, "状态栏底边应贴住窗口底边");
    check(!!rect && rect.top > window.innerHeight / 2, "状态栏应在窗口下半部");
    check(!!q(".statusbar-lines"), "状态栏左侧应有行数项（.statusbar-lines）");

    // ---------- 2. 行数：活动 tab 的总行数 + 千分位 ----------
    check(await until(() => barLines() === "1,234 行"), "状态栏左侧应显示带千分位的行数，实际 " + JSON.stringify(barLines()));
    push("statusbar lines", barLines());
    // 回归：行数已从工具栏搬到状态栏，工具栏不该还留一份（两处会各自漂移）。
    push("toolbar .total-lines", !!q(".total-lines"));
    check(!q(".total-lines"), "工具栏上的旧行数（.total-lines）应已从 DOM 里消失");

    // ---------- 3. 编码名：带 BOM 的 UTF-8 ----------
    check(await until(() => (barEncoding() ?? "").indexOf("UTF-8 BOM") === 0), "带 BOM 的 UTF-8 文件应显示 UTF-8 BOM，实际 " + JSON.stringify(barEncoding()));
    push("statusbar encoding", barEncoding());
    const encBtn = q("button.statusbar-encoding");
    push("encoding button", encBtn ? { disabled: encBtn.disabled, title: encBtn.getAttribute("title") } : null);
    check(!!encBtn && encBtn.disabled === false, "编码项应是一个可点的按钮");
    check((encBtn?.getAttribute("title") ?? "").indexOf("BOM") >= 0, "编码项的悬浮提示应说明「由 BOM 判定」，实际 " + JSON.stringify(encBtn?.getAttribute("title")));

    // ---------- 4. 打开编码弹窗：自动项 + 后端目录 ----------
    push("modal opened", await openEncodingModal());
    check(!!q(".encoding-modal"), "点编码项应打开 .encoding-modal（.encoding-modal）");
    check(await until(() => document.querySelectorAll(".encoding-item").length > 1), "弹窗应列出可选编码（目录来自 list_encodings）");
    const headings = [...document.querySelectorAll(".encoding-group")].map((e) => e.textContent);
    const names = [...document.querySelectorAll(".encoding-item-name")].map((e) => e.textContent);
    push("group headings", headings);
    push("encoding items", names);
    check(GROUP_HEADINGS.every((g) => headings.includes(g)), "分组标题不全：" + JSON.stringify(headings));
    check(headings.length === GROUP_HEADINGS.length, "分组标题数量不对（自动 + 5 组），实际 " + JSON.stringify(headings));
    check(JSON.stringify(names) === JSON.stringify(["自动检测"].concat(CATALOG_NAMES)), "编码项应与后端目录逐个对上，实际 " + JSON.stringify(names));

    // ---------- 5. 新打开时默认选中「自动」，此时没得应用 ----------
    push("selected (fresh)", selectedNames());
    check(JSON.stringify(selectedNames()) === JSON.stringify(["自动检测"]), "新打开时应默认选中「自动检测」，实际 " + JSON.stringify(selectedNames()));
    const applyBtn = () => q(".encoding-btn.primary");
    push("apply disabled (fresh)", applyBtn()?.disabled);
    check(applyBtn()?.disabled === true, "当前选择与生效编码一致时「应用」应不可用");

    // ---------- 6. 预览：自动探测读得出中文 ----------
    check(await until(() => previewText().indexOf("第1行") >= 0), "自动探测的预览应读得出中文，实际 " + JSON.stringify(previewText().slice(0, 80)));
    const autoPreview = previewText();
    push("preview (auto)", headLines(autoPreview));

    // ---------- 7. 选中另一个编码：预览变、选中态跟着走、应用可用 ----------
    const gbkItem = itemByName("GBK");
    check(!!gbkItem, "列表里应有 GBK 项");
    await click(gbkItem, ${WAIT_MS});
    check(await until(() => previewText() !== "" && previewText() !== autoPreview), "换编码后预览应随之变化");
    push("preview (gbk)", headLines(previewText()));
    check(JSON.stringify(selectedNames()) === JSON.stringify(["GBK"]), "选中态应移到 GBK，实际 " + JSON.stringify(selectedNames()));
    check(applyBtn()?.disabled === false, "选了别的编码后「应用」应可用");
    check(previewText() !== autoPreview, "两种编码的预览文本应不同");

    // ---------- 8. 应用：后端收到 set_encoding，正文与状态栏一起换掉 ----------
    check(await until(() => visibleRows().length > 0), "日志正文应已渲染出行");
    const rowsBefore = visibleRows();
    push("first row (before apply)", rowsBefore[0]);
    check(rowsBefore.join("").indexOf("中文日志") >= 0, "UTF-8 文件此刻应正常显示中文，实际 " + JSON.stringify(rowsBefore.slice(0, 1)));

    await click(applyBtn(), ${WAIT_MS});
    check(await until(() => !q(".encoding-modal")), "应用后弹窗应关闭");
    push("modal after apply", !!q(".encoding-modal"));
    const encCalls = window.__e2eEncodingCalls.slice();
    push("set_encoding calls", encCalls);
    const call = encCalls[encCalls.length - 1];
    check(!!call && call.cmd === "set_encoding", "应用应调用后端 set_encoding，实际 " + JSON.stringify(encCalls));
    check(call?.args?.encoding === "gbk", "set_encoding 的 encoding 参数应是选中的 gbk，实际 " + JSON.stringify(call?.args));
    check(await until(() => (barEncoding() ?? "").indexOf("GBK") === 0), "状态栏应换成新解析出来的编码名，实际 " + JSON.stringify(barEncoding()));
    push("statusbar encoding (after apply)", barEncoding());
    check((barEncoding() ?? "").indexOf("UTF-8") < 0, "状态栏不该还写着 UTF-8");
    push("statusbar lines (after apply)", barLines());
    check(barLines() === "1,234 行", "换编码不该改变行数，实际 " + JSON.stringify(barLines()));
    // 换编码的核心诉求：正文真的按新编码重新解了一遍（同一批字节按 GBK 解必然不同）。
    check(await until(() => { const now = visibleRows(); return now.length > 0 && now.join("|") !== rowsBefore.join("|"); }), "换编码后正文应按新编码重新解码（内容应有变化）");
    push("first row (after apply)", visibleRows()[0]);
    check(visibleRows().join("").indexOf(REPLACEMENT) >= 0 || visibleRows().join("").indexOf("中文日志") < 0, "GBK 解 UTF-8 字节不应还是那批中文");
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
  const push = (k, v) => obs.push(k.padEnd(34) + " = " + JSON.stringify(v));

  const REPLACEMENT = "\\uFFFD";
  const LOG_B = ${JSON.stringify(LOG_B)};

  try {
    // ---------- 9. Esc 关闭弹窗 ----------
    push("modal reopened", await openEncodingModal());
    check(await until(() => !!q(".encoding-modal")), "再次点编码项应能打开弹窗");
    pressEscape();
    check(await until(() => !q(".encoding-modal")), "Esc 应关闭编码弹窗");
    push("modal after Esc", !!q(".encoding-modal"));

    // ---------- 10. 打开第二个文件（新 tab）→ 状态栏切到它自己的信息 ----------
    const before = document.querySelectorAll(".tabbar .tab").length;
    push("tabs before open", before);
    check(before === 1, "首屏应只有一个 tab（会话恢复来的那个），实际 " + before);
    // 自动化钩子：等价于用户从文件对话框选中这个文件（绕开系统对话框）。
    window.__lvOpenPath(LOG_B);
    check(await until(() => document.querySelectorAll(".tabbar .tab").length === 2), "打开第二个文件应新增一个 tab");
    check(await until(() => barLines() === "120 行"), "新 tab 的激活状态下状态栏应显示它自己的行数，实际 " + JSON.stringify(barLines()));
    check(await until(() => (barEncoding() ?? "").indexOf("GB18030") === 0), "新 tab 的编码应显示 GB18030，实际 " + JSON.stringify(barEncoding()));
    push("statusbar lines (tab B)", barLines());
    push("statusbar encoding (tab B)", barEncoding());
    // GBK 是「非 UTF-8 中文日志」的绝大多数：这里必须解出正常中文，而不是一片替换字符。
    check(await until(() => visibleRows().some((t) => t.indexOf("中文日志") >= 0)), "GBK 文件应解出正常中文，实际 " + JSON.stringify(headLines(visibleRows().join("\\n") ?? "", 1)));
    push("first row (tab B)", visibleRows()[0]);
    check(visibleRows().join("").indexOf(REPLACEMENT) < 0, "GBK 文件的正文不该出现替换字符（说明解码没走编码层）");

    // ---------- 11. 切回第一个 tab：状态栏换成它自己的行数与编码（含刚手动选的 GBK） ----------
    const tabs = [...document.querySelectorAll(".tabbar .tab")];
    await click(tabs[0], ${WAIT_MS});
    check(await until(() => barLines() === "1,234 行"), "切回第一个 tab 应恢复它自己的行数，实际 " + JSON.stringify(barLines()));
    check(await until(() => (barEncoding() ?? "").indexOf("GBK") === 0), "切回第一个 tab 应还是它的手动选择（GBK），实际 " + JSON.stringify(barEncoding()));
    push("statusbar lines (back to A)", barLines());
    push("statusbar encoding (back to A)", barEncoding());

    // 会话存档：手动选择要存下来（刷新用例的前提），auto 的 tab 不能把探测结果固化。
    const saved = JSON.parse(localStorage.getItem("lv-tabs") ?? "null");
    push("lv-tabs archive", saved);
    check(saved?.encodings?.[0] === "gbk", "会话存档应记下手动选择的编码，实际 " + JSON.stringify(saved?.encodings));
    check(saved?.encodings?.[1] == null, "自动探测的 tab 不该把探测结果固化进存档，实际 " + JSON.stringify(saved?.encodings));
    check(saved?.active === 0, "存档应记下当前激活的是第一个 tab，实际 " + saved?.active);
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
  const push = (k, v) => obs.push(k.padEnd(34) + " = " + JSON.stringify(v));

  try {
    // ---------- 12. 刷新后：手动选的编码随会话存档恢复 ----------
    push("tabs restored", document.querySelectorAll(".tabbar .tab").length);
    check(document.querySelectorAll(".tabbar .tab").length === 2, "刷新后应恢复两个 tab");
    check(await until(() => barLines() === "1,234 行"), "刷新后状态栏应恢复行数，实际 " + JSON.stringify(barLines()));
    check(await until(() => (barEncoding() ?? "").indexOf("GBK") === 0), "刷新后应恢复手动选择的编码（GBK），实际 " + JSON.stringify(barEncoding()));
    push("statusbar encoding (after reload)", barEncoding());
    push("statusbar lines (after reload)", barLines());
    check(await until(() => visibleRows().length > 0), "刷新后正文应已渲染");
    push("first row (after reload)", visibleRows()[0]);
    // 正文也必须是按 GBK 解的：UTF-8 的字节按 GBK 解出来不可能还是「中文日志」。
    check(visibleRows().join("").indexOf("中文日志") < 0, "刷新后正文仍应按存档里的编码解（不该变回 UTF-8）");

    // ---------- 13. auto 的 tab 刷新后重新探测，而不是沿用上次的结果 ----------
    const tabs = [...document.querySelectorAll(".tabbar .tab")];
    await click(tabs[1], ${WAIT_MS});
    check(await until(() => barLines() === "120 行"), "切到第二个 tab 应显示它自己的行数，实际 " + JSON.stringify(barLines()));
    check(await until(() => (barEncoding() ?? "").indexOf("GB18030") === 0), "auto 的 tab 刷新后应重新探测出 GB18030，实际 " + JSON.stringify(barEncoding()));
    push("statusbar encoding (tab B after reload)", barEncoding());
    check(await until(() => visibleRows().some((t) => t.indexOf("中文日志") >= 0)), "刷新后 GBK 文件应仍解出正常中文");
  } catch (e) {
    fails.push("phase3 threw: " + (e && e.message ? e.message : String(e)));
  }

  obs.push("");
  obs.push(fails.length ? "PHASE3 FAILED " + fails.length + ":" : "PHASE3 ALL PASSED");
  fails.forEach((f) => obs.push("  - " + f));
  return obs.join("\\n");
})()
`;

// ==================== PHASE4：自动刷新关掉后换编码 ====================
//
// 守的是这个 bug：`log-lines` 监听器在「自动刷新」关掉时会丢掉**所有**载荷，包括
// `reset = true` 的那一类；而换编码正是靠这类载荷把「按新编码重解出来的正文」推给前端，
// 于是暂停跟随时换编码毫无效果 —— 而且**永不自愈**（那个事件不会再发第二次）。
// 修复：载荷带 `apply_when_paused`，只有用户动作引起的会话重建（打开文件 / 换编码）
// 才越得过暂停闸门，实时批次照旧被丢弃。
//
// 因此本阶段必须同时验两件相反的事，缺一不可：
//   - 换编码的 reset 批次**要**生效（正文真的重解）；
//   - 实时数据的 reset 批次**不能**生效（暂停闸门还在，不是被整个拆掉了）。
// 只验前者的话，「把闸门删掉」也能过；只验后者的话，「把闸门焊死」也能过。

const PHASE4 = `
(async () => {
  ${HELPERS}
  const obs = [];
  const fails = [];
  const check = (cond, msg) => { if (!cond) fails.push(msg); };
  const push = (k, v) => obs.push(k.padEnd(34) + " = " + JSON.stringify(v));

  const LOG_B = ${JSON.stringify(LOG_B)};

  /** 工具栏里的「自动刷新」复选框（只在**活动的**面板里找：每个 tab 各有自己的开关）。 */
  const autoRefreshBox = () => [...(activePanel()?.querySelectorAll(".toolbar .follow") ?? [])]
    .find((l) => (l.textContent ?? "").trim() === "自动刷新")?.querySelector("input[type=checkbox]") ?? null;
  /** 「应用」按钮（与 PHASE1 里同一个选择器）。 */
  const applyBtn = () => q(".encoding-btn.primary");

  try {
    // ---------- 14. 关掉「自动刷新」后换编码：正文必须真的重解 ----------
    // 用第二个 tab（GBK 文件）：它此刻的编码是 auto 探测出来的 GB18030，换成西文编码后
    // 同一批字节必然解成另一番模样，「正文变了没有」这条断言才看得出真假。
    const tabs = [...document.querySelectorAll(".tabbar .tab")];
    push("tabs", tabs.length);
    check(tabs.length === 2, "应有两个 tab（会话恢复来的 + 打开的那个），实际 " + tabs.length);
    await click(tabs[1], ${WAIT_MS});
    check(await until(() => barLines() === "120 行"), "前置：第二个 tab 应是 120 行的那个，实际 " + JSON.stringify(barLines()));
    check(await until(() => (barEncoding() ?? "").indexOf("GB18030") === 0), "前置：第二个 tab 的编码应是 GB18030，实际 " + JSON.stringify(barEncoding()));
    check(await until(() => visibleRows().some((t) => t.indexOf("中文日志") >= 0)), "前置：GBK 文件的正文此刻应能正常读出中文");

    // 关掉自动刷新 —— 整个 bug 只在这个前提下才现形。
    const box = autoRefreshBox();
    push("auto-refresh checkbox", box ? { found: true, checked: box.checked } : null);
    check(!!box, "工具栏里应有「自动刷新」复选框");
    check(box?.checked === true, "自动刷新默认应是开着的，实际 " + JSON.stringify(box?.checked));
    await click(box, ${WAIT_MS});
    check(await until(() => autoRefreshBox()?.checked === false), "点一下应能关掉自动刷新（继续跑下去就是暂停跟随了）");
    push("auto-refresh (paused)", autoRefreshBox()?.checked);
    // 暂停时等一拍，确认关开关本身不动正文（否则下面的「正文变了」就说不清是谁改的）。
    await sleep(300);
    const rowsBefore = visibleRows();
    push("first row (before switch)", rowsBefore[0]);
    check(rowsBefore.join("").indexOf("中文日志") >= 0, "换编码前正文应是正常中文，实际 " + JSON.stringify(rowsBefore.slice(0, 1)));
    push("statusbar lines (paused)", barLines());

    // 打开编码弹窗 → 选一个西文编码 → 应用
    push("modal opened (paused)", await openEncodingModal());
    check(!!q(".encoding-modal"), "暂停跟随时也应能打开编码弹窗");
    const western = itemByName("Windows-1252");
    check(!!western, "列表里应有 Windows-1252 项");
    await click(western, ${WAIT_MS});
    check(applyBtn()?.disabled === false, "选了别的编码后「应用」应可用");

    await click(applyBtn(), ${WAIT_MS});
    check(await until(() => !q(".encoding-modal")), "应用后弹窗应关闭");
    push("modal after apply (paused)", !!q(".encoding-modal"));
    const call = window.__e2eEncodingCalls.slice().pop();
    push("set_encoding call", call ?? null);
    check(call?.cmd === "set_encoding" && call?.args?.encoding === "windows-1252",
      "应用应把选中的 windows-1252 传给后端，实际 " + JSON.stringify(call));
    check(await until(() => (barEncoding() ?? "").indexOf("Windows-1252") === 0), "状态栏应换成新编码名，实际 " + JSON.stringify(barEncoding()));
    push("statusbar encoding (paused)", barEncoding());

    // **本阶段的正题**：正文真的按新编码重解了一遍。
    // 只断言状态栏是不够的：编码名来自 set_encoding 的**返回值**，与正文走的不是同一条
    // 链路；bug 恰恰就是「状态栏换了、正文没换」，所以必须看重新渲染出来的行文本。
    check(await until(() => { const now = visibleRows(); return now.length > 0 && now.join("|") !== rowsBefore.join("|"); }),
      "关掉自动刷新后换编码，正文仍应按新编码重解（这正是本次修的 bug）");
    const rowsAfter = visibleRows();
    push("first row (after switch)", rowsAfter[0]);
    check(rowsAfter.join("").indexOf("中文日志") < 0, "换到西文编码后正文不该还是那批中文（说明正文没跟着重解）");
    check(await until(() => barLines() === "120 行"), "换编码不该改变行数，实际 " + JSON.stringify(barLines()));

    // ---------- 15. 负向对照：暂停跟随时，**实时**批次必须被丢掉 ----------
    // 少了这一条，第 14 条证明的可能只是「暂停开关整个失效了」，而不是 apply_when_paused
    // 把两类批次分开了。这里推一批实时数据（日志被轮转 / 截断后监控线程会推的那种 reset
    // 批次）：它同样是 reset = true、同样整体替换正文，唯一的区别就是 apply_when_paused = false。
    // 刻意用「整体替换」而不是「末尾追加」：追加落在文件末尾、根本不在首屏视口里，
    // 「正文没变」会变成一条必然成立的空断言。
    const liveEmitted = window.__e2eEmitLive(LOG_B, 5);
    push("live batch emitted", liveEmitted);
    check(liveEmitted === true, "实时批次没发出去（mock 按路径找不到 tab？），负向对照无效");
    // 负向断言只能固定等：要证明「没变」，就得给这批留足被应用的时间。
    await sleep(${WAIT_MS} + 400);
    const rowsPaused = visibleRows();
    push("first row (live, paused)", rowsPaused[0]);
    check(rowsPaused.join("|") === rowsAfter.join("|"), "暂停跟随时应丢掉实时批次，正文不该被它改动（变了说明 apply_when_paused 没在分流）");
    check(rowsPaused.join("").indexOf("LIVE-ROTATED") < 0, "实时批次的行不该出现在暂停跟随时的正文里");
    push("statusbar lines (live, paused)", barLines());
    check(barLines() === "120 行", "被丢掉的批次连它带来的总行数也不该生效，实际 " + JSON.stringify(barLines()));

    // ---------- 16. 正向对照：打开自动刷新，同一批实时数据立刻生效 ----------
    // 反证第 15 条的「没变」不是「mock 根本没发出去 / 前端根本没收到」，而是暂停闸门
    // 确实在按载荷字段分流。
    await click(autoRefreshBox(), ${WAIT_MS});
    check(await until(() => autoRefreshBox()?.checked === true), "再点一下应能打开自动刷新");
    push("live batch emitted (resumed)", window.__e2eEmitLive(LOG_B, 5));
    check(await until(() => visibleRows().join("").indexOf("LIVE-ROTATED") >= 0),
      "打开自动刷新后，实时批次应生效（否则第 15 条的负向对照是空的）");
    push("first row (live, resumed)", visibleRows()[0]);
    check(await until(() => barLines() === "5 行"), "实时批次带来的总行数应随之生效，实际 " + JSON.stringify(barLines()));
  } catch (e) {
    fails.push("phase4 threw: " + (e && e.message ? e.message : String(e)));
  }

  obs.push("");
  obs.push(fails.length ? "PHASE4 FAILED " + fails.length + ":" : "PHASE4 ALL PASSED");
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
      `--user-data-dir=${process.env.TEMP ?? "."}\\loglens-e2e-encoding-profile`,
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

  // 等应用挂载 + 恢复出那个 tab + 状态栏算出它的行数：
  // 后面每个阶段都以「这一屏已经稳定」为前提，不在这里赌 sleep。
  const waitForApp = () =>
    waitFor(
      async () =>
        await evaluate(
          cdp,
          `(() => {
             const bar = document.querySelector(".statusbar");
             const lines = document.querySelector(".statusbar-lines");
             return !!bar && !!document.querySelector(".body-view")
               && document.querySelectorAll(".tabbar .tab").length >= 1
               && (lines ? lines.textContent : "").indexOf("1,234") >= 0;
           })()`
        ),
      25000,
      "LogLens 首屏（状态栏 + 会话恢复的 tab + 行数）"
    );

  await waitForApp();
  await sleep(300);

  await shoot(cdp, "01-statusbar.png");
  const phase1 = await evaluate(cdp, PHASE1);
  console.log("===== 状态栏（行数 / 编码）→ 编码弹窗 → 预览 → 应用 =====");
  console.log(phase1);
  await shoot(cdp, "02-after-apply.png");

  const phase2 = await evaluate(cdp, PHASE2);
  console.log("===== Esc 关闭 / 切 tab（行数与编码都是 per-tab 的） =====");
  console.log(phase2);
  // 弹窗刚被 Esc 关掉，重开一张（含右侧预览）供人工确认观感。
  await evaluate(cdp, `document.querySelector("button.statusbar-encoding")?.click(); true`);
  await sleep(700);
  await shoot(cdp, "03-encoding-modal.png");
  await evaluate(
    cdp,
    `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`
  );
  await sleep(300);
  // 第二个 tab（GBK 文件）的正文：中文应正常显示，不是一片问号。
  await evaluate(cdp, `document.querySelectorAll(".tabbar .tab")[1]?.click(); true`);
  await sleep(700);
  await shoot(cdp, "04-gbk-tab.png");
  await evaluate(cdp, `document.querySelectorAll(".tabbar .tab")[0]?.click(); true`);
  await sleep(500);

  // 刷新页面：手动选的编码应从会话存档恢复
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitForApp();
  await sleep(300);

  const phase3 = await evaluate(cdp, PHASE3);
  console.log("===== 刷新后（编码选择随会话存档恢复） =====");
  console.log(phase3);
  await shoot(cdp, "05-after-reload.png");

  const phase4 = await evaluate(cdp, PHASE4);
  console.log("===== 暂停跟随（自动刷新关掉）时的换编码 vs 实时批次 =====");
  console.log(phase4);
  await shoot(cdp, "06-paused-encoding.png");

  cdp.close();
  exitCode =
    /ALL PASSED/.test(phase1) &&
    /ALL PASSED/.test(phase2) &&
    /ALL PASSED/.test(phase3) &&
    /ALL PASSED/.test(phase4)
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
