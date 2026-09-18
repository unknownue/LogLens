// verify-encoding.test.mjs — 编码支持（状态栏 + 编码弹窗）的规则检查。
//
// 四类断言：
//   1. **纯逻辑**（src/statusbar/encoding.ts）：分组、显示名、BOM、预览裁剪、乱码判定；
//   2. **前后端契约**：`auto` 哨兵、分组键、探测依据（source）三处枚举在 Rust 与 TS
//      两侧必须逐字一致 —— 这类字符串一旦漂移不会有编译错误，只会静默失效
//      （例如后端新增分组、前端没有对应文案，用户就看到一个标题为空的组）；
//   3. **解码唯一入口**：读取链路（tail / search / document / state）里不许再出现
//      `String::from_utf8_lossy` —— 它是「一律按 UTF-8 解」时代的标志，回归一次就是
//      GBK 日志全变乱码；
//   4. **接线检查**：状态栏与弹窗确实被渲染、命令确实被注册（防「写了模块但没接上」）。
//
// 运行：node --test tools/verify-encoding.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTO_ID,
  GROUP_ORDER,
  encodingFullLabel,
  encodingLabel,
  groupOptions,
  looksGarbled,
  optionLabel,
  previewLines,
  sourceKey,
  stripBom,
} from "../src/statusbar/encoding.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 读一个源文件（相对仓库根）。 */
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const ENCODING_TS = read("src/statusbar/encoding.ts");
const ENCODING_MODAL = read("src/statusbar/EncodingModal.tsx");
const STATUS_BAR = read("src/statusbar/StatusBar.tsx");
const STATUS_CSS = read("src/statusbar/statusbar.css");
const APP_TSX = read("src/App.tsx");
const ENCODING_RS = read("src-tauri/src/encoding.rs");
const LIB_RS = read("src-tauri/src/lib.rs");

// ==================== 1. 纯逻辑 ====================

const OPTS = [
  { id: "utf-8", name: "UTF-8", note: "Unicode", group: "unicode" },
  { id: "gbk", name: "GBK", note: "ANSI 936", group: "chinese" },
  { id: "big5", name: "Big5", note: "ANSI 950", group: "chinese" },
  { id: "shift_jis", name: "Shift_JIS", note: "ANSI 932", group: "japanese" },
  { id: "windows-1252", name: "Windows-1252", note: "ANSI 1252", group: "western" },
];

test("options are grouped in the canonical order", () => {
  const groups = groupOptions(OPTS);
  assert.deepEqual(
    groups.map((g) => g.group),
    ["unicode", "chinese", "japanese", "western"]
  );
  // 组内保持上传顺序（不能顺手按名字排序：目录里的顺序是有意的）。
  assert.deepEqual(
    groups[1].items.map((o) => o.id),
    ["gbk", "big5"]
  );
});

test("an unknown group is kept (last), never silently dropped", () => {
  const groups = groupOptions([...OPTS, { id: "x", name: "X", note: "", group: "klingon" }]);
  const last = groups[groups.length - 1];
  assert.equal(last.group, "other");
  assert.deepEqual(
    last.items.map((o) => o.id),
    ["x"]
  );
  // 全部选项都要出现在结果里。
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  assert.equal(total, OPTS.length + 1);
});

test("groupOptions tolerates an empty list", () => {
  assert.deepEqual(groupOptions([]), []);
});

test("the label marks a BOM and the full label appends the alias", () => {
  const utf8 = { choice: "auto", id: "utf-8", name: "UTF-8", note: "Unicode", group: "unicode", source: "bom", bom: true };
  assert.equal(encodingLabel(utf8), "UTF-8 BOM");
  assert.equal(encodingFullLabel(utf8), "UTF-8 BOM · Unicode");

  const gbk = { choice: "gbk", id: "gbk", name: "GBK", note: "ANSI 936", group: "chinese", source: "manual", bom: false };
  assert.equal(encodingLabel(gbk), "GBK");
  assert.equal(encodingFullLabel(gbk), "GBK · ANSI 936");

  // 别名可能为空（目录里允许）。
  const bare = { ...gbk, note: "" };
  assert.equal(encodingFullLabel(bare), "GBK");

  // 没有信息时给空串，而不是 "undefined"。
  assert.equal(encodingLabel(null), "");
  assert.equal(encodingFullLabel(undefined), "");
});

