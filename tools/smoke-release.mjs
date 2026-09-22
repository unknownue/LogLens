#!/usr/bin/env node
// smoke-release.mjs — 在**打包后的真实 exe + 真实 WebView2** 上跑冒烟断言。
//
// 为什么必须有它：`tools/e2e-markdown.mjs` 跑在 Vite dev server 上，而 dev 的 CSP 是空的
// （`tauri.conf.json` → `app.security.devCsp = null`）。**打包**时 Tauri 会把 CSP 改写一遍，
// 给 `style-src` 追加 `'nonce-…'`；按 CSP 规范，同一指令里一旦出现 nonce，`'unsafe-inline'`
// 就整体失效 —— 结果是**内联 `style` 属性全部不生效**。KaTeX 的排版（`.vlist` 的
// `top:-N.Nem`、`height`、`margin` 等）完全依赖内联样式，于是行内公式只剩上半截、
// 上下标掉行、块级公式挤成一团。修复手段是 `src-tauri/tauri.conf.json` 里的
// `"dangerousDisableAssetCspModification": ["style-src"]`。
//
// 这类「只有打包后才复现」的回归，dev 端 E2E 天然测不到（CSP 为空），所以单独一个脚本：
// 真 exe → 真 WebView2 → CDP 附加 → 应用自带的测试钩子 `window.__lvOpenPath()` 打开样例
// → 断言内联样式 / 公式排版 / 字体 / 主题 / 页面错误。
//
// 用法（Windows，Node ≥ 22；Node 20 需要带 --experimental-websocket 才有全局 WebSocket）：
//   node tools/smoke-release.mjs                          # 默认 exe + 调试端口 9222
//   node tools/smoke-release.mjs --shot %TEMP%\loglens-shots
//   node tools/smoke-release.mjs --exe <path\to\LogLens.exe> --port 9333
//
//   --exe <path>   打包好的 exe（默认 src-tauri/target/release/LogLens.exe）
//   --port <n>     WebView2 远程调试端口（默认 9222）
//   --shot <dir>   额外导出 01-smoke.png（整页）与 02-formula-zoom.png（公式放大）
//
// 前置：先 `make loglens-build` 产出 release exe；**运行期间不要开另一个 LogLens** ——
// WebView2 的用户数据目录（%LOCALAPPDATA%\com.loglens.LogLens\EBWebView）是同一个，
// 第二个实例根本起不来，CDP 端口不会出现（脚本会在开跑前检查并给出提示）。
//
// 副作用（都属正常）：
//   1. 会**真的弹出桌面窗口**（跑完、失败、Ctrl+C 都会尽力杀掉整棵进程树）；
//   2. 应用有「会话恢复」，样例文件会作为一个新标签页写回它的会话存档；
//   3. 会在 %TEMP%\loglens-smoke\fixture.md 覆盖写入临时样例。
//
// 曾是「已知打包版问题」，现已修复（保留说明以免回归时看不懂）：
//   `KaTeX_Size3-Regular.woff2`（3624 B）曾落在 Vite 默认的 4 KB 内联阈值内，被打成
//   `data:` URL，而 CSP 的 `font-src 'self'` 不放行 `data:` → 打开任意 .md 都会报一条
//   error 级日志，用到 `\left( \right)` / `\bigg` 的公式还会退化成回退字体。
//   现已在 vite.config.ts 用 `assetsInlineLimit` 让字体永不内联；**若这条日志再次出现，
//   说明该配置被改回去了，断言 F 会直接判失败**（不再豁免）。
//
// 断言 A/B 是 CSP 修复的核心，刻意保持严格（不做任何“宽松”处理）；F 同理。
//
// 退出码：全部通过 → 0；任一断言失败 → 1；脚本自身异常 → 1（打印堆栈）。

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ==================== 参数与环境 ====================

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const EXE = resolve(arg("exe", join(REPO_ROOT, "src-tauri", "target", "release", "LogLens.exe")));
const PORT = Number(arg("port", "9222"));
const SHOT_DIR = arg("shot", null);

const TMP_DIR = join(process.env.TEMP ?? tmpdir(), "loglens-smoke");
const FIXTURE = join(TMP_DIR, "fixture.md");
/** 样例里的独有标记：用来把「我们这份样例」的正文与其它标签页的正文区分开。 */
const SENTINEL = "smoke-release";

const WAIT_TARGET_MS = 30000; // 等 CDP 端口 / page target
const WAIT_SHELL_MS = 15000; // 等应用外壳
const WAIT_FIXTURE_MS = 20000; // 等样例文档渲染出来
const WAIT_KATEX_MS = 10000; // 等公式节点出现
const WAIT_FONT_MS = 5000; // 等 KaTeX 字体加载

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 脚本自身的问题（参数、环境、进程）——与「断言失败」区分开。 */
class SmokeError extends Error {}

// ==================== 临时样例文档 ====================
//
// 自给自足，不依赖仓库里的 repro/md-sample.md。刻意包含：h1/h2（大纲至少两级）、
// GFM 表格、行内公式 `$…$`、块级公式 `$$…$$`、代码块、任务列表。
//
// 公式的选型很讲究：
//   - 行内 `$p^2 - 1$` 会生成 `.vlist > span[style="top:-N.Nem"]`（上标），这正是
//     「内联样式失效」时最先塌掉的地方 —— 断言 B 直接盯它；
//   - 块级用 `\sum` + `\frac`（用到 KaTeX_Size2 与 vlist 堆叠），不引入大号定界符
//     （`\left(` / `\bigg` 会用到被 CSP 拦掉的 KaTeX_Size3，与本脚本要守的回归无关）。
const FIXTURE_LINES = [
  `# LogLens 冒烟样例（${SENTINEL}）`,
  "",
  "普通段落，行内公式 $p^2 - 1$ 。",
  "",
  "![冒烟图](smoke-pic.png)",
  "",
  "## 小节",
  "",
  "| 项目 | 数值 |",
  "| --- | ---: |",
  "| 生命 | 100 |",
  "| 魔法 | 50 |",
  "",
  "块级公式：",
  "",
  "$$",
  "\\sum_{i=1}^{n} \\frac{n(n+1)}{2}",
  "$$",
  "",
  "```js",
  "const answer = 42;",
  "console.log(answer);",
  "```",
  "",
  "- [x] 已完成",
  "- [ ] 未完成",
  "",
];

