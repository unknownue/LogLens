// verify-body-views.test.mjs — Unit checks for the body-area multi-view framework.
//
// The page-selection rules and the error classification are pure functions/modules
// (src/views/body-view.ts, src/views/app-body-views.ts), so they are testable without
// a browser. Run:
//   node --test tools/verify-body-views.test.mjs
// (Node >= 23 strips the TS types on the fly; no build step or test runner needed.)
//
// 覆盖两件事：
//   1. 后端错误文本 → 分类（真实消息样本，含容易误判的样本）；
//   2. 应用真实页面表的优先级 —— 「文件不存在 / 表格 / 通用错误 / 文本」的先后顺序，
//      这是最容易加页面时插错位置的地方。

import test from "node:test";
import assert from "node:assert/strict";

import { BodyViewRegistry, classifyOpenError } from "../src/views/body-view.ts";
import { APP_BODY_VIEWS, resolveAppBodyViewId } from "../src/views/app-body-views.ts";

// ==================== 1. 错误分类 ====================

/** 造一个「无错误」状态。 */
const ok = { kind: "none" };
/** 造一个「分类结果」状态。 */
const state = (error, viewMode) => ({ error, viewMode });

test("no error text is classified as none", () => {
  assert.equal(classifyOpenError(undefined).kind, "none");
  assert.equal(classifyOpenError(null).kind, "none");
  assert.equal(classifyOpenError("").kind, "none");
});

test("the backend 'file does not exist' message is a missing file", () => {
  // src-tauri/src/lib.rs: open_log_file → "文件不存在: {path}"
  const info = classifyOpenError("文件不存在: D:\\logs\\game_inst21.log");
  assert.equal(info.kind, "missing");
  assert.equal(info.subject, "file");
  assert.equal(info.raw, "文件不存在: D:\\logs\\game_inst21.log");
  // 原始文本要原样保留（状态页的「技术细节」里展示）
  assert.ok(info.raw.includes("D:\\logs\\game_inst21.log"));
});

test("a missing schema is missing, but NOT a missing file", () => {
  // client_cfg.rs → "schema 文件不存在: {slots_path}"
  const info = classifyOpenError("schema 文件不存在: C:\\app\\schemas\\cfg_table_slots.json");
  assert.equal(info.kind, "missing");
  assert.equal(
    info.subject,
    "schema",
    "缺 schema 与缺文件本体必须区分：前者要在表格视图里重选 schema"
  );
});

test("permission failures are classified as denied", () => {
  assert.equal(classifyOpenError("读取失败: 拒绝访问。 (os error 5)").kind, "denied");
  assert.equal(classifyOpenError("Permission denied (os error 13)").kind, "denied");
  assert.equal(classifyOpenError("Access is denied.").kind, "denied");
});

test("English / OS-level not-found wording also counts as missing", () => {
  assert.equal(classifyOpenError("No such file or directory (os error 2)").kind, "missing");
  assert.equal(classifyOpenError("The system cannot find the file specified. (os error 2)").kind, "missing");
  assert.equal(classifyOpenError("系统找不到指定的文件。").kind, "missing");
});

test("'tab 不存在' is NOT a missing file", () => {
  // lib.rs 里会话不存在也用了「不存在」二字：裸匹配「不存在」会把会话错误
  // 误判成文件缺失，进而弹出一张带有路径的错误页。
  const info = classifyOpenError("tab 不存在: tab-3");
  assert.equal(info.kind, "other");
  assert.equal(info.subject, undefined);
});

test("client_cfg parse errors stay 'other' (they must keep the table view's own panel)", () => {
  // 这些错误都不代表文件缺失，绝不能命中「文件不存在」页面。
  const samples = [
    "表 'pic_guide_data' 未在 C:\\x\\cfg_table_slots.json 中找到",
    "解析 pic_guide_data 失败: stringTableLen 非法: 999",
    "文件太小，不是合法的 client_cfg bin",
    "不支持的类型: 'Dictionary<int, string>'",
    "表 'pic_guide_data' 在 schema 中无字段定义",
  ];
  for (const s of samples) {
    assert.equal(classifyOpenError(s).kind, "other", `should be other: ${s}`);
  }
});

