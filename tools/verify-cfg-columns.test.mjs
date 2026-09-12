// check-cfg-columns.mjs — Unit checks for the config-table adaptive column widths.
//
// The width computation is a pure function in src/cfg-columns.ts, so it is
// testable without a browser. Run:
//   node --experimental-strip-types --test tools/verify-cfg-columns.test.mjs
// (Node >= 23 can strip the TS types; no build step or test runner needed.)

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_COL_W,
  MAX_KEY_W,
  MIN_COL_W,
  MIN_KEY_W,
  computeColumnWidths,
  measureTextWidth,
} from "../src/cfg-columns.ts";

const FONT = 13;

/** 建一个 int 单元格。 */
const intCell = (v) => ({ t: "int", v });
/** 建一个 str 单元格。 */
const strCell = (v) => ({ t: "str", v });

test("CJK text measures wider than the same character count of ASCII", () => {
  assert.ok(measureTextWidth("值", FONT) > measureTextWidth("a", FONT));
  // 宽字符约为窄字符的两倍（1.1 vs 0.55）
  assert.equal(
    Math.round(measureTextWidth("值值", FONT) / measureTextWidth("ab", FONT)),
    2
  );
});

test("header-only columns get a width derived from the header, not the old fixed 220", () => {
  const cols = [{ name: "id", field_type: "int" }];
  const { colWidths, keyWidth } = computeColumnWidths(cols, [], [], FONT);
  // 表头很短 -> 触到下限，而不是被撑到写死的 220
  assert.equal(colWidths[0], MIN_COL_W);
  assert.equal(keyWidth, MIN_KEY_W);
});

test("column width follows the widest cell in that column", () => {
  const cols = [
    { name: "a", field_type: "str" },
    { name: "b", field_type: "str" },
  ];
  const rows = [
    [strCell("x"), strCell("y")],
    [strCell("x"), strCell("a much longer value that needs room")],
  ];
  const { colWidths } = computeColumnWidths(cols, rows, [1, 2], FONT);
  assert.ok(
    colWidths[1] > colWidths[0],
    `expected column b (${colWidths[1]}) wider than a (${colWidths[0]})`
  );
});

test("a column with short values is narrower than one with long values", () => {
  const cols = [
    { name: "flag", field_type: "bool" },
    { name: "desc", field_type: "str" },
  ];
  const rows = [
    [{ t: "bool", v: true }, strCell("a reasonably long description")],
    [{ t: "bool", v: false }, strCell("another reasonably long description")],
  ];
  const { colWidths } = computeColumnWidths(cols, rows, [1, 2], FONT);
  assert.ok(colWidths[0] < colWidths[1], "the boolean column must be narrower");
  // 短值列由**表头**决定宽度，而不是被一个固定的 90px 地板托住：
  // 77 = 表头 "flag"(+6)"bool" 的文本宽 + 单元格 padding/fudge。
  const headerW =
    measureTextWidth("flag", FONT - 1) + 6 + measureTextWidth("bool", FONT - 1);
  assert.equal(colWidths[0], Math.round(headerW) + 16 + 2);
  assert.ok(colWidths[0] < 90, `short-value column should stay under the old 90px floor, got ${colWidths[0]}`);
});

test("a very long value is capped so it cannot push other columns off screen", () => {
  const cols = [{ name: "blob", field_type: "array" }];
  const huge = "z".repeat(4000);
  const { colWidths } = computeColumnWidths(cols, [[strCell(huge)]], [1], FONT);
  assert.equal(colWidths[0], MAX_COL_W);
});

test("a long field_type contributes to the header width", () => {
  const short = computeColumnWidths([{ name: "v", field_type: "int" }], [], [], FONT);
  const long = computeColumnWidths(
    [{ name: "v", field_type: "Array<Dictionary<string, int>>" }],
    [],
    [],
    FONT
  );
  assert.ok(long.colWidths[0] > short.colWidths[0]);
});

test("a column is never narrower than its widest cell, so values are not elided", () => {
  // 这是本次改动的核心目的：旧实现给每列 minmax(90px, 220px)，
  // 超过 220px 的内容会被省略号截断。按内容定宽后，列宽必须 >= 最宽单元格所需宽度。
  const cols = [{ name: "desc", field_type: "str" }];
  const longest = "a reasonably long description that used to be clipped";
  const rows = [[strCell("short")], [strCell(longest)]];
  const { colWidths } = computeColumnWidths(cols, rows, [1, 2], FONT);
  const needed = measureTextWidth(longest, FONT) + 16 + 2;
  assert.ok(
    colWidths[0] >= needed - 1,
    `column ${colWidths[0]} must fit the widest cell (${Math.round(needed)})`
  );
});

test("key column follows key length and keeps a floor", () => {
  const narrow = computeColumnWidths([{ name: "v", field_type: "int" }], [[intCell(1)]], [1], FONT);
  const wide = computeColumnWidths(
    [{ name: "v", field_type: "int" }],
    [[intCell(1)]],
    [123456789],
    FONT
  );
  assert.ok(wide.keyWidth > narrow.keyWidth, "a longer key widens the column");
  assert.equal(narrow.keyWidth, MIN_KEY_W, "a 1-digit key clamps to the floor");

  // 上限：key 是 JSON number，而 JS 数字超过约 22 位就失去精度，
  // 所以真实数据触不到 200px 的上限。上限只作为防御性边界存在
  // （避免异常数据把最后一列挤出屏幕），这里验证它不会被突破。
  const digits = Number("1234567890123456789012345");
  const longest = computeColumnWidths(
    [{ name: "v", field_type: "int" }],
    [[intCell(1)]],
    [digits],
    FONT
  );
  assert.ok(longest.keyWidth <= MAX_KEY_W);
  assert.equal(longest.keyWidth, Math.round(measureTextWidth(String(digits), FONT)) + 18);
});

test("widths are deterministic and every column stays within the bounds", () => {
  const cols = [
    { name: "id", field_type: "int" },
    { name: "name", field_type: "str" },
    { name: "flag", field_type: "bool" },
  ];
  const rows = [
    [intCell(1), strCell("sword"), { t: "bool", v: true }],
    [intCell(42), strCell("a very long item name indeed"), { t: "bool", v: false }],
  ];
  const a = computeColumnWidths(cols, rows, [1, 42], FONT);
  const b = computeColumnWidths(cols, rows, [1, 42], FONT);
  assert.deepEqual(a, b, "same input must give the same widths");
  for (const w of a.colWidths) {
    assert.ok(w >= MIN_COL_W && w <= MAX_COL_W, `width ${w} out of bounds`);
  }
});

test("narrow value columns no longer reserve the old fixed 90px floor", () => {
  // 旧实现：每列 minmax(90px, 220px)，短值列也至少 90px。
  // 注意表头本身有宽度（列名+类型名），所以「窄列」只可能窄到表头所需的宽度，
  // 不可能比表头还窄 —— 这里用一个短列名的表头来验证列宽确实低于 90。
  const cols = [{ name: "lv", field_type: "int" }];
  const rows = [[intCell(1)], [intCell(99)]];
  const { colWidths } = computeColumnWidths(cols, rows, [1, 2], FONT);
  assert.ok(
    colWidths[0] < 90,
    `a column whose header and values are both short should stay below the old 90px floor, got ${colWidths[0]}`
  );
  // 而表头很长的列可以超过 90 —— 说明宽度是跟着内容走的，不是固定值。
  const wideHead = computeColumnWidths(
    [{ name: "a_very_long_column_name", field_type: "int" }],
    rows,
    [1, 2],
    FONT
  );
  assert.ok(wideHead.colWidths[0] > 90);
});
