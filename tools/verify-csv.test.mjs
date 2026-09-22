// verify-csv.test.mjs — CSV 表格（表格视图的文本后端）纯规则单测。
//
// 这些规则决定了「csv 文件打开时看到什么」，而且都是最容易在改动中悄悄出错的地方：
//   * 哪些文件默认进表格视图 / 用哪个解析后端（table-kind.ts）；
//   * 行矩阵 → 表头 + 数据行的切分（含「首行为表头」开关、空列名、参差行的补齐）；
//   * 单元格里的制表符 / 换行怎么显示（固定行高的表格里必须单行显示）；
//   * 复制成 TSV 时怎么处理这两类字符；
//   * 列宽估算是否跟随字号、是否被上下限夹住。
//
// 运行：
//   node --test tools/verify-csv.test.mjs
// （Node ≥ 23 直接剥掉 TS 类型，不需要构建或测试框架；Rust 侧的解析器另有一套
//   `cargo test --lib csv_table`。）

import test from "node:test";
import assert from "node:assert/strict";

import {
  DELIMITERS,
  defaultDelimiterFor,
  delimiterLabel,
  extensionOf,
  isStaleDefaultMode,
  isTablePath,
  normalizeDelimiter,
  tableKindOf,
} from "../src/views/table-kind.ts";
import {
  WIDTH_SAMPLE_ROWS,
  computeCsvColumnWidths,
  csvBodyCell,
  csvBodyRows,
  csvCellText,
  csvDataRowCount,
  csvHeaderCells,
  csvToTsv,
  formatBytes,
} from "../src/views/csv-model.ts";
import { CSV_FIND_CAP, findCsvHits, groupHitsByRow } from "../src/views/csv-search.ts";

/** 造一份解析结果（默认两列三行，首行是表头）。 */
const table = (rows, extra = {}) => ({
  rows,
  width: Math.max(...rows.map((r) => r.length), 0),
  delimiter: ",",
  truncated: false,
  max_rows: 200000,
  bytes: 1024,
  ...extra,
});

// ==================== 1. 表种 / 分隔符规则 ====================

test("only .bin uses the config-table backend; everything else is CSV text", () => {
  assert.equal(tableKindOf("D:\\cfg\\pic_guide_data.bin"), "cfg");
  assert.equal(tableKindOf("D:\\cfg\\PIC_GUIDE_DATA.BIN"), "cfg", "扩展名大小写不敏感");
  assert.equal(tableKindOf("D:\\logs\\items.csv"), "csv");
  assert.equal(tableKindOf("D:\\logs\\items.tsv"), "csv");
  // 手切进表格视图的 .txt / .log：按分隔符解析才有意义（要求先选 schema 才荒唐）
  assert.equal(tableKindOf("D:\\logs\\a.log"), "csv");
  assert.equal(tableKindOf("no-extension"), "csv");
});

test("only .csv / .tsv open in the table view by default", () => {
  assert.equal(isTablePath("D:\\logs\\items.csv"), true);
  assert.equal(isTablePath("D:\\logs\\items.tsv"), true);
  assert.equal(isTablePath("D:\\logs\\a.log"), false, "普通日志仍从文本视图起步");
  assert.equal(isTablePath("D:\\logs\\a.txt"), false);
  assert.equal(isTablePath("D:\\logs\\a.md"), false);
  assert.equal(isTablePath("D:\\logs\\a.bin"), false, "配置表仍要手动切（依赖 schema）");
});

test("extensionOf handles Windows paths and dotfiles", () => {
  assert.equal(extensionOf("D:\\a\\b.CSV"), "csv");
  assert.equal(extensionOf("D:/a/b.tsv"), "tsv");
  assert.equal(extensionOf("D:\\a\\noext"), "");
  assert.equal(extensionOf(".csv"), "", "纯隐藏文件名不算扩展名");
});