// ==================== 2. 注册表语义 ====================

/** 造一条只关心 id 的页面定义。 */
const def = (id, priority, match, fallback = false) => ({
  id,
  priority,
  fallback,
  title: () => id,
  match,
  render: () => null,
});

test("the registry resolves the highest-priority matching view", () => {
  const reg = new BodyViewRegistry([
    def("low", 1, () => true),
    def("high", 50, (ctx) => ctx.tag === "a"),
    def("fallback-view", -10, () => false, true),
  ]);
  assert.equal(reg.resolve({ tag: "a" }).id, "high");
  assert.equal(reg.resolve({ tag: "b" }).id, "low");
});

test("the registry falls back when nothing matches", () => {
  const reg = new BodyViewRegistry([def("only", 5, () => false, true)]);
  assert.equal(reg.resolve({}).id, "only");
});

test("definitions are exposed in descending priority order", () => {
  const reg = new BodyViewRegistry([
    def("b", 10, () => false),
    def("c", 30, () => false),
    def("a", 20, () => false, true),
  ]);
  assert.deepEqual(
    reg.definitions.map((d) => d.id),
    ["c", "a", "b"]
  );
  assert.equal(reg.find("b")?.priority, 10);
  assert.equal(reg.find("nope"), undefined);
});

test("configuration mistakes fail at construction time", () => {
  assert.throws(
    () => new BodyViewRegistry([def("dup", 1, () => false), def("dup", 2, () => false)]),
    /id 重复/
  );
  assert.throws(
    () => new BodyViewRegistry([def("a", 1, () => false)]),
    /fallback/,
    "缺少兜底页面必须在注册时就报错，而不是渲染时白屏"
  );
  assert.throws(
    () =>
      new BodyViewRegistry([
        def("a", 1, () => false, true),
        def("b", 2, () => false, true),
      ]),
    /fallback/
  );
});

// ==================== 3. 应用真实页面表 ====================

test("the app view table declares exactly one fallback and unique ids", () => {
  const reg = new BodyViewRegistry(
    APP_BODY_VIEWS.map((spec) =>
      def(spec.id, spec.priority, spec.match, spec.fallback)
    )
  );
  assert.deepEqual(
    reg.definitions.map((d) => d.id),
    ["file-missing", "cfg-table", "open-error", "text-log"]
  );
});

test("a healthy tab resolves to the text view", () => {
  assert.equal(resolveAppBodyViewId(state(ok)), "text-log");
  assert.equal(resolveAppBodyViewId(state(ok, "text")), "text-log");
  assert.equal(resolveAppBodyViewId(state(ok, "cfg")), "cfg-table");
});

test("a missing file wins over every content view", () => {
  const missing = classifyOpenError("文件不存在: D:\\logs\\a.log");
  assert.equal(resolveAppBodyViewId(state(missing, "text")), "file-missing");
  // 表格视图下 bin 丢了：同样是「文件不存在」页面（表格视图拿不到数据）
  assert.equal(resolveAppBodyViewId(state(missing, "cfg")), "file-missing");
});

test("a missing schema keeps the table view (so the schema can be re-picked)", () => {
  const missingSchema = classifyOpenError("schema 文件不存在: C:\\app\\slots.json");
  assert.equal(
    resolveAppBodyViewId(state(missingSchema, "cfg")),
    "cfg-table",
    "缺 schema 应由表格视图的错误面板处理（那里有「选择 schema…」）"
  );
});

test("parse failures keep the table view, other open failures get the generic page", () => {
  const parseErr = classifyOpenError("解析 pic_guide_data 失败: 数据类型不匹配");
  assert.equal(resolveAppBodyViewId(state(parseErr, "cfg")), "cfg-table");
  assert.equal(resolveAppBodyViewId(state(parseErr, "text")), "open-error");

  const denied = classifyOpenError("读取失败: 拒绝访问。 (os error 5)");
  assert.equal(resolveAppBodyViewId(state(denied, "text")), "open-error");
});
