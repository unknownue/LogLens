/**
 * 字符串搜索匹配器（关键词子串 / 区分大小写 / 全字匹配）—— 纯逻辑，无 React、无 DOM。
 *
 * 为什么单独成一个模块：这套语义**三处共用**，而且必须完全一致，否则同一个词在不同
 * 视图里命中的东西不一样：
 * - 文本视图的高亮（`App.tsx` 的行渲染，只为了把命中片段标出来）；
 * - 表格视图的页内查找（`src/views/csv-search.ts`，判断单元格是否命中）；
 * - 无浏览器的交叉验证脚本 `tools/verify-search-frontend.mjs`（直接 import 本模块，
 *   而不是自己抄一份实现 —— 抄出来的副本一旦与真实现漂移，测试就变成了自我安慰）。
 *
 * 与后端（`src-tauri/src/search.rs`）的口径一致：
 * - **大小写不敏感时按 ASCII 折叠**（JS 的 `toLowerCase`），不做 Unicode 大小写折叠
 *   （土耳其语 İ / ß 之类不参与，与后端 `to_ascii_lowercase` 的行为对齐）；
 * - **允许重叠命中**（`aaaa` 里搜 `aa` 是 3 处，不是 2 处）；
 * - 全字边界用 Unicode 属性判断（见 {@link isWordChar}）。
 */

/** 搜索匹配器：字符串匹配（非正则），支持大小写敏感与全字匹配。 */
export interface SearchMatcher {
  term: string;
  caseSensitive: boolean;
  wholeWord: boolean;
}

/**
 * 全字匹配的边界判断：命中片段两侧不能紧邻「词字符」。
 *
 * 用 Unicode 属性（`\p{L}\p{N}_`）而不是 ASCII 判断，中文/日文等非 ASCII 文本
 * 才能得到正确边界（否则「错误err」里的 err 也会被判成独立单词）。
 */
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;

/** 该字符算不算「词字符」（空串不算 —— 边界处取不到字符就是边界）。 */
export function isWordChar(ch: string): boolean {
  return ch.length > 0 && WORD_CHAR_RE.test(ch);
}

/**
 * 在文本里找出搜索词的所有命中位置（返回 `[start, end)` 的 UTF-16 下标）。
 * 空搜索词返回空数组（「没输入」不等于「命中一切」）。
 */
export function findSpans(text: string, m: SearchMatcher): [number, number][] {
  if (!m.term) {
    return [];
  }
  const needle = m.caseSensitive ? m.term : m.term.toLowerCase();
  const hay = m.caseSensitive ? text : text.toLowerCase();
  const spans: [number, number][] = [];
  let i = 0;
  while (i <= hay.length - needle.length) {
    const at = hay.indexOf(needle, i);
    if (at < 0) {
      break;
    }
    const end = at + needle.length;
    if (!m.wholeWord || (!isWordChar(text.charAt(at - 1)) && !isWordChar(text.charAt(end)))) {
      spans.push([at, end]);
    }
    i = at + 1; // 允许重叠命中（aaaa 里搜 aa）
  }
  return spans;
}

/**
 * 文本里有没有命中（表格视图只关心「这个单元格命中了没有」，不需要片段位置）。
 *
 * 比 `findSpans(...).length > 0` 快一档：命中即返回，不必扫完整段文本 ——
 * 表格一次要扫几十万个单元格，这个差别是可感知的。
 */
export function matchesTerm(text: string, m: SearchMatcher): boolean {
  if (!m.term) {
    return false;
  }
  const needle = m.caseSensitive ? m.term : m.term.toLowerCase();
  if (needle.length === 0 || text.length < needle.length) {
    return false;
  }
  const hay = m.caseSensitive ? text : text.toLowerCase();
  if (!m.wholeWord) {
    return hay.includes(needle);
  }
  let i = 0;
  while (i <= hay.length - needle.length) {
    const at = hay.indexOf(needle, i);
    if (at < 0) {
      return false;
    }
    const end = at + needle.length;
    if (!isWordChar(text.charAt(at - 1)) && !isWordChar(text.charAt(end))) {
      return true;
    }
    i = at + 1;
  }
  return false;
}
