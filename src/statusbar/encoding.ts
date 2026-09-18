/**
 * 编码模块的纯逻辑部分（不依赖 React / DOM，可在 Node 中单测）。
 *
 * 状态栏与编码弹窗共用的东西都在这里：
 * - 后端 IPC 载荷的类型（与 `src-tauri/src/encoding.rs` 的 serde 形状一一对应）；
 * - 「编码名怎么显示」「探测依据怎么说」这两件纯排版决策；
 * - 弹窗列表的分组与预览文本的裁剪。
 *
 * 目录表（有哪些编码可选）**不在这里**：唯一事实来源在后端（解码必须按它来），
 * 前端通过 `list_encodings` 命令取。前端再抄一份就会有第二处要同步 ——
 * 后端加了编码而前端忘了改，用户就在下拉里看不到它。
 */

/** 「自动探测」的哨兵 id（与后端 `encoding::AUTO` 一致）。 */
export const AUTO_ID = "auto";

/** 编码是通过什么定下来的（与后端 `encoding::Source` 一致）。 */
export type EncodingSource = "bom" | "utf8" | "fallback" | "manual";

/**
 * 当前生效的编码信息（`open_log_file` / `set_encoding` / `detect_encoding`
 * 的返回值，与 Rust `EncodingInfo` 对应）。
 */
export interface EncodingInfo {
  /** 用户的**选择**：`auto` 或某个目录 id。 */
  choice: string;
  /** 实际生效的目录 id。 */
  id: string;
  /** 展示名（`UTF-8` / `GB18030`，技术名词不本地化）。 */
  name: string;
  /** 别名补充（`GBK / GB2312`），可能为空串。 */
  note: string;
  /** 分组键：`unicode` / `chinese` / `japanese` / `korean` / `western`。 */
  group: string;
  /** 探测依据。 */
  source: string;
  /** 文件是否带 BOM。 */
  bom: boolean;
}

/** 目录项（`list_encodings` 的返回元素，与 Rust `EncodingOption` 对应）。 */
export interface EncodingOption {
  id: string;
  name: string;
  note: string;
  group: string;
}

/** 分组键 → 界面上的显示顺序（后端目录也按这个顺序排列）。 */
export const GROUP_ORDER: readonly string[] = [
  "unicode",
  "chinese",
  "japanese",
  "korean",
  "western",
];

/** 一组备选编码。 */
export interface EncodingGroup {
  /** 分组键。 */
  group: string;
  /** 该组的编码（保持后端目录顺序）。 */
  items: EncodingOption[];
}

/**
 * 把目录按分组切开（保持上传顺序与组内顺序）。
 *
 * 未知分组键不会被丢掉：归到最后一组「其它」，而不是静默消失 —— 后端新增分组
 * 而前端还没加文案时，用户至少还能看到并选中那些编码。
 */
export function groupOptions(options: readonly EncodingOption[]): EncodingGroup[] {
  const known = new Set(GROUP_ORDER);
  const out: EncodingGroup[] = [];
  const index = new Map<string, EncodingGroup>();
  for (const opt of options) {
    const key = known.has(opt.group) ? opt.group : "other";
    let bucket = index.get(key);
    if (!bucket) {
      bucket = { group: key, items: [] };
      index.set(key, bucket);
      out.push(bucket);
    }
    bucket.items.push(opt);
  }
  // 按 GROUP_ORDER 排序（"other" 永远在最后）。
  const rank = (g: string) => {
    const i = GROUP_ORDER.indexOf(g);
    return i < 0 ? GROUP_ORDER.length : i;
  };
  return out.sort((a, b) => rank(a.group) - rank(b.group));
}

/**
 * 状态栏/弹窗上显示的编码名。
 *
 * 带 BOM 时加 ` BOM` 后缀：同一个 `UTF-8` 有没有 BOM 对「首行为什么看不见标题」
 * 这类问题是有意义的线索，而它只有一个单词的位置成本。
 */