/**
 * 2×2 红色 PNG（base64 内联）：用来验「本地图片真的能显示」。
 *
 * 为什么这里必须有它：图片走的是 asset 协议 + 后端**动态授权的文档目录**这个组合，
 * 而 dev 端没有 CSP、也没有真实的后端授权逻辑 —— 只有打包后的应用能验到
 * 「授权目录内的图片加载成功、目录外的不行」。脚本把它写在 fixture 同目录，
 * 于是「加载成功」本身就证明了动态 scope 覆盖了文档所在目录。
 */
const PIC_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8z8DAwMDAxMDAwMAAAA0EAQBSV0G5AAAAAElFTkSuQmCC";
const PIC = join(TMP_DIR, "smoke-pic.png");

// ==================== 临时 CSV 样例 ====================
//
// CSV 表格（表格视图的文本后端）同样有「只有打包版才测得到」的部分：解析在 Rust 后端，
// 走的是真实 Tauri IPC（命令名、参数名、Option 参数的省略、编码层的自动探测），
// dev 端的 mock 后端把这些全部替换掉了 —— 参数名写错在 E2E 里是看不出来的。
//
// 两份样例各守一件事：
//   1. UTF-8 **带 BOM** + 引号字段（字段内逗号、字段内换行、`""` 转义、空字段）：
//      BOM 没剥掉的话第一列表头会变成 "\uFEFFname"，界面看不出、却对不上；
//   2. GBK 编码（国内 Excel 导出的常见形态）：自动探测应落到 GB18030 兜底编码，
//      中文要原样解出来（这是编码层与 CSV 后端接对了的证据）。

/** UTF-8 + BOM 的 CSV 样例（行数组换行拼起来：第三行开始是多行字段）。 */
const CSV_FIXTURE = join(TMP_DIR, "smoke.csv");
const CSV_LINES = [
  "name,qty,note",
  'apple,3,"fresh, sweet"',
  'pear,,"line1',
  'line2"',
  'banana,5,"he said ""hi"""',
  "",
];

/** GBK 样例的字节（"名称,数量\n苹果,3\n梨,5\n" 按 GBK 编码后的 base64）。 */
const CSV_GBK_FIXTURE = join(TMP_DIR, "smoke-gbk.csv");
const CSV_GBK_BASE64 = "w/uzxizK/cG/Csa7ufssMwrA5iw1Cg==";

function writeFixture() {
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(FIXTURE, FIXTURE_LINES.join("\n"), "utf8");
  // 与 fixture 同目录：asset 协议只授权「打开过的文档所在目录」
  writeFileSync(PIC, Buffer.from(PIC_BASE64, "base64"));
  // CSV 样例：UTF-8 要带 BOM（验 BOM 剥离），GBK 直接用原始字节。
  writeFileSync(
    CSV_FIXTURE,
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(CSV_LINES.join("\n"), "utf8")])
  );
  writeFileSync(CSV_GBK_FIXTURE, Buffer.from(CSV_GBK_BASE64, "base64"));
}

// ==================== 进程与清理 ====================

let child = null;
let cdp = null;
let cleanedUp = false;

/** 杀掉整棵进程树（exe + WebView2 子进程）。幂等，异常路径也会调到。 */
function cleanup() {
  if (cleanedUp) {
    return;
  }
  cleanedUp = true;
  try {
    cdp?.close();
  } catch {
    /* 已经断了 */
  }
  const pid = child?.pid;
  if (!pid) {
    return;
  }
  try {
    // /T 连 WebView2 的子进程一起收，/F 强制：GUI 进程不响应 Ctrl 事件
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    try {
      child.kill();
    } catch {
      /* 已经退了 */
    }
  }
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    console.log(`\n收到 ${sig}，正在关闭 LogLens…`);
    cleanup();
    process.exit(130);
  });
}
process.on("exit", cleanup);

/**
 * 启动前检查：别的 LogLens 正在跑的话，新实例的 WebView2 起不来。
 *
 * 实测（Windows 11 + WebView2 152）：用户数据目录被占用时，第二个实例会**静默卡住**
 * —— 没有窗口、没有 msedgewebview2 子进程、CDP 端口永远不出现。与其等 30 秒超时，
 * 不如立刻说清楚原因。
 *
 * 例外：设了 `WEBVIEW2_USER_DATA_FOLDER` 时，两个实例用的**不是**同一个目录，
 * 上面那条冲突就不存在了（Tauri 默认把数据目录固定到
 * `%LOCALAPPDATA%\<identifier>\EBWebView`，而这个环境变量会让 WebView2 换一个）。
 * 于是可以一边开着日常用的 LogLens、一边冒烟测新构建 —— 这正是开发时最常见的状态。
 */
function assertNoRunningInstance() {
  if (process.env.WEBVIEW2_USER_DATA_FOLDER) {
    console.log(
      `（已设 WEBVIEW2_USER_DATA_FOLDER=${process.env.WEBVIEW2_USER_DATA_FOLDER}，` +
        "与其它实例互不干扰，跳过「已有 LogLens 在运行」检查）"
    );
    return;
  }
  let out = "";
  try {
    out = execFileSync("tasklist", ["/FI", "IMAGENAME eq LogLens.exe", "/FO", "CSV", "/NH"], {
      encoding: "utf8",
    });
  } catch {
    return; // tasklist 不可用（非 Windows / 权限）就跳过这项检查
  }
  const pids = [...out.matchAll(/"LogLens\.exe","(\d+)"/gi)].map((m) => m[1]);
  if (pids.length > 0) {
    throw new SmokeError(
      `已有 LogLens 在运行（PID ${pids.join(", ")}）。\n` +
        "  WebView2 的用户数据目录是同一个（%LOCALAPPDATA%\\com.loglens.LogLens\\EBWebView），\n" +
        "  第二个实例会卡在 WebView2 初始化上：没有窗口、没有 CDP 端口。请先关掉它再跑本脚本，\n" +
        "  或给本脚本设一个独立的数据目录（两个实例就互不干扰了）：\n" +
        '    $env:WEBVIEW2_USER_DATA_FOLDER = "$env:TEMP\\loglens-smoke"; node tools/smoke-release.mjs'
    );
  }
}