test("optionLabel mirrors the full label", () => {
  assert.equal(optionLabel({ name: "GBK", note: "ANSI 936" }), "GBK · ANSI 936");
  assert.equal(optionLabel({ name: "UTF-8", note: "" }), "UTF-8");
});

test("stripBom removes exactly one leading BOM", () => {
  assert.equal(stripBom("\uFEFF# 标题"), "# 标题");
  assert.equal(stripBom("# 标题"), "# 标题");
  assert.equal(stripBom("\uFEFF\uFEFFx"), "\uFEFFx");
  assert.equal(stripBom(""), "");
});

test("previewLines keeps at most N lines and drops the trailing empty one", () => {
  assert.deepEqual(previewLines("a\nb\nc\n", 10), ["a", "b", "c"]);
  assert.deepEqual(previewLines("a\nb\nc", 10), ["a", "b", "c"]);
  assert.deepEqual(previewLines("a\nb\nc\nd", 2), ["a", "b"]);
  // CRLF / CR 都按行分开（编码无关，看的是文本层）。
  assert.deepEqual(previewLines("a\r\nb\rc", 10), ["a", "b", "c"]);
  assert.deepEqual(previewLines("", 10), []);
  // 首行 BOM 顺手剥掉：预览里那是个看不见的零宽字符，只会让人困惑。
  assert.deepEqual(previewLines("\uFEFFa\nb", 10), ["a", "b"]);
});

test("previewLines trims the replacement char left by a byte-level truncation", () => {
  // 后端按字节截断，可能把最后一个字符切成两半 → 结尾一个 U+FFFD。
  // 那是读取方式的产物，不是文件的乱码 —— 但**只有调用方确知读被截断**时才裁。
  const text = "第一行\n第二行\uFFFD";
  assert.deepEqual(previewLines(text, 10, true), ["第一行", "第二行"]);
  // 未被截断的读取：结尾的替换字符是真实内容，不能抹掉。
  assert.deepEqual(previewLines(text, 10, false), ["第一行", "第二行\uFFFD"]);
  // 裁短后（行数超过 max）时，被裁掉的末行本来就不显示，也谈不上裁它。
  assert.deepEqual(previewLines("a\uFFFDb\nc", 10, true), ["a\uFFFDb", "c"]);
  // 中间行的替换字符是真实信息（说明该编码解不动这些字节），永远保留。
  assert.deepEqual(previewLines("a\uFFFDb\nc\uFFFD", 10, true), ["a\uFFFDb", "c"]);
});

test("looksGarbled only fires when replacement chars dominate", () => {
  assert.equal(looksGarbled(""), false);
  assert.equal(looksGarbled("正常的中文日志"), false);
  // 单个替换字符永远不算：字节上限截断恰好切在字符中间就会产生一个。
  assert.equal(looksGarbled("a\uFFFDb"), false, "个别替换字符不算乱码");
  assert.equal(looksGarbled("\uFFFD\uFFFD\uFFFD"), false, "太少，不足以判断");
  assert.equal(looksGarbled("\uFFFD\uFFFD\uFFFD\uFFFD"), true);
  // 阈值按字符数算，不是字节数：长文本里零星几个替换字符不该报警。
  const long = "x".repeat(400) + "\uFFFD";
  assert.equal(looksGarbled(long), false);
});