export function encodingLabel(info: EncodingInfo | null | undefined): string {
  if (!info) {
    return "";
  }
  return info.bom ? `${info.name} BOM` : info.name;
}

/**
 * 提示语里的编码名（含别名，如 `GBK` 的 `ANSI 936`）。
 * 别名只在弹窗与悬浮提示里出现，状态栏保持短。
 */
export function encodingFullLabel(info: EncodingInfo | null | undefined): string {
  if (!info) {
    return "";
  }
  const base = encodingLabel(info);
  return info.note ? `${base} · ${info.note}` : base;
}

/**
 * 该编码选项在列表里的完整名字（含别名）。
 * 选中态与列表项共用，避免「列表写 GBK、选中后状态栏写 ANSI 936」这种不一致。
 */
export function optionLabel(opt: Pick<EncodingOption, "name" | "note">): string {
  return opt.note ? `${opt.name} · ${opt.note}` : opt.name;
}

/**
 * 剥掉文本开头的 BOM。
 *
 * 预览走的是 `read_text_file`（后端已按所选编码剥过 BOM），这里再兜一次是因为
 * **自动探测**选到的编码可能与文件真实 BOM 不一致（用户手动选了别的编码），
 * 此时首行会留一个 U+FEFF 零宽字符 —— 预览里看着像多了个空格，很费解。
 */
export function stripBom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

/**
 * 取预览用的前 `max` 行。
 *
 * `dropTailArtifact`：文本是否来自一次**被字节上限截断**的读取。截断点可能落在
 * 多字节字符中间，表现为结尾一个 U+FFFD；那是读取方式的产物，不是文件的乱码，
 * 留在预览里会让人误以为当前编码选错了。只有调用方确知读被截断时才裁
 * （`read_text_file` 返回的 `truncated`），否则不改动内容 —— 短文件里真实的
 * 替换字符是判断编码对错的依据，不能被悄悄抹掉。
 */
export function previewLines(text: string, max = 14, dropTailArtifact = false): string[] {
  const cleaned = stripBom(text);
  // 空文件 → 0 行（而不是 [""]）：弹窗据此显示「（文件为空）」，
  // 而 [""] 会渲染出一片空白，看起来像「读取失败」。
  if (cleaned === "") {
    return [];
  }
  const all = cleaned.split(/\r\n|\r|\n/);
  // 以换行结尾时 split 会多出一个空串，属于正常。
  const lines = all.length > 1 && all[all.length - 1] === "" ? all.slice(0, -1) : all;
  const head = lines.slice(0, max);
  if (dropTailArtifact && head.length === lines.length && head.length > 0) {
    head[head.length - 1] = head[head.length - 1].replace(/\uFFFD+$/, "");
  }
  return head;
}

/** 探测依据对应的文案键（由界面层的文案表翻译）。 */
export function sourceKey(info: EncodingInfo | null | undefined): EncodingSource | null {
  if (!info) {
    return null;
  }
  const s = info.source;
  if (s === "bom" || s === "utf8" || s === "fallback" || s === "manual") {
    return s;
  }
  return null;
}

/**
 * 预览结果是否「看起来像乱码」——只看替换字符（U+FFFD）的密度。
 *
 * 用途仅仅是给预览加一句提醒（「这个编码下有不少无法解码的字节」），
 * 不做任何自动决策：编码该不该换由用户看着预览自己决定，猜错编码比不猜更糟。
 *
 * 两个门槛缺一不可：**至少 4 个**替换字符，且占比 ≥ 5%。
 * 只要一个就会误报 —— 字节上限截断恰好切在字符中间时就会产生一个 U+FFFD，
 * 那不是编码错，是读取方式的必然。
 */
export function looksGarbled(text: string): boolean {
  if (!text) {
    return false;
  }
  let bad = 0;
  let chars = 0;
  for (const ch of text) {
    chars += 1;
    if (ch === "\uFFFD") {
      bad += 1;
    }
  }
  return bad >= 4 && bad * 20 >= chars;
}