/**
 * 启动前检查：调试端口是不是已经有人在用。
 *
 * 踩过的坑：`tools/e2e-markdown.mjs --launch` 默认也用 9222 起无头 Edge。端口被它占着时，
 * 本脚本会连到那个**别人的浏览器**上（页面同样有 .tabbar 和 __lvOpenPath），
 * 于是断言全都在错误的对象上跑 —— 所以宁可先拒绝。
 */
async function assertPortFree() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (!res.ok) {
      return;
    }
    const info = await res.json().catch(() => ({}));
    throw new SmokeError(
      `调试端口 ${PORT} 已被别的进程占用（${info.Browser ?? "未知 debuggee"}）。\n` +
        "  常见来源：tools/e2e-markdown.mjs --launch 起的无头 Edge（默认端口也是 9222）。\n" +
        "  请先结束它，或用 --port <其它端口> 重跑。"
    );
  } catch (e) {
    if (e instanceof SmokeError) {
      throw e;
    }
    // fetch 连不上 = 端口空闲，正是我们要的
  }
}

/** 打包版的前端来自内嵌资源，页面 origin 固定是 http://tauri.localhost。 */
const isAppTarget = (url) => /^https?:\/\/tauri\.localhost(\/|$)/.test(url ?? "");

// ==================== CDP 客户端（与 tools/e2e-markdown.mjs 同一套写法） ====================

function connect(wsUrl, onEvent) {
  return new Promise((resolveConnect, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 1;
    let closed = false;
    /** 连接断掉时把没回音的请求全部拒绝：否则 await 会永远挂着（页面被关掉时就是这样）。 */
    const failAll = (why) => {
      closed = true;
      for (const { rej } of pending.values()) {
        rej(new SmokeError(`CDP 连接已断开（${why}）：页面/进程是不是被别的程序关掉了？`));
      }
      pending.clear();
    };
    ws.addEventListener("close", () => failAll("websocket closed"));
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
        return;
      }
      if (msg.method) {
        onEvent?.(msg.method, msg.params);
      }
    });
    ws.addEventListener("error", () => {
      failAll("websocket error");
      reject(new Error("CDP websocket error"));
    });
    ws.addEventListener("open", () => {
      resolveConnect({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            if (closed) {
              rej(new SmokeError("CDP 连接已关闭"));
              return;
            }
            const id = nextId++;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          }),
        close: () => ws.close(),
      });
    });
  });
}

/** 求值一个表达式并返回其值（awaitPromise，页面内异常直接抛出）。 */
async function evaluate(expression) {
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
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) {
      return last;
    }
    await sleep(250);
  }
  throw new SmokeError(`等待超时（${timeoutMs / 1000}s）：${what}`);
}

/** 页面内的小工具：定位「我们这份样例」的正文、量尺寸。 */
const PRELUDE = `
const SENTINEL = ${JSON.stringify(SENTINEL)};
const bodies = () => [...document.querySelectorAll(".md-body")];
const root = () => bodies().find((b) => b.textContent.includes(SENTINEL)) || null;
const box = (el) => {
  const r = el.getBoundingClientRect();
  return { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 };
};
`;

// ==================== 日志 / 异常收集 ====================

/** 全部事件按阶段打标：startup = 应用首屏期间（含 CDP 附加时补发的历史条目）。 */
const events = [];
let phase = "startup";

function onCdpEvent(method, params) {
  if (method === "Log.entryAdded") {
    events.push({ kind: "log", phase, ...params.entry });
  } else if (method === "Runtime.exceptionThrown") {
    const d = params.exceptionDetails ?? {};
    events.push({
      kind: "exception",
      phase,
      level: "error",
      source: "javascript",
      text: d.exception?.description ?? d.text ?? JSON.stringify(d),
    });
  }
}

/**
 * 历史遗留的窄口径豁免 —— 现已**关闭**（恒为 false）。
 *
 * `KaTeX_Size3` 被 Vite 内联成 data: 的那条 CSP 日志，已在 `vite.config.ts` 用
 * `assetsInlineLimit` 修掉。这里把豁免关死，是为了让它一旦回归就直接算失败：
 * 保留函数与「已知问题」的打印通道，只是不再匹配任何条目。
 */
function isKnownInlinedFontCsp(e) {
  void e;
  return false;
}

// ==================== 断言 ====================

const results = [];

async function check(id, title, fn) {
  process.stdout.write(`[${id}] ${title} … `);
  let outcome;
  try {
    outcome = await fn();
  } catch (e) {
    outcome = { ok: false, detail: ["脚本侧异常: " + (e?.message ?? String(e))] };
  }
  console.log(outcome.ok ? "通过" : "失败");
  for (const line of outcome.detail ?? []) {
    console.log("      " + line);
  }
  results.push({ id, title, ok: outcome.ok, detail: outcome.detail ?? [] });
  return outcome;
}

