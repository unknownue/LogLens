// verify-search-frontend.mjs — Cross-check the frontend search matcher against the
// backend's semantics on the real sample log, without needing a browser.
//
// Mirrors findSpans() from src/App.tsx (substring + whole-word, ASCII case folding,
// overlapping matches) and reports counts that must agree with `cargo test --lib`
// expectations for repro/sample_log.txt (159 lines, 16 ERROR, 6 standalone "pool",
// 7 substring "pool", 2 "shutdown").
//
// Run: node tools/verify-search-frontend.mjs

import { readFileSync } from "node:fs";

const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;
const isWordChar = (ch) => ch.length > 0 && WORD_CHAR_RE.test(ch);

function findSpans(text, m) {
  if (!m.term) return [];
  const needle = m.caseSensitive ? m.term : m.term.toLowerCase();
  const hay = m.caseSensitive ? text : text.toLowerCase();
  const spans = [];
  let i = 0;
  while (i <= hay.length - needle.length) {
    const at = hay.indexOf(needle, i);
    if (at < 0) break;
    const end = at + needle.length;
    if (!m.wholeWord || (!isWordChar(text.charAt(at - 1)) && !isWordChar(text.charAt(end)))) {
      spans.push([at, end]);
    }
    i = at + 1;
  }
  return spans;
}

const raw = readFileSync(new URL("../repro/sample_log.txt", import.meta.url), "utf8");
const lines = raw.split("\n");
if (lines.length && lines[lines.length - 1] === "") lines.pop();

const count = (m) => lines.reduce((n, l) => n + (findSpans(l, m).length > 0 ? 1 : 0), 0);

const cases = [
  ["ERROR (ci substring)", { term: "ERROR", caseSensitive: false, wholeWord: false }, 16],
  ["error (ci substring)", { term: "error", caseSensitive: false, wholeWord: false }, 16],
  ["ERROR (cs substring)", { term: "ERROR", caseSensitive: true, wholeWord: false }, 16],
  ["error (cs substring)", { term: "error", caseSensitive: true, wholeWord: false }, 0],
  ["shutdown (ci)", { term: "shutdown", caseSensitive: false, wholeWord: false }, 2],
  // 在 repro/sample_log.txt 里 "pool" 每次出现都落在词边界上（含 L7 的 "database pool"），
  // 因此全字与子串结果相同；真正区分两种模式的用例见下面的合成断言。
  ["pool (ci substring)", { term: "pool", caseSensitive: false, wholeWord: false }, 7],
  ["pool (ci whole word)", { term: "pool", caseSensitive: false, wholeWord: true }, 7],
  ["WARN (ci)", { term: "WARN", caseSensitive: false, wholeWord: false }, 26],
  // "ERR" 是真正能区分两种模式的词：作为子串命中全部 16 行（"ERROR" 里含 ERR），
  // 作为完整单词则一行都不命中（日志里没有独立的 "ERR" 记号）。
  ["ERR (ci substring)", { term: "ERR", caseSensitive: false, wholeWord: false }, 16],
  ["ERR (ci whole word)", { term: "ERR", caseSensitive: false, wholeWord: true }, 0],
];

const synthetic = [
  ["whole-word rejects inside-word", "an error occurred", { term: "err", caseSensitive: false, wholeWord: true }, 0],
  ["whole-word accepts standalone", "the err here", { term: "err", caseSensitive: false, wholeWord: true }, 1],
  ["substring accepts inside-word", "an error occurred", { term: "err", caseSensitive: false, wholeWord: false }, 1],
];

let failed = 0;
console.log("lines in sample_log.txt:", lines.length);
console.log("");
for (const [name, matcher, expect] of cases) {
  const got = count(matcher);
  const ok = got === expect;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(24)} got ${String(got).padStart(4)}  expect ${expect}`);
}

console.log("");
console.log("synthetic semantics checks:");
for (const [name, text, matcher, expect] of synthetic) {
  const got = findSpans(text, matcher).length;
  const ok = got === expect;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(30)} got ${got}  expect ${expect}`);
}

// overlapping-match sanity: "aaaa" searched for "aa" => 3 overlapping hits
const overlap = findSpans("aaaa", { term: "aa", caseSensitive: false, wholeWord: false }).length;
const overlapOk = overlap === 3;
if (!overlapOk) failed++;
console.log(`${overlapOk ? "PASS" : "FAIL"}  ${"overlap 'aa' in 'aaaa'".padEnd(24)} got ${String(overlap).padStart(4)}  expect 3`);

// CJK whole-word safety: "错误err" — "err" must NOT be a whole word (preceded by CJK letter)
const cjk = findSpans("错误err", { term: "err", caseSensitive: false, wholeWord: true }).length;
const cjkOk = cjk === 0;
if (!cjkOk) failed++;
console.log(`${cjkOk ? "PASS" : "FAIL"}  ${"CJK whole-word boundary".padEnd(24)} got ${String(cjk).padStart(4)}  expect 0`);

console.log("");
console.log(failed === 0 ? "ALL FRONTEND MATCHER CHECKS PASSED" : `FAILED ${failed} check(s)`);
process.exit(failed === 0 ? 0 : 1);