test("sourceKey normalises the raw source string", () => {
  const at = (source) => ({
    choice: "auto", id: "utf-8", name: "UTF-8", note: "", group: "unicode", source, bom: false,
  });
  for (const s of ["bom", "utf8", "fallback", "manual"]) {
    assert.equal(sourceKey(at(s)), s);
  }
  assert.equal(sourceKey(at("something-new")), null, "未知来源返回 null，不编造文案");
  assert.equal(sourceKey(null), null);
});

// ==================== 2. 前后端契约 ====================

test("the auto sentinel is byte-identical on both sides", () => {
  const rust = ENCODING_RS.match(/pub const AUTO: &str = "([^"]+)"/);
  assert.ok(rust, "encoding.rs 里应有 AUTO 常量");
  assert.equal(AUTO_ID, rust[1], "TS 的 AUTO_ID 必须与 Rust 的 AUTO 一致");
});

test("the fallback encoding is declared once, on the Rust side", () => {
  const rust = ENCODING_RS.match(/pub const FALLBACK_ID: &str = "([^"]+)"/);
  assert.ok(rust, "encoding.rs 里应有 FALLBACK_ID 常量");
  // 前端**不该**硬编码兜底编码：它由后端探测给出（`source: "fallback"`），
  // 前端复制一份就会出现「后端换了兜底编码而状态栏还写着旧名字」。
  assert.ok(
    !ENCODING_TS.includes(rust[1]) && !STATUS_BAR.includes(rust[1]),
    `前端不应硬编码兜底编码 ${rust[1]}（应由后端探测结果带过来）`
  );
});

test("every Rust encoding group has a localized heading in the modal", () => {
  const rustGroups = [...ENCODING_RS.matchAll(/Group::(\w+) => "([^"]+)"/g)].map((m) => m[2]);
  assert.ok(rustGroups.length >= 5, "Rust 侧应至少声明 5 个分组");

  for (const lang of ["zh", "en"]) {
    for (const g of rustGroups) {
      const re = new RegExp(`\\b${g}:\\s*"`);
      assert.ok(
        re.test(ENCODING_MODAL),
        `弹窗文案缺少分组 ${g}（${lang}）—— 后端加了分组，前端就会渲染出空标题`
      );
    }
  }
  // GROUP_ORDER 必须覆盖全部后端分组（决定列表顺序）。
  for (const g of rustGroups) {
    assert.ok(GROUP_ORDER.includes(g), `GROUP_ORDER 缺少 ${g}`);
  }
});