/** A. 内联 style 生效 —— 本次 CSP 修复的核心回归。 */
async function assertInlineStyle() {
  const raw = await evaluate(`(() => {
    ${PRELUDE}
    const probe = document.createElement("div");
    probe.id = "__smoke_inline_style_probe";
    probe.setAttribute("style", "height:5px;position:relative;top:-3px");
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy" i]');
    const out = {
      height: cs.height,
      top: cs.top,
      styleAttr: probe.getAttribute("style"),
      useInlineInCsp: meta ? /unsafe-inline/.test(meta.content) : null,
      csp: meta ? meta.content : null,
    };
    probe.remove();
    return JSON.stringify(out);
  })()`);
  const r = JSON.parse(raw);
  const ok = r.height === "5px";
  const detail = [
    `内联 style 属性 = ${JSON.stringify(r.styleAttr)}`,
    `计算值 height=${r.height} / top=${r.top}（期望 height=5px、top=-3px）`,
  ];
  if (!ok) {
    detail.push(
      "原因：CSP 里的 nonce 把 'unsafe-inline' 顶掉了，内联 style 属性整体失效。" +
        "检查 src-tauri/tauri.conf.json 的 dangerousDisableAssetCspModification 是否还包含 \"style-src\"。"
    );
    if (r.csp) {
      detail.push(`页面 CSP：${r.csp.length > 400 ? r.csp.slice(0, 400) + "…" : r.csp}`);
    }
  } else if (r.useInlineInCsp === false) {
    detail.push("提示：CSP 里已经没有 'unsafe-inline'（仍能生效说明 asset 改写已被关掉）。");
  }
  return { ok, detail };
}

/** B. 公式排版真的生效：`.vlist > span` 的 top 被应用 + 所有公式都有高度。 */
async function assertKatexLayout() {
  const raw = await evaluate(`(() => {
    ${PRELUDE}
    const r = root();
    if (!r) return JSON.stringify({ error: "找不到样例正文（.md-body 里没有标记 " + SENTINEL + "）" });
    const all = [...r.querySelectorAll(".katex")];
    const inline = [...r.querySelectorAll("p .katex")].filter((k) => !k.closest(".katex-display"));
    let pick = null;
    for (const k of inline) {
      const spans = [...k.querySelectorAll(".vlist > span")].filter((s) =>
        /(^|;)\\s*top\\s*:/.test(s.getAttribute("style") || "")
      );
      if (spans.length > 0) { pick = { span: spans[0], katex: k }; break; }
    }
    return JSON.stringify({
      katexCount: all.length,
      inlineCount: inline.length,
      heights: all.map((k) => box(k).h),
      pick: pick
        ? {
            styleAttr: pick.span.getAttribute("style"),
            computedTop: getComputedStyle(pick.span).top,
            spanBox: box(pick.span),
            katexBox: box(pick.katex),
          }
        : null,
      inlineLooks: inline.map((k) => k.textContent.slice(0, 24)),
    });
  })()`);
  const r = JSON.parse(raw);
  if (r.error) {
    return { ok: false, detail: [r.error] };
  }
  const detail = [
    `.katex 总数 = ${r.katexCount}（行内 ${r.inlineCount} 个）`,
    `各公式高度 = ${JSON.stringify(r.heights)}（都要 > 4px）`,
  ];
  const failures = [];
  if (r.katexCount === 0) {
    failures.push("正文里一个 .katex 都没有：公式根本没渲染出来（KaTeX 管线或清洗环节出问题）。");
  }
  if (!r.pick) {
    failures.push(
      "没有找到「含 .vlist > span[style*=top] 的行内公式」：内联样式可能整批丢了，或样例没渲染。"
    );
  } else {
    detail.push(
      `行内公式上下标 span：style="${r.pick.styleAttr}" → 计算 top=${r.pick.computedTop}（不能是 0px）`
    );
    if (r.pick.computedTop === "0px" || r.pick.computedTop === "auto") {
      failures.push(
        `上标 span 的 top 没被应用（计算值 ${r.pick.computedTop}）：KaTeX 的内联样式失效，` +
          "上下标会掉行 —— 与断言 A 同源（CSP 的 style-src 改写）。"
      );
    }
  }
  const flat = r.heights.filter((h) => !(h > 4));
  if (flat.length > 0) {
    failures.push(`有 ${flat.length} 个公式高度 ≤ 4px（塌成一条线）：${JSON.stringify(flat)}`);
  }
  if (failures.length > 0) {
    detail.push(...failures);
  }
  return { ok: failures.length === 0, detail };
}

/** C. 块级公式高度合理。 */
async function assertDisplayMath() {
  const raw = await evaluate(`(() => {
    ${PRELUDE}
    const r = root();
    if (!r) return JSON.stringify({ error: "找不到样例正文" });
    const displays = [...r.querySelectorAll(".katex-display")];
    return JSON.stringify({
      count: displays.length,
      heights: displays.map((d) => box(d).h),
      text: displays.map((d) => d.textContent.slice(0, 40)),
    });
  })()`);
  const r = JSON.parse(raw);
  if (r.error) {
    return { ok: false, detail: [r.error] };
  }
  const bad = r.heights.filter((h) => !(h > 20));
  return {
    ok: r.count > 0 && bad.length === 0,
    detail: [
      `.katex-display 数量 = ${r.count}`,
      `高度 = ${JSON.stringify(r.heights)}（都要 > 20px）`,
      ...(r.count === 0 ? ["块级公式没渲染出来。"] : []),
      ...(bad.length > 0 ? [`高度不足的块级公式：${JSON.stringify(bad)}（内联样式失效会挤成一团）`] : []),
    ],
  };
}

/** D. KaTeX 字体真的加载了，且没有字体处于 error 状态。 */
async function assertFonts() {
  await waitFor(async () => await evaluate(`document.fonts.check('12px "KaTeX_Main"')`), WAIT_FONT_MS, "KaTeX_Main 字体加载");
  const raw = await evaluate(`(() => {
    const faces = [...document.fonts].filter((f) => f.family.startsWith("KaTeX"));
    return JSON.stringify({
      check: document.fonts.check('12px "KaTeX_Main"'),
      total: faces.length,
      errors: faces.filter((f) => f.status === "error").map((f) => f.family + "/" + f.weight + "/" + f.style),
      loaded: faces.filter((f) => f.status === "loaded").map((f) => f.family),
    });
  })()`);
  const r = JSON.parse(raw);
  return {
    ok: r.check === true && r.errors.length === 0,
    detail: [
      `document.fonts.check('12px "KaTeX_Main"') = ${r.check}（期望 true）`,
      `KaTeX 字体面 ${r.total} 个，已加载：${JSON.stringify(r.loaded)}`,
      `error 状态：${r.errors.length === 0 ? "无" : JSON.stringify(r.errors)}`,
      ...(r.errors.length > 0
        ? ["字体加载失败会让公式退化成回退字体（打包版 CSP 会拦掉被内联成 data: 的字体）。"]
        : []),
    ],
  };
}