test("the default delimiter follows the extension: .tsv is a tab", () => {
  assert.equal(defaultDelimiterFor("a.csv"), ",");
  assert.equal(defaultDelimiterFor("a.tsv"), "\t");
  assert.equal(defaultDelimiterFor("a.txt"), ",");
});

test("delimiter values are normalized: aliases accepted, junk falls back to the default", () => {
  assert.equal(normalizeDelimiter(";", "a.csv"), ";");
  assert.equal(normalizeDelimiter("\t", "a.csv"), "\t");
  // 存档里的转义写法（"\t" 是两个字符）也要认得
  assert.equal(normalizeDelimiter("\\t", "a.csv"), "\t");
  assert.equal(normalizeDelimiter("tab", "a.csv"), "\t");
  // 空 / 未知字符 / 缺省 → 按扩展名推断
  assert.equal(normalizeDelimiter(null, "a.csv"), ",");
  assert.equal(normalizeDelimiter(undefined, "a.tsv"), "\t");
  assert.equal(normalizeDelimiter(" ", "a.csv"), ",", "不在选项里的字符回退到默认，不报错");
});

test("每档分隔符都有中英文案，且 delimiterLabel 认得全部选项", () => {
  assert.ok(DELIMITERS.length >= 4);
  for (const d of DELIMITERS) {
    assert.equal(d.char.length, 1, `${d.id} 必须是单个字符`);
    assert.ok(d.label.zh && d.label.en, `${d.id} 缺文案`);
    assert.equal(delimiterLabel(d.char, "zh"), d.label.zh);
    assert.equal(delimiterLabel(d.char, "en"), d.label.en);
  }
});

// ==================== 1b. 会话存档的模式迁移 ====================

test("老存档里 CSV 的 text 是当年的默认值，不是用户选择 → 按新默认重新推断", () => {
  // 0.5.0 没有 version 字段，且那时 CSV 只能记成 text。
  assert.equal(isStaleDefaultMode("text", "D:\\logs\\items.csv", undefined), true);
  assert.equal(isStaleDefaultMode("text", "D:\\logs\\items.tsv", undefined), true);
});

test("新存档里的 text 是用户选择 → 必须尊重", () => {
  assert.equal(isStaleDefaultMode("text", "D:\\logs\\items.csv", 2), false);
});

test("迁移只针对 CSV/TSV 的 text（别的模式与别的前缀都不动）", () => {
  // 老存档里 CSV 记的是别的视图：说明用户当年手动切过，照旧尊重。
  assert.equal(isStaleDefaultMode("md", "D:\\logs\\items.csv", undefined), false);
  // 非 .csv/.tsv：老存档里的 text 就是正常的文本视图记录。
  assert.equal(isStaleDefaultMode("text", "D:\\logs\\a.log", undefined), false);
  assert.equal(isStaleDefaultMode("text", "D:\\cfg\\a.bin", undefined), false);
  assert.equal(isStaleDefaultMode(null, "D:\\logs\\items.csv", undefined), false);
  assert.equal(isStaleDefaultMode(undefined, "D:\\logs\\items.csv", undefined), false);
});

// ==================== 2. 表头 / 数据行的切分 ====================

test("the first row becomes the header, the rest are data", () => {
  const t = table([
    ["name", "qty"],
    ["apple", "3"],
    ["pear", "5"],
  ]);
  assert.deepEqual(csvHeaderCells(t, true, "zh"), ["name", "qty"]);
  assert.deepEqual(csvBodyRows(t, true), [["apple", "3"], ["pear", "5"]]);
  assert.equal(csvDataRowCount(t, true), 2);
});

test("with the header switch off, the first row is data and names are generated", () => {
  const t = table([
    ["2024-01-01", "3"],
    ["2024-01-02", "5"],
  ]);
  assert.deepEqual(csvHeaderCells(t, false, "zh"), ["列1", "列2"]);
  assert.deepEqual(csvHeaderCells(t, false, "en"), ["Col1", "Col2"]);
  assert.deepEqual(csvBodyRows(t, false), [
    ["2024-01-01", "3"],
    ["2024-01-02", "5"],
  ]);
  assert.equal(csvDataRowCount(t, false), 2);
});