test("every probe source has a hint in the status bar", () => {
  const rustSources = [...ENCODING_RS.matchAll(/Source::\w+ => "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(rustSources.length === 4, `应声明 4 种探测依据，实测 ${rustSources.length}`);
  for (const s of rustSources) {
    assert.ok(
      STATUS_BAR.includes(`case "${s}"`),
      `状态栏缺少探测依据 ${s} 的说明文案`
    );
  }
});

test("the encoding catalog is not duplicated on the frontend", () => {
  // 目录（可选编码清单）的唯一事实来源是 Rust；前端只通过 list_encodings 取。
  // 这里盯住「前端不要自己写一份 id 表」：出现两个以上目录 id 的字面量就说明抄了。
  const knownIds = ["gb18030", "big5", "shift_jis", "euc-jp", "euc-kr", "windows-1252"];
  const hits = knownIds.filter((id) => ENCODING_TS.includes(`"${id}"`));
  assert.deepEqual(hits, [], `前端硬编码了目录 id: ${hits.join(", ")}`);

  assert.ok(
    APP_TSX.includes('invoke<EncodingOption[]>("list_encodings")') ||
      read("src/statusbar/encoding-ipc.ts").includes('invoke<EncodingOption[]>("list_encodings")'),
    "编码目录必须来自后端的 list_encodings 命令"
  );
});

test("the rename-visible ids match the Rust catalog", () => {
  // 目录里每个 id 都必须是「小写 + 数字 + -_」：它会被写进 localStorage 存档，
  // 大写或空格会让 normalize_id 的两轮匹配都落空。
  const ids = [...ENCODING_RS.matchAll(/^\s+id: "([^"]+)",$/gm)].map((m) => m[1]);
  assert.ok(ids.length >= 10, `目录规模应有 10 项以上，实测 ${ids.length}`);
  for (const id of ids) {
    assert.match(id, /^[a-z0-9][a-z0-9._-]*$/, `目录 id 不规范: ${id}`);
  }
  assert.equal(new Set(ids).size, ids.length, "目录 id 有重复");
});

// ==================== 3. 解码唯一入口 ====================

/** 去掉 `#[cfg(test)]` 之后的正文（测试模块里出现旧写法不影响生产路径的判定）。 */
const prodOnly = (src) => src.split("#[cfg(test)]")[0];

test("the read paths no longer assume UTF-8", () => {
  // from_utf8_lossy 是「一律按 UTF-8 解」的标志。读取链路里出现它，意味着有一条路
  // 绕过了编码层 —— 那条路上的 GBK 日志会重新变回一片 U+FFFD。
  for (const rel of [
    "src-tauri/src/tail.rs",
    "src-tauri/src/search.rs",
    "src-tauri/src/document.rs",
    "src-tauri/src/state.rs",
    "src-tauri/src/index.rs",
  ]) {
    const src = prodOnly(read(rel));
    assert.ok(
      !src.includes("from_utf8_lossy"),
      `${rel} 正文仍在用 from_utf8_lossy（应走 crate::encoding 解码）`
    );
  }
});

test("the newline is never assumed to be a bare 0x0A in the reader paths", () => {
  // UTF-16 的换行是 2 字节；读取链路里散落裸 `b'\n'` 判定，就说明有一处没走
  // LineTerm —— 表现为行号/行首偏移整体错位半个字符。
  //
  // 唯一的例外是 tail.rs 里两个 `#[allow(dead_code)]` 的历史对照实现
  // （count_lines / line_range_offsets，只认 LF 的全扫参考实现，不被生产路径调用）。
  // 因此这里逐个检查每处 `b'\n'` 所在函数是否标了 `#[allow(dead_code)]`。
  for (const rel of ["src-tauri/src/tail.rs", "src-tauri/src/index.rs"]) {
    const lines = prodOnly(read(rel)).split("\n");
    const offenders = [];
    lines.forEach((line, i) => {
      if (!/b'\\n'/.test(line)) {
        return;
      }
      // 往上找最近的 `fn ` 声明与它的属性行（属性紧贴在 fn 之前）。
      let fnAt = -1;
      for (let j = i; j >= 0 && i - j < 200; j -= 1) {
        if (/^\s*(pub(\(crate\))?\s+)?fn\s/.test(lines[j])) {
          fnAt = j;
          break;
        }
      }
      const attrs = fnAt > 0 ? lines.slice(Math.max(0, fnAt - 4), fnAt).join("\n") : "";
      if (!attrs.includes("#[allow(dead_code)]")) {
        offenders.push(`${rel}:${i + 1} ${line.trim()}`);
      }
    });
    assert.deepEqual(
      offenders,
      [],
      `裸 b'\\n' 换行判定只允许出现在历史对照实现里:\n${offenders.join("\n")}`
    );
  }
});

test("LineIndex is built with the session terminator, not the LF default", () => {
  assert.ok(
    ENCODING_RS.includes("pub term: LineTerm") &&
      read("src-tauri/src/tail.rs").includes("LineIndex::with_term"),
    "TailReader 必须按会话编码建索引（LineIndex::with_term）"
  );
});

// ==================== 4. 接线检查 ====================

test("the status bar and the encoding modal are rendered by App", () => {
  assert.ok(APP_TSX.includes("<StatusBar"), "App 应渲染 StatusBar");
  assert.ok(APP_TSX.includes("<EncodingModal"), "App 应渲染 EncodingModal");
  assert.ok(APP_TSX.includes("statusbar\""), "App 应从 ./statusbar 导入");
});

test("App drives the encoding commands with the documented argument names", () => {
  // tauri 的 IPC 默认把 camelCase 参数映射到 Rust 的 snake_case 形参；
  // 参数名写错不会编译报错，只会在运行时抛「invalid args」。
  assert.ok(
    /invoke<EncodingInfo>\("open_log_file",\s*\{[\s\S]{0,120}?encoding:/.test(APP_TSX),
    "open_log_file 必须带上 encoding 参数"
  );
  assert.ok(
    /invoke<EncodingInfo>\("set_encoding",\s*\{[\s\S]{0,120}?encoding:/.test(APP_TSX),
    "set_encoding 必须带上 encoding 参数"
  );
  assert.ok(
    /invoke<MdDoc>\("read_text_file",\s*\{[\s\S]{0,160}?encoding,/.test(APP_TSX),
    "read_text_file 必须带上 encoding 参数（Markdown 视图也吃编码）"
  );
});

test("the text view is told to rebuild when the encoding changes", () => {
  // 换编码后文本会话被后端整体重建；前端必须重新走一遍 set_encoding/open_log_file，
  // 否则正文还是旧编码解出来的那份。
  assert.ok(
    APP_TSX.includes('"set_encoding"'),
    "文本视图的编码切换必须走后端 set_encoding（整体重建会话）"
  );
});

test("the paused auto-refresh toggle cannot swallow an encoding switch", () => {
  // 「自动刷新」关闭时前端会丢弃实时批次。但换编码发出的也是整体替换事件，
  // 被一起丢掉的话正文会永远停在旧编码上且不会自愈（事件不会再发第二次）。
  // 后端用 `apply_when_paused` 区分「用户动作」与「实时数据」，前端必须照它判断。
  const state = read("src-tauri/src/state.rs");

  assert.ok(
    /pub apply_when_paused: bool/.test(state),
    "LinesPayload 必须声明 apply_when_paused（前端据此决定暂停时要不要应用）"
  );
  assert.ok(
    /!autoRefreshRef\.current && !event\.payload\.apply_when_paused/.test(APP_TSX),
    "监听器必须只丢弃「非用户动作」的批次（不能整个 return）"
  );
  // 会话重建（打开文件 / 换编码）必须为 true，且与 reset 一起发。
  assert.ok(
    /reset: true,[\s\S]{0,120}?apply_when_paused: true/.test(state),
    "start_watching_for_session 的首次 reset 必须带 apply_when_paused: true"
  );
  // 监控线程（轮转 / 截断）与过滤重扫必须为 false。
  assert.ok(
    /apply_when_paused: false/.test(state),
    "监控线程的实时批次必须带 apply_when_paused: false"
  );
  assert.ok(
    /apply_when_paused: false/.test(LIB_RS),
    "set_filter 的重扫必须带 apply_when_paused: false"
  );
});

test("every log-lines emitter takes the session gate", () => {
  // 换会话（set_encoding）时，旧会话的监控线程 / 并发的 set_filter 都不该再发事件 ——
  // 否则前端会把旧编码解出来的行贴到新会话的视图上，且不会自愈。
  // 闸门是 TabSession::emit_gate：发事件持锁，replace_session/close 持锁置 stop。
  const state = read("src-tauri/src/state.rs");
  const emitters = [...state.matchAll(/app\.emit\(\s*"log-lines"/g)].length;
  const gatedInState = [...state.matchAll(/let _gate = (?:session|s)\.emit_gate\.lock\(\)/g)].length;
  assert.ok(
    gatedInState >= emitters,
    `state.rs 里 ${emitters} 处 log-lines 发射点只找到 ${gatedInState} 处持闸门`
  );
  assert.ok(
    /let _gate = session\.emit_gate\.lock\(\)/.test(LIB_RS),
    "lib.rs::set_filter 的发射也必须持闸门（否则它能把旧会话的事件插到新 reset 之后）"
  );
});

test("the encoding choice survives a restart", () => {
  assert.ok(
    APP_TSX.includes("encodings: tabs.map"),
    "会话存档里必须写入各 tab 的编码选择"
  );
  assert.ok(
    /encodings\?:\s*\(string \| null\)\[\]/.test(APP_TSX),
    "SavedTabs 必须声明 encodings 字段"
  );
  // 手动指定才存：`auto` 存 null，下次打开重新探测。
  assert.ok(
    /t\.encoding && t\.encoding !== AUTO_ID \? t\.encoding : null/.test(APP_TSX),
    "auto 不应该被固化成存档里的具体编码"
  );
  // 恢复路径也要把它读回来（存档字段有、读的时候忘了，等于没存）。
  assert.ok(
    /const encodings = Array\.isArray\(v\.encodings\)/.test(APP_TSX),
    "readSavedTabs 必须把 encodings 读回来"
  );
});

test("the toolbar no longer duplicates the line count", () => {
  // 行数已搬到状态栏；工具栏右上角再放一份就是两处会各自漂移的信息。
  assert.ok(!APP_TSX.includes("total-lines"), "App.tsx 不该再引用 .total-lines");
  assert.ok(!read("src/App.css").includes(".total-lines"), "App.css 不该再留 .total-lines 规则");
});

test("the encoding commands are registered on the backend", () => {
  for (const cmd of ["open_log_file", "set_encoding", "get_encoding", "detect_encoding", "list_encodings"]) {
    assert.ok(
      new RegExp(`^\\s*${cmd},?\\s*$`, "m").test(LIB_RS),
      `lib.rs 的 invoke_handler 里缺少 ${cmd}`
    );
  }
});

test("the status bar is themed with variables, never hardcoded colours", () => {
  // 硬编码颜色等于「浅色主题下这条栏还是一片深灰」。允许三种例外：
  // var(--…)；transparent；以及主色块上的前景 —— 纯白 / 半透明白
  //（选中项 + 主按钮，两个主题下 --accent 都是深蓝，白字都合适）。
  const allowed = (v) =>
    v.startsWith("var(") ||
    v === "transparent" ||
    v === "none" ||
    v.startsWith("rgba(") ||
    v === "#ffffff" ||
    v === "#fff";
  const offenders = [...STATUS_CSS.matchAll(/(?:color|background(?:-color)?)\s*:\s*([^;]+);/g)]
    .map((m) => m[1].trim())
    .filter((v) => !allowed(v));
  assert.deepEqual(offenders, [], `状态栏样式出现硬编码颜色: ${offenders.join(" | ")}`);
});

test("the status bar and the modal are always reachable in the markup", () => {
  for (const cls of ["statusbar", "statusbar-lines", "statusbar-encoding"]) {
    assert.ok(STATUS_BAR.includes(cls), `StatusBar 缺少 ${cls}`);
    assert.ok(STATUS_CSS.includes(`.${cls}`), `statusbar.css 缺少 .${cls} 规则`);
  }
  for (const cls of ["encoding-modal", "encoding-item", "encoding-preview-body", "encoding-error"]) {
    const inModal = ENCODING_MODAL.includes(cls);
    assert.ok(inModal, `EncodingModal 缺少 ${cls}`);
    assert.ok(STATUS_CSS.includes(`.${cls}`), `statusbar.css 缺少 .${cls} 规则`);
  }
});

test("the preview reuses the existing read command instead of a new one", () => {
  const ipc = read("src/statusbar/encoding-ipc.ts");
  assert.ok(
    /invoke<\{[^}]*text: string[^}]*\}>\(\s*"read_text_file"/.test(ipc),
    "预览应复用 read_text_file（带 encoding 参数），不要再加一个后端命令"
  );
  assert.ok(
    !LIB_RS.includes("preview_encoding"),
    "后端不该有 preview_encoding 这种只服务弹窗的命令"
  );
});