/** E. 主题色方案跟随 data-theme + 样式表里确有自定义滚动条规则。 */
async function assertThemeAndScrollbar() {
  const raw = await evaluate(`(() => {
    const attr = document.documentElement.getAttribute("data-theme");
    const expected = attr === "light" ? "light" : "dark";
    const seen = new Set();
    const walk = (rules) =>
      [...rules].some((rule) => {
        if ((rule.selectorText || "").includes("::-webkit-scrollbar")) return true;
        if (rule.cssRules && !seen.has(rule)) { seen.add(rule); return walk(rule.cssRules); }
        return false;
      });
    const hasScrollbarRule = [...document.styleSheets].some((sheet) => {
      try { return walk(sheet.cssRules); } catch (e) { return false; }
    });
    return JSON.stringify({
      dataTheme: attr,
      expected,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      hasScrollbarRule,
      sheets: document.styleSheets.length,
    });
  })()`);
  const r = JSON.parse(raw);
  const okScheme = r.colorScheme === r.expected;
  const failures = [];
  if (!okScheme) {
    failures.push(`colorScheme=${r.colorScheme} 与 data-theme="${r.dataTheme}"（期望 ${r.expected}）不一致。`);
  }
  if (!r.hasScrollbarRule) {
    failures.push("样式表里没有 ::-webkit-scrollbar 规则（深色滚动条会掉回系统默认）。");
  }
  return {
    ok: failures.length === 0,
    detail: [
      `data-theme = ${JSON.stringify(r.dataTheme)} → colorScheme = ${JSON.stringify(r.colorScheme)}（期望 ${r.expected}）`,
      `::-webkit-scrollbar 规则：${r.hasScrollbarRule ? "存在" : "缺失"}（扫了 ${r.sheets} 张样式表）`,
      ...failures,
    ],
  };
}

/** F. 没有未捕获的页面错误（异常 + error 级日志）。 */
async function assertNoPageErrors() {
  // 收到的内容全部打印出来（便于排查）：日志 + 未捕获异常
  const dumped =
    events.length === 0
      ? ["（没有收到任何日志 / 异常条目）"]
      : events.map((e) => {
          const oneLine = String(e.text ?? "").replace(/\s+/g, " ").trim();
          const shown =
            oneLine.length > 200 ? oneLine.slice(0, 200) + `…（共 ${oneLine.length} 字）` : oneLine;
          return `[${e.phase}/${e.kind}/${e.level}] ${shown}`;
        });

  const errors = events.filter((e) => e.level === "error");
  const known = errors.filter(isKnownInlinedFontCsp);
  const real = errors.filter((e) => !isKnownInlinedFontCsp(e));
  const analysis = [`共 ${events.length} 条条目，其中 error 级 ${errors.length} 条`];
  if (known.length > 0) {
    analysis.push(
      `${known.length} 条是已知打包版问题（不计入失败）：CSP 的 font-src 'self' 拦掉了被 Vite 内联成 data: 的 KaTeX 字体。`
    );
  }
  for (const e of real) {
    analysis.push(`未预期的 ${e.kind}（${e.source ?? "?"}）：${String(e.text ?? "").slice(0, 200)}`);
  }
  return { ok: real.length === 0, detail: [...dumped, "", ...analysis] };
}

/**
 * G. 两条「只有打包版才验得到」的回归：
 *   1. 公式的 MathML `<annotation>` 仍在 —— DOMPurify 的 MathML 白名单默认没有
 *      `semantics`/`annotation`，会把标签删掉只留文本（视觉看不出来，但复制公式拿不到
 *      LaTeX、读屏也少了注解），修复靠 `sanitize.ts` 的 `ADD_TAGS`；
 *   2. fixture 同目录的本地图片**真的加载出来了** —— 这同时证明 asset 协议开着、
 *      CSP 的 `img-src` 放行 `asset:`、以及后端**动态授权了文档所在目录**
 *      （三者任一缺失，图片都会退回占位符）。
 */
async function assertAnnotationAndLocalImage() {
  const raw = await evaluate(`(() => {
    ${PRELUDE}
    const body = root();
    const anns = body ? [...body.querySelectorAll(".katex annotation")].map((a) => (a.textContent || "").trim()) : [];
    const chip = body ? body.querySelector(".md-image") : null;
    const img = chip ? chip.querySelector("img.md-image-img") : null;
    return JSON.stringify({
      annotationCount: anns.length,
      annotationSample: anns.slice(0, 3),
      chipState: chip ? chip.dataset.mdState ?? "(pending)" : null,
      chipSrc: chip ? chip.dataset.mdSrc : null,
      naturalW: img ? img.naturalWidth : null,
      naturalH: img ? img.naturalHeight : null,
    });
  })()`);
  const r = JSON.parse(raw);
  const failures = [];
  if (r.annotationCount === 0) {
    failures.push(
      "KaTeX 的 <annotation> 不见了：清洗又把 semantics/annotation 剥掉了（复制公式会拿不到 LaTeX 源码）。"
    );
  }
  if (r.chipState !== "loaded" || !(r.naturalW > 0)) {
    failures.push(
      `本地图片没加载：state=${r.chipState}、naturalWidth=${r.naturalW ?? "null"}（asset 协议 / CSP img-src / 文档目录动态授权 三者任一没生效都会这样）。`
    );
  }
  return {
    ok: failures.length === 0,
    detail: [
      ...failures,
      `<annotation> 数量 = ${r.annotationCount}，样例 = ${JSON.stringify(r.annotationSample)}`,
      `图片容器 state = ${r.chipState}，尺寸 = ${r.naturalW}×${r.naturalH}`,
      `图片绝对路径 = ${r.chipSrc}`,
    ],
  };
}