test("empty header cells get a generated name (EXCEL 导出常有缺列名)", () => {
  const t = table([
    ["name", "", "  "],
    ["a", "b", "c"],
  ]);
  assert.deepEqual(csvHeaderCells(t, true, "zh"), ["name", "列2", "列3"]);
});

test("columns cover the widest row, even when the header is shorter", () => {
  // 表头 2 列、数据 3 列：多出来的那一列必须照样画出来，否则数据静默消失。
  const t = table([
    ["a", "b"],
    ["1", "2", "3"],
  ]);
  assert.equal(t.width, 3);
  assert.deepEqual(csvHeaderCells(t, true, "zh"), ["a", "b", "列3"]);
  assert.equal(csvHeaderCells(t, true, "zh").length, 3);
});

test("an empty file yields no header and no rows", () => {
  const t = table([]);
  assert.deepEqual(csvHeaderCells(t, true, "zh"), []);
  assert.deepEqual(csvBodyRows(t, true), []);
  assert.equal(csvDataRowCount(t, true), 0);
  assert.deepEqual(csvHeaderCells(t, false, "zh"), []);
});

// ==================== 3. 单元格显示 ====================

test("a cell never renders a raw newline (fixed row height), but says so", () => {
  assert.equal(csvCellText("line1\nline2"), "line1␊line2");
  assert.equal(csvCellText("a\r\nb"), "a␊b", "CRLF 也是一个记号");
  assert.equal(csvCellText("a\rb"), "a␊b");
  assert.equal(csvCellText("a\tb"), "a⇥b", "制表符同样可见（换分隔符后可能出现）");
  assert.equal(csvCellText(""), "");
  assert.equal(csvCellText(undefined), "", "参差行取不到的单元格是空串");
});

test("body cells tolerate short rows", () => {
  assert.equal(csvBodyCell(["a"], 0), "a");
  assert.equal(csvBodyCell(["a"], 2), "", "行比列短 → 空单元格，不是越界");
  assert.equal(csvBodyCell(undefined, 0), "");
});

// ==================== 4. 复制为 TSV ====================

test("copy emits a TSV block with the header and every data row", () => {
  const t = table([
    ["name", "qty"],
    ["apple", "3"],
    ["pear", "5"],
  ]);
  assert.equal(csvToTsv(t, true, "zh"), "name\tqty\r\napple\t3\r\npear\t5");
});

test("copy replaces tabs/newlines so one cell stays one cell when pasted", () => {
  const t = table([
    ["a", "b"],
    ["x\ty", "line1\nline2"],
  ]);
  // 原样拼进去的话，粘到 Excel 里会变成「两行四列」。
  assert.equal(csvToTsv(t, true, "zh"), "a\tb\r\nx y\tline1 line2");
});

test("copy pads ragged rows to the table width", () => {
  const t = table([
    ["a", "b", "c"],
    ["1"],
  ]);
  assert.equal(csvToTsv(t, true, "zh"), "a\tb\tc\r\n1\t\t");
});

// ==================== 5. 列宽 ====================

test("column widths follow the content and the font size", () => {
  const rows = [["1", "a much longer description value"]];
  const small = computeCsvColumnWidths(["id", "description"], rows, 12);
  const large = computeCsvColumnWidths(["id", "description"], rows, 20);
  assert.equal(small.length, 2);
  assert.ok(small[1] > small[0], "长内容那一列更宽");
  assert.ok(large[1] > small[1], "字号变大 → 列更宽");
  assert.equal(small[0], 72, "极窄的列被夹到下限（下限与字号无关）");
});

test("column widths stay within the shared min/max bounds", () => {
  const rows = [[`single`, "a".repeat(5000)]];
  const w = computeCsvColumnWidths(["x", "y"], rows, 13);
  assert.equal(w[0], 72, "极窄内容夹到下限");
  assert.equal(w[1], 600, "超长内容夹到上限（单元格悬停有原文）");
});

