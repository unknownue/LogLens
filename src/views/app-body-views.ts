/**
 * LogLens 的正文页面清单 —— **只有「谁在什么状态下显示」的纯规则**。
 *
 * 各页面的渲染实现留在 App.tsx（那里才拿得到 props 组装与 App 侧回调）；
 * 拆出来的原因是这套「优先级 + 命中」规则是整个多页面框架的核心，必须能被
 * 单测直接覆盖（`tools/verify-body-views.test.mjs`），而不是只能靠手点界面验证：
 * 加一个页面时最容易犯的错就是把优先级插错位置（例如让通用错误页盖住了表格视图
 * 自带的错误面板），而那种错误在肉眼验收里很容易漏掉。
 *
 * 框架本身（注册表 / 宿主 / 状态页外壳）见 `body-view.ts`；
 * 新增页面的步骤见 docs/body-views.md。
 */

// 显式带 .ts 后缀：本模块（连同 body-view.ts）要能被 Node 的单测直接 import，
// 见 tools/verify-body-views.test.mjs 与 tsconfig 的 allowImportingTsExtensions。
import { BodyViewRegistry, type OpenErrorInfo } from "./body-view.ts";

/** tab 的视图模式（`undefined` 视为 `text`）。 */
export type ViewMode = "text" | "cfg" | "md";

/** 解析「该显示哪个页面」所需的 tab 状态子集（与 App 的 TabInfo 结构兼容）。 */
export interface BodyViewState {
  /** 该 tab 的视图模式（undefined 视为 `text`）。 */
  viewMode?: ViewMode;
  /** 打开/解析失败信息的分类结果（`kind === "none"` = 正常）。 */
  error: OpenErrorInfo;
}

/** 应用内置的正文页面 id（与 App.tsx 的渲染实现表一一对应）。 */
export type AppBodyViewId = "file-missing" | "md-view" | "cfg-table" | "open-error" | "text-log";

/** 一条页面规则。 */
export interface AppBodyViewSpec {
  /** 页面 id。 */
  id: AppBodyViewId;
  /** 优先级：数值大者优先。 */
  priority: number;
  /** 兜底页面（有且仅有一个）。 */
  fallback?: boolean;
  /** 命中判定。 */
  match: (state: BodyViewState) => boolean;
}

/**
 * 正文页面清单（优先级从高到低）：
 *
 * 1. `file-missing` —— 文件不存在（定制页）。优先级最高：内容根本加载不出来，
 *    先给出解释与修复入口；表格视图下 bin 丢了也走这里。
 * 2. `md-view` —— Markdown 预览。排在通用错误页之前：它自带「读取失败 + 重试」面板
 *    （文件被外部改动、编解码失败都要能在原地重读，而不是被换成一行通用报错）。
 * 3. `cfg-table` —— 表格视图。它自带错误面板（解析失败 / 缺 schema 时能重选
 *    schema），同样排在通用错误页之前；「文件本体不存在」已被 1 号页面接走。
 * 4. `open-error` —— 其它打开失败（权限、IO、格式…）的通用状态页。没它的话任何
 *    未预料的失败都会退化成「空白正文 + 一句错误文本」。
 * 5. `text-log` —— 文本日志视图（fallback：没被上面命中的 tab 都按日志文本显示）。
 *
 * `md-view` 与 `cfg-table` 由 viewMode 决定、互斥，优先级只影响「谁先被检查」；
 * 两者都必须高于 `open-error`，否则它们各自的错误面板永远没机会出现。
 */
export const APP_BODY_VIEWS: readonly AppBodyViewSpec[] = [
  {
    id: "file-missing",
    priority: 100,
    // subject === "schema" 时缺的是 schema 文件、而不是 tab 绑定的文件本体：
    // 那种情况该在表格视图里重选 schema，不能拿本页面顶替（否则会把**存在**的
    // bin 路径当成缺失文件展示，且「重新定位」还会再次指向 bin）。
    match: (state) => state.error.kind === "missing" && state.error.subject !== "schema",
  },
  {
    id: "md-view",
    priority: 40,
    match: (state) => (state.viewMode ?? "text") === "md",
  },
  {
    id: "cfg-table",
    priority: 30,
    match: (state) => (state.viewMode ?? "text") === "cfg",
  },
  {
    id: "open-error",
    priority: 20,
    match: (state) => state.error.kind === "denied" || state.error.kind === "other",
  },
  {
    id: "text-log",
    priority: 0,
    fallback: true,
    match: () => true,
  },
];

/** 同一套规则的注册表实例（只为复用 resolve 的优先级/兜底语义，不渲染任何东西）。 */
const specRegistry = new BodyViewRegistry<BodyViewState>(
  APP_BODY_VIEWS.map((spec) => ({
    id: spec.id,
    priority: spec.priority,
    fallback: spec.fallback,
    title: () => spec.id,
    match: spec.match,
    render: () => null,
  }))
);

/** 纯函数版解析：给定 tab 状态，返回应显示的页面 id（与运行时注册表同源同规则）。 */
export function resolveAppBodyViewId(state: BodyViewState): AppBodyViewId {
  return specRegistry.resolve(state).id as AppBodyViewId;
}