// ==================== 断言 H：CSV 表格（打包版专属） ====================

/** 页面内定位「当前可见的 CSV 表格页」并读出表头 / 数据行 / 行数文案。 */
const CSV_PRELUDE = `
const panel = () => [...document.querySelectorAll(".tab-panel")]
  .find((p) => p.getBoundingClientRect().height > 0
    && p.querySelector(".body-view[data-view='csv-table']"));
const cells = (sel) => [...panel().querySelectorAll(sel)];
const csvHeads = () => cells(".cfg-head-cell").map((c) => c.textContent.trim());
const csvRows = () => cells(".cfg-row").map((r) =>
  [...r.querySelectorAll(".cfg-cell")].map((c) => c.textContent));
`;

/**
 * CSV 表格：默认模式 + 真实后端解析 + 编码层。
 *
 * 断言的是「接线」而不是解析规则本身（解析规则的细节在 `cargo test --lib csv_table`）：
 * `.csv` 打开后正文直接是 csv-table 页、表头取首行（BOM 已剥）、引号字段里的逗号与
 * 换行没有被切开、GBK 文件的中文能解出来。
 */
async function assertCsvTable() {
  const failures = [];

  // ---- 1. UTF-8 + BOM，带引号 / 多行 / 空字段 ----
  await evaluate(`window.__lvOpenPath(${JSON.stringify(CSV_FIXTURE)})`);
  await waitFor(
    async () => await evaluate(`(() => { ${CSV_PRELUDE} return !!panel(); })()`),
    WAIT_FIXTURE_MS,
    "CSV 默认进表格视图（.body-view[data-view=csv-table]）"
  );
  await sleep(300);
  const utf8 = JSON.parse(
    await evaluate(`(() => {
      ${CSV_PRELUDE}
      const p = panel();
      return JSON.stringify({
        heads: csvHeads(),
        rows: csvRows(),
        count: p.querySelector(".cfg-count")?.textContent ?? null,
        banner: p.querySelector(".cfg-banner")?.textContent ?? null,
        delimiter: p.querySelector(".cfg-delim-select")?.value ?? null,
        headersChecked: p.querySelector(".cfg-check input")?.checked ?? null,
      });
    })()`)
  );

  const wantHeads = ["name", "qty", "note"];
  const wantRows = [
    ["apple", "3", "fresh, sweet"],
    ["pear", "", "line1\u240aline2"],
    ["banana", "5", 'he said "hi"'],
  ];
  if (JSON.stringify(utf8.heads) !== JSON.stringify(wantHeads)) {
    failures.push(
      `表头不对：${JSON.stringify(utf8.heads)}（BOM 没剥掉时首列会是 "\\uFEFFname"）`
    );
  }
  if (JSON.stringify(utf8.rows) !== JSON.stringify(wantRows)) {
    failures.push(`数据行不对：${JSON.stringify(utf8.rows)}`);
  }
  if (!(utf8.count ?? "").includes("3 行")) {
    failures.push(`行数/列数文案不对：${JSON.stringify(utf8.count)}`);
  }
  if (utf8.banner) {
    failures.push(`小文件不该出现截断横幅：${JSON.stringify(utf8.banner)}`);
  }
  if (utf8.delimiter !== "," || utf8.headersChecked !== true) {
    failures.push(
      `工具栏默认值不对：分隔符=${JSON.stringify(utf8.delimiter)}、首行为表头=${utf8.headersChecked}`
    );
  }

  // `shoot` 只在传了 --shot 时才有目录可用（其余断言也不截图）。
  if (SHOT_DIR) {
    await shoot("03-csv-table.png", { captureBeyondViewport: true });
  }

  // ---- 2. GBK（Excel 导出的常见形态）：自动探测应解出中文 ----
  await evaluate(`window.__lvOpenPath(${JSON.stringify(CSV_GBK_FIXTURE)})`);
  const gbk = await waitFor(
    async () => {
      const raw = await evaluate(`(() => {
        ${CSV_PRELUDE}
        const p = panel();
        if (!p) return null;
        const heads = csvHeads();
        // 等到「当前可见的表格页」换成了 GBK 那份（表头是中文）
        if (heads[0] !== "名称") return null;
        return JSON.stringify({ heads, rows: csvRows() });
      })()`);
      return raw ? JSON.parse(raw) : null;
    },
    WAIT_FIXTURE_MS,
    "GBK 样例解析出中文表头"
  ).catch(() => null);

  if (!gbk) {
    const raw = await evaluate(`(() => {
      ${CSV_PRELUDE}
      return JSON.stringify({ heads: panel() ? csvHeads() : null, rows: panel() ? csvRows() : null });
    })()`);
    failures.push(`GBK 样例没解出中文：${raw}（自动探测应落到 GB18030 兜底编码）`);
  } else if (JSON.stringify(gbk.rows) !== JSON.stringify([["苹果", "3"], ["梨", "5"]])) {
    failures.push(`GBK 样例数据行不对：${JSON.stringify(gbk.rows)}`);
  }

  // ---- 3. 页内查找在打包版里也能用（真实的 CSP 下没有内联样式可用） ----
  await evaluate(`window.__lvOpenPath(${JSON.stringify(CSV_FIXTURE)})`);
  await waitFor(
    async () => await evaluate(`(() => { ${CSV_PRELUDE} return !!panel(); })()`),
    WAIT_FIXTURE_MS,
    "回到 UTF-8 样例的表格页"
  );
  await sleep(300);
  await evaluate(`document.activeElement?.blur();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
    true`);
  await sleep(300);
  const findOpen = await evaluate(`(() => { ${CSV_PRELUDE} return !!panel().querySelector(".find-widget"); })()`);
  if (!findOpen) {
    failures.push("Ctrl+F 没打开查找框");
  } else {
    await evaluate(`(() => {
      ${CSV_PRELUDE}
      const input = panel().querySelector(".find-input");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "fresh");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await sleep(600);
    const find = JSON.parse(
      await evaluate(`(() => {
        ${CSV_PRELUDE}
        const p = panel();
        return JSON.stringify({
          count: p.querySelector(".find-count")?.textContent ?? null,
          mark: p.querySelector(".cfg-cell .find-mark.current")?.textContent ?? null,
          focus: document.activeElement === p.querySelector(".find-input"),
        });
      })()`)
    );
    if (find.count !== "1/1" || find.mark !== "fresh") {
      failures.push(`查找计数/命中不对：count=${JSON.stringify(find.count)}、mark=${JSON.stringify(find.mark)}`);
    }
    if (!find.focus) {
      failures.push("查找框打开后没有聚焦到输入框");
    }
    await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); true`);
  }

  return {
    ok: failures.length === 0,
    detail: [
      ...failures,
      `UTF-8+BOM 样例：表头 ${JSON.stringify(utf8.heads)}、${utf8.rows.length} 行数据、分隔符 ${JSON.stringify(utf8.delimiter)}`,
      `引号字段（含逗号 / 换行 / ""）与空字段都按原文还原；${utf8.banner ? "有截断横幅" : "无截断横幅"}`,
      `GBK 样例：${gbk ? JSON.stringify(gbk.rows) : "未解出中文"}`,
      `查找：Ctrl+F 开框 + 聚焦 + 命中计数（"fresh" → 1/1）`,
    ],
  };
}

