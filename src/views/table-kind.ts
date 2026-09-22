/**
 * 「表格视图」的两种解析后端 —— 按文件扩展名分工的纯规则。
 *
 * 界面上只有一个「表格视图」入口（视图模式弹窗里的那一项），但底下是两份互不相干
 * 的解析器，选择依据只有文件扩展名：
 *
 * | 扩展名            | 后端            | 说明                                   |
 * |-------------------|-----------------|----------------------------------------|
 * | `.bin`            | `cfg`（二进制）   | GM10 client_cfg（MemoryPack），要 schema |
 * | 其余（csv/tsv/…） | `csv`（文本）     | 逗号 / 制表符分隔的文本表，不要 schema   |
 *
 * 为什么把 `.bin` 单独分出来而不是「统一按 CSV 试」：bin 是二进制，按文本解析只会
 * 得到一屏乱码；反过来，CSV 是文本，要求用户先选 schema 才能看表格则毫无道理。
 *
 * 为什么放在 `views/` 而不是 App：这条规则同时被三处使用 —— 正文页面注册表
 * （`app-body-views.ts` 决定显示哪个页面）、App 的解析分发、表格页自己的工具栏文案；
 * 放在这里可以让它保持纯函数、可被 `node --test` 直接覆盖（见 tools/verify-csv.test.mjs）。
 */

/** 表格视图的后端类型。 */
export type TableKind = "cfg" | "csv";

/** 扩展名（小写、不含点；无扩展名返回空串）。与 `markdown/paths.ts` 同口径。 */
export function extensionOf(path: string): string {
  const base = path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * 该文件该用哪个表格后端。
 *
 * 只有 `.bin` 走配置表（二进制 + schema）；其余一律按文本表格解析 —— 包括
 * `.txt` / `.log` 这类用户手动切进表格视图的文件：它们本来就不是配置表，而
 * 「按分隔符看看是不是表格」正是用户点这个入口时想要的。
 */
export function tableKindOf(path: string): TableKind {
  return extensionOf(path) === "bin" ? "cfg" : "csv";
}

/**
 * 是否是**默认**就该按表格视图打开的文本表格（`.csv` / `.tsv`）。
 *
 * 与 [`tableKindOf`] 的区别：那个回答「这个文件用哪个解析后端」（任何文件都有答案，
 * `.txt` 也算 csv 后端），这个只回答「打开它时该不该自动进表格视图」——
 * `.txt` / `.log` 仍然先进文本视图，否则打开一个普通日志就会先去解析一遍表格。
 */
export function isTablePath(path: string): boolean {
  const ext = extensionOf(path);
  return ext === "csv" || ext === "tsv";
}

/** 一个可选分隔符。 */
export interface DelimiterOption {
  /** 稳定的 id（DOM 里的 option value；首字符是控制字符，不适合直接写进属性）。 */
  id: "comma" | "tab" | "semicolon" | "pipe";
  /** 实际字符（传给后端的那个）。 */
  char: string;
  /** 展示名（中 / 英）。 */
  label: { zh: string; en: string };
}

/**
 * 工具栏里可选的分隔符（顺序即展示顺序）。
 *
 * 前端只提供这几个：真实世界的 CSV / TSV 基本落在这四种里（Excel 导出、PowerShell
 * `Export-Csv`、日志里的分号分隔）。后端不限制死集合（接受任意单字符），这样以后
 * 想加一个「空格分隔」不必动 Rust。
 */
export const DELIMITERS: readonly DelimiterOption[] = [
  { id: "comma", char: ",", label: { zh: "逗号 ,", en: "Comma ," } },
  { id: "tab", char: "\t", label: { zh: "制表符", en: "Tab" } },
  { id: "semicolon", char: ";", label: { zh: "分号 ;", en: "Semicolon ;" } },
  { id: "pipe", char: "|", label: { zh: "竖线 |", en: "Pipe |" } },
];

/** 按扩展名推断分隔符：`.tsv` 用制表符，其余用逗号。 */
export function defaultDelimiterFor(path: string): string {
  return extensionOf(path) === "tsv" ? "\t" : ",";
}

/** 该字符是否是我们提供的选项之一（存档里读到别的字符时按默认处理）。 */
export function isKnownDelimiter(char: string): boolean {
  return DELIMITERS.some((d) => d.char === char);
}

/**
 * 归一化一个分隔符取值：只认选项里的四个字符，其余（空串 / 未知字符 / 存档里的
 * `"\\t"` 转义写法）一律回退到按扩展名推断的默认值。
 *
 * 为什么回退而不是报错：分隔符存在会话存档里，一个被改坏的存档不该让文件打不开
 * —— 与 `encoding::resolve` 对未知编码 id 的处理口径一致。
 */
export function normalizeDelimiter(value: string | null | undefined, path: string): string {
  if (value === "\\t" || value === "tab") {
    return "\t";
  }
  return value && isKnownDelimiter(value) ? value : defaultDelimiterFor(path);
}

/** 分隔符的展示名（未知字符按原样显示）。 */
export function delimiterLabel(char: string, lang: "zh" | "en"): string {
  const opt = DELIMITERS.find((d) => d.char === char);
  return opt ? opt.label[lang] : char;
}

/**
 * 会话存档里记的视图模式，是不是「当年的默认值」而不是用户的选择。
 *
 * 为什么需要这条判断：存档里的 `modes` 是**记录**（每个 tab 当时恰好处于哪个模式），
 * 不是**用户意图**。0.5.0 及更早的版本里表格视图只服务 `.bin`，`.csv` 打开就是文本
 * 视图 —— 那时存下来的 `"text"` 记的是默认值，不是用户挑的。升级后若照抄，老会话里的
 * `.csv` 会永远停在文本视图，正好与「CSV 默认表格」相反。
 *
 * 判据有两半，缺一不可：
 * - `archiveVersion == null`：存档是老版本写的（新版本会写 `version` 字段）；
 * - `savedMode === "text"` 且路径是 `.csv` / `.tsv`：老版本里它只可能是「默认文本」。
 *   用户当年真选过别的视图（如 `md`）时不在此列，照旧尊重。
 *
 * 返回 `true` → 调用方按扩展名重新推断（见 App.tsx 的恢复流程）。
 */
export function isStaleDefaultMode(
  savedMode: string | null | undefined,
  path: string,
  archiveVersion: number | undefined
): boolean {
  return archiveVersion == null && savedMode === "text" && isTablePath(path);
}