test("wide tables are sampled, not scanned end to end", () => {
  // 采样步长 = ceil(行数 / 2000)：这里 5000 行 → 每 3 行取一行。
  const rows = [];
  for (let i = 0; i < WIDTH_SAMPLE_ROWS * 2.5; i++) {
    rows.push([i % 3 === 0 ? "a very long sampled cell" : "x"]);
  }
  const w = computeCsvColumnWidths(["v"], rows, 12);
  assert.ok(w[0] > 72, "采到了长内容那一行，列被撑开");
});

// ==================== 6. 文件大小文案 ====================

test("byte sizes are readable", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
});

// ==================== 7. 页内查找（命中扫描） ====================

/** 搜索匹配器。 */
const m = (term, opts = {}) => ({ term, caseSensitive: false, wholeWord: false, ...opts });

test("hits are cells, ordered by row then column", () => {
  const rows = [
    ["apple", "fresh"],
    ["pear", "apple pie"],
    ["plum", "dry"],
  ];
  assert.deepEqual(findCsvHits(rows, m("apple")).hits, [
    { row: 0, col: 0 },
    { row: 1, col: 1 },
  ]);
});

test("an empty query finds nothing (空输入不等于命中一切)", () => {
  assert.deepEqual(findCsvHits([["a"]], m("")), { hits: [], capped: false });
  assert.deepEqual(findCsvHits([["a"]], m("   ".trim())), { hits: [], capped: false });
});

test("case sensitivity follows the Aa toggle", () => {
  const rows = [["ERROR"], ["error"]];
  assert.equal(findCsvHits(rows, m("error")).hits.length, 2);
  assert.deepEqual(findCsvHits(rows, m("error", { caseSensitive: true })).hits, [
    { row: 1, col: 0 },
  ]);
});

test("whole word follows the ab| toggle (含 CJK 边界)", () => {
  const rows = [["an error occurred"], ["err."], ["错误err"], ["err"]];
  const sub = findCsvHits(rows, m("err")).hits.map((h) => h.row);
  const word = findCsvHits(rows, m("err", { wholeWord: true })).hits.map((h) => h.row);
  assert.deepEqual(sub, [0, 1, 2, 3], "子串模式：四行都含 err");
  // 第 2 行是 "错误err"（前面紧邻汉字 = 词字符），第 1 行是 "err."（后面是标点 = 边界），
  // 第 0 行 "error" 里的 err 也不是独立词。
  assert.deepEqual(word, [1, 3]);
});

test("missing cells (ragged rows) do not crash the scan", () => {
  const rows = [["a"], ["b", "c"]];
  assert.deepEqual(findCsvHits(rows, m("c")).hits, [{ row: 1, col: 1 }]);
  assert.deepEqual(findCsvHits([[], ["c"]], m("c")).hits, [{ row: 1, col: 0 }]);
});

test("the scan stops at the hit cap and says so", () => {
  const rows = Array.from({ length: 20 }, () => ["hit"]);
  const r = findCsvHits(rows, m("hit"), 5);
  assert.equal(r.hits.length, 5);
  assert.equal(r.capped, true, "被上限截断时要能显示成 5+");
  const all = findCsvHits(rows, m("hit"), 100);
  assert.equal(all.hits.length, 20);
  assert.equal(all.capped, false);
  assert.ok(CSV_FIND_CAP >= 1000, "上限要够大：几千处远超人能逐个浏览的量");
});

test("hits group by row for rendering", () => {
  const rows = [["x x", "x"], ["x", "y"], ["x", "x"]];
  const { hits } = findCsvHits(rows, m("x"));
  const byRow = groupHitsByRow(hits);
  assert.deepEqual([...byRow.get(0)], [0, 1]);
  assert.deepEqual([...byRow.get(1)], [0]);
  assert.deepEqual([...byRow.get(2)], [0, 1]);
  assert.equal(byRow.has(3), false);
});