// ==================== 截图 ====================
async function shoot(file, params) {
  const r = await cdp.send("Page.captureScreenshot", { format: "png", ...params });
  mkdirSync(SHOT_DIR, { recursive: true });
  const out = join(SHOT_DIR, file);
  writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`  screenshot: ${out}`);
}

async function captureShots() {
  if (!SHOT_DIR) {
    return;
  }
  console.log("");
  console.log("===== 截图 =====");
  // 1) 整页（应用窗口是固定布局，captureBeyondViewport 会按整页内容渲染）
  await shoot("01-smoke.png", { captureBeyondViewport: true });

  // 2) 公式放大：先让块级公式滚进视野，再按它的位置裁一块、3 倍放大
  const clip = await evaluate(`(() => {
    ${PRELUDE}
    const r = root();
    const target = r?.querySelector(".katex-display") ?? r?.querySelector(".katex");
    if (!target) return null;
    target.scrollIntoView({ block: "center", inline: "nearest" });
    const b = target.getBoundingClientRect();
    const pad = 10;
    return JSON.stringify({
      x: Math.max(0, b.left + window.scrollX - pad),
      y: Math.max(0, b.top + window.scrollY - pad),
      width: Math.max(1, b.width + pad * 2),
      height: Math.max(1, b.height + pad * 2),
      scale: 3,
    });
  })()`);
  if (!clip) {
    throw new SmokeError("公式区域截图失败：正文里找不到 .katex-display / .katex");
  }
  await sleep(300);
  await shoot("02-formula-zoom.png", { captureBeyondViewport: true, clip: JSON.parse(clip) });
}

// ==================== 主流程 ====================

async function main() {
  if (typeof WebSocket !== "function") {
    throw new SmokeError(
      `当前 Node（${process.version}）没有全局 WebSocket —— 请用 Node ≥ 22 运行，` +
        "或在 Node 20 上加 --experimental-websocket。"
    );
  }

  if (!existsSync(EXE)) {
    throw new SmokeError(
      `找不到打包好的 exe：${EXE}\n  请先执行 make loglens-build（或用 --exe <path> 指定）。`
    );
  }
  assertNoRunningInstance();
  await assertPortFree();
  writeFixture();

  const st = statSync(EXE);
  console.log("===== 环境 =====");
  console.log(`exe        : ${EXE}`);
  console.log(`             ${(st.size / 1024 / 1024).toFixed(1)} MB，构建于 ${st.mtime.toLocaleString()}`);
  console.log(`调试端口   : ${PORT}（WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=${PORT}）`);
  console.log(`样例文档   : ${FIXTURE}`);
  console.log(`截图目录   : ${SHOT_DIR ?? "（未启用；--shot <目录> 可导出）"}`);
  console.log("");

  console.log("===== 启动打包版 LogLens（会弹出真实窗口） =====");
  child = spawn(EXE, [], {
    stdio: "ignore",
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
  });
  console.log(`  PID ${child.pid}，等待 WebView2 的 CDP 端口 …`);

  // 只要「我们这台应用」的 page target：端口上可能挂着别人的调试目标（见 assertPortFree）
  let foreignTargets = [];
  let page = null;
  try {
    page = await waitFor(
      async () => {
        if (child.exitCode !== null) {
          throw new SmokeError(`LogLens 启动后立刻退出（exit code ${child.exitCode}）。`);
        }
        try {
          const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
          foreignTargets = list.filter((t) => t.type === "page" && !isAppTarget(t.url)).map((t) => t.url);
          return list.find((t) => t.type === "page" && isAppTarget(t.url)) ?? null;
        } catch {
          return null;
        }
      },
      WAIT_TARGET_MS,
      `打包版页面 target（${WAIT_TARGET_MS / 1000}s 内没等到 http://tauri.localhost）`
    );
  } catch (e) {
    if (foreignTargets.length > 0) {
      throw new SmokeError(
        `${e.message}\n  端口 ${PORT} 上确实有 page target，但都不是这台应用：${foreignTargets.join(", ")}\n` +
          "  （例如 tools/e2e-markdown.mjs --launch 起的无头 Edge 也用 9222）→ 换 --port 或先结束它。"
      );
    }
    throw new SmokeError(
      `${e.message}\n  exe 没起来？另一个 LogLens 在跑？端口被占？可以先单独手动跑一遍 ${EXE} 看看。`
    );
  }
  console.log(`  target: ${page.url}`);

  cdp = await connect(page.webSocketDebuggerUrl, onCdpEvent);
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.enable");

  // 首屏：应用外壳 + 标签栏 + 正文页（有会话存档时才有 tab；空会话也能继续）
  await waitFor(async () => await evaluate(`!!document.querySelector(".tabbar")`), WAIT_SHELL_MS, "应用外壳 .tabbar");
  await waitFor(
    async () => await evaluate(`!!document.querySelector(".tabbar .tab") && !!document.querySelector(".body-view")`),
    8000,
    "恢复的标签页与正文页（.tabbar .tab + .body-view）"
  ).catch(() => {
    console.log("  提示：没有恢复到任何标签页（会话存档是空的），后面直接用测试钩子开样例。");
  });
  const shell = await evaluate(`JSON.stringify({
    tabs: document.querySelectorAll(".tabbar .tab").length,
    bodyViews: [...document.querySelectorAll(".body-view")].map((v) => v.dataset.view),
    hook: typeof window.__lvOpenPath,
    theme: document.documentElement.getAttribute("data-theme"),
  })`);
  const s = JSON.parse(shell);
  console.log(
    `  首屏：.tabbar .tab=${s.tabs} / .body-view=${JSON.stringify(s.bodyViews)} / 钩子=${s.hook} / theme=${s.theme}`
  );
  if (s.hook !== "function") {
    throw new SmokeError("页面上没有 window.__lvOpenPath 测试钩子，无法打开样例（应用版本不对？）。");
  }
  await sleep(1500); // 让启动期的异步渲染（含会话恢复的文档）把日志都打完

  // 首屏结束 → 后面的日志条目才算「本次运行」
  phase = "run";

  console.log("");
  console.log("===== 打开样例并等渲染 =====");
  await evaluate(`window.__lvOpenPath(${JSON.stringify(FIXTURE)})`);
  await waitFor(
    async () => await evaluate(`(() => { ${PRELUDE} return !!root(); })()`),
    WAIT_FIXTURE_MS,
    `样例文档渲染出 .md-body（标记 ${SENTINEL}）`
  );
  const katexSeen = await waitFor(
    async () => await evaluate(`(() => { ${PRELUDE} const r = root(); return !!r?.querySelector(".katex"); })()`),
    WAIT_KATEX_MS,
    "样例里的 KaTeX 公式节点"
  ).catch(() => false);
  const katexCount = await evaluate(
    `(() => { ${PRELUDE} return root()?.querySelectorAll(".katex").length ?? 0; })()`
  );
  console.log(`  样例正文已渲染，.katex 节点 ${katexCount} 个${katexSeen ? "" : "（等待超时，断言 B 会给出细节）"}`);
  await sleep(800); // 给字体加载 / 布局一点时间

  console.log("");
  console.log("===== 断言 =====");
  await check("A", "内联 style 生效（本次 CSP 修复的核心回归）", assertInlineStyle);
  await check("B", "公式排版真的生效（.vlist top 被应用、公式有高度）", assertKatexLayout);
  await check("C", "块级公式高度合理", assertDisplayMath);
  await check("D", "KaTeX 字体加载（check + 无 error 字体）", assertFonts);
  await check("E", "主题色方案跟随 data-theme 且存在滚动条规则", assertThemeAndScrollbar);
  await check("F", "没有未捕获的页面错误", assertNoPageErrors);
await check("G", "公式注解可复制 + 本地图片真的加载（打包版专属）", assertAnnotationAndLocalImage);

  await captureShots();

  // CSV 表格放在截图之后：它会把 CSV 标签页切到最前，而上面的成品截图要的是 Markdown 页。
  await check("H", "CSV 默认表格视图 + 真实后端解析（打包版专属）", assertCsvTable);

  // ---------- 汇总 ----------
  const failed = results.filter((r) => !r.ok);
  const knownIssue = events.filter((e) => e.level === "error" && isKnownInlinedFontCsp(e));
  console.log("");
  console.log("===== 汇总 =====");
  for (const r of results) {
    console.log(`  [${r.id}] ${r.ok ? "通过" : "失败"}  ${r.title}`);
  }
  if (failed.length > 0) {
    console.log("");
    console.log("失败清单：");
    for (const r of failed) {
      console.log(`  - [${r.id}] ${r.title}`);
      for (const d of r.detail) {
        console.log(`      ${d}`);
      }
    }
  }
  if (knownIssue.length > 0) {
    console.log("");
    console.log("已知打包版问题（不计入失败，但建议单独修）：");
    console.log(`  - ${knownIssue.length} 条 CSP 拦截：Vite 把 KaTeX_Size3-Regular.woff2（3624 B，小于默认内联阈值 4096 B）`);
    console.log("    内联成了 data: URL，而 CSP 的 font-src 'self' 不允许 data: → 打开任意 .md 都会报一次。");
    console.log("    影响：用到 KaTeX_Size3 的数学（\\left( \\right) / \\bigg 这类大号定界符）会退化成回退字体。");
    console.log("    方向：调高 vite 的 build.assetsInlineLimit，或给 CSP 的 font-src 放行 data:。");
  }
  console.log("");
  console.log(`结果：${failed.length === 0 ? `全部通过（${results.length}/${results.length}）` : `${failed.length}/${results.length} 条失败`}`);
  return failed.length === 0 ? 0 : 1;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (e) {
  if (e instanceof SmokeError) {
    console.error("");
    console.error("冒烟脚本无法继续：" + e.message);
  } else {
    console.error("");
    console.error("冒烟脚本异常：", e?.stack ?? e);
  }
} finally {
  cleanup();
}

console.log(`退出码：${exitCode}`);
process.exit(exitCode);
