// verify-md-sample.test.mjs — 把 repro/md-sample.md 过一遍真实渲染管线，核对元素清单。
//
// 这份样例是给人看的手工自检文件，也顺手当成结构回归：改了渲染器却把某类元素改坏
// （表格列对齐丢了、公式被判成价格、图片占位路径没解析…），这里会立刻失败。
//
// 覆盖不到的部分（刻意留给浏览器 E2E `tools/e2e-markdown.mjs`）：
//   - 清洗（DOMPurify 需要 DOM，见下）；
//   - KaTeX 的真实排版尺寸；
//   - 交互（大纲跳转、查找、链接分流）。
//
// 运行：node --test tools/verify-md-sample.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { renderMarkdown } from "../src/markdown/markdown.ts";

const SAMPLE_PATH = new URL("../repro/md-sample.md", import.meta.url);
const DOC_PATH = "E:\\Workspace\\submodules\\LogLens\\repro\\md-sample.md";

/**
 * 透传桩：本文件只验「结构」，不验清洗。
 * DOMPurify 在无 DOM 的 Node 里不可用（`isSupported === false`），
 * 真实清洗由浏览器 E2E 覆盖 —— 这正是管线把 sanitize 设计成注入参数的原因。
 */
const passthrough = (html) => html;

const source = readFileSync(SAMPLE_PATH, "utf8");
const rendered = renderMarkdown(source, { sanitize: passthrough, docPath: DOC_PATH });
const html = rendered.html;

/** 数某个标记出现次数。 */
const count = (re) => (html.match(re) ?? []).length;

test("样例文件本身是完整的中文文档", () => {
  assert.ok(source.length > 4000, "样例应包含足够多的元素，实际 " + source.length + " 字符");
  assert.match(source, /LogLens Markdown 预览/);
  assert.equal(rendered.lines, source.split("\n").length);
});

test("标题与大纲：h1–h6 全部进入大纲，id 唯一且锚点都指向真实标题", () => {
  const { outline } = rendered;
  assert.ok(outline.length >= 20, "大纲应覆盖全文标题，实际 " + outline.length + " 条");
  assert.deepEqual(outline.map((h) => h.depth).slice(0, 3), [1, 2, 3], "首三条应是 h1/h2/h3");
  assert.ok(
    outline.some((h) => h.depth === 6),
    "六级标题也应进大纲（样例第 1 节有 h4/h5/h6）"
  );

  const ids = outline.map((h) => h.id);
  assert.equal(new Set(ids).size, ids.length, "标题 id 必须唯一：\n" + ids.join("\n"));
  // 同名标题去重：第 11 节刻意放了两个「重复标题」
  assert.ok(ids.includes("重复标题") && ids.includes("重复标题-2"), "同名标题应加 -2 后缀去重");

  // 每个 `data-md-anchor`（标题的「复制锚点」+ 正文里的锚点链接）都必须指向存在的 id。
  // 这条能抓住 slug 规则漂移 —— 改 slugify 而忘了改文档里的 `#4-表格` 之类链接时立刻红。
  const anchors = [...html.matchAll(/data-md-anchor="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(anchors.length > outline.length, "应包含标题锚点与正文锚点链接");
  const missing = anchors.filter((a) => !ids.includes(a));
  assert.deepEqual(missing, [], "锚点指向了不存在的标题 id：" + missing.join(", "));
  assert.ok(ids.includes("4-表格"), "`## 4. 表格` 的锚点应可被 `#4-表格` 命中，实际 " + ids.join(", "));
});

test("表格：4 张，列对齐（左/右/中）与宽表都在", () => {
  assert.equal(count(/<table>/g), 4, "样例应渲染出 4 张表（主表/宽表/转义表/自检清单）");
  assert.ok(count(/<th align="right">/g) >= 1, "应有右对齐表头");
  assert.ok(count(/<th align="center">/g) >= 1, "应有居中表头");
  const wideRow = /<td>C10<\/td>|<\/th>\s*<th[^>]*>C10/.test(html);
  assert.ok(wideRow, "10 列宽表应完整渲染");
  assert.match(html, /a \| b|<code>a \| b<\/code>/, "表格里的竖线转义应显示为 |");
});

test("任务列表：4 个只读勾选框，其中 2 个勾选", () => {
  const boxes = count(/<input[^>]*type="checkbox"[^>]*>/g);
  assert.equal(boxes, 4, "样例应有 4 个任务勾选框，实际 " + boxes);
  assert.equal(count(/<input[^>]*checked/g), 2, "其中 2 个应为勾选状态");
  assert.equal(count(/<input(?![^>]*disabled)/g), 0, "勾选框必须是 disabled（只读）");
});

test("公式：四种写法齐全，行内与块级数量符合样例", () => {
  const katex = count(/class="katex"/g);
  const display = count(/class="katex-display"/g);
  assert.ok(katex >= 15, "行内+块级公式总数应 ≥ 15，实际 " + katex);
  assert.equal(display, 7, "块级公式应为 7 个（$$ ×6 + \\[ ×1），实际 " + display);
  // 矩阵/方程组/aligned 用的结构必须进到 KaTeX 输出里
  assert.ok(count(/class="katex-error"/g) >= 1, "最后一个故意写错的公式应渲染成错误提示");
});

test("公式防误判：价格与 shell 变量保持原文，行内代码里的 $ 不着色", () => {
  assert.match(html, /价格区间：\$5 到 \$10/, "价格区间应原样显示");
  assert.match(html, /单个价格：\$100/, "单个价格应原样显示");
  assert.match(html, /echo \$PATH 与 \$HOME/, "shell 变量应原样显示");
  assert.match(html, /<code>\$a\^2 \+ b\^2\$<\/code>/, "行内代码里的公式应保持代码形态");
});

test("代码块：7 块，可识别语言着色，未识别语言只标语言名不着色", () => {
  assert.equal(count(/<pre class="md-pre">/g), 7, "样例应有 7 个代码块");
  // 语言名会写进 class（即使不可识别）—— 这样 CSS/工具能按语言区分；
  // 真正的高亮只对 highlight.js 认识的 4 种语言发生。
  assert.equal(count(/class="hljs language-/g), 6, "除「无语言」那块外都应带语言名");
  const blocks = [...html.matchAll(/<pre class="md-pre"><code class="([^"]*)">([\s\S]*?)<\/code><\/pre>/g)];
  const highlighted = blocks.filter(([, , body]) => body.includes('<span class="hljs-'));
  assert.deepEqual(
    highlighted.map(([, cls]) => cls.replace("hljs language-", "")),
    ["python", "csharp", "json", "bash"],
    "只有这四种语言应被高亮"
  );
  const unknown = blocks.find(([, cls]) => cls.includes("not-a-real-language"));
  assert.ok(unknown && !unknown[2].includes('<span class="hljs-'), "未识别语言不应着色");
  assert.match(html, /&lt;b&gt;这一块不会被高亮&lt;\/b&gt;/, "未知语言块里的 <b> 必须转义");
  assert.doesNotMatch(html, /<b>这一块不会被高亮<\/b>/, "未识别语言不得放出 HTML");
});

test("图片：6 处容器，本地图片文件带 src-less <img>，远程与另类路径只保留占位", () => {
  const chips = [...html.matchAll(/class="md-image"[^>]*data-md-src="([^"]*)"[^>]*data-md-kind="([^"]*)"/g)];
  // 第 7 节 5 处（Markdown 语法 4 + 原始 HTML 1），第 10 节那条注入的 <img> 也会被改写。
  assert.equal(chips.length, 6, "样例应有 6 处图片容器，实际 " + chips.length);
  assert.doesNotMatch(html, /onerror=/, "原始 HTML 的 onerror 属性不应留在输出里");
  // 本地图片文件（带图片后缀）才有真实 <img>：远程 URL 与 src="x"（无后缀）只保留占位。
  const imgs = [...html.matchAll(/<img class="md-image-img"[^>]*data-md-path="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(
    imgs,
    [
      "E:\\Workspace\\submodules\\LogLens\\docs\\screenshot.png",
      "E:\\Workspace\\submodules\\LogLens\\repro\\imgs\\does-not-exist.png",
      "E:\\Workspace\\submodules\\LogLens\\repro\\imgs\\missing.png",
      "E:\\Workspace\\submodules\\LogLens\\docs\\screenshot.png",
    ],
    "四处图片写法应产生 <img>（含原始 HTML 那处）；远程 URL 与 src=\"x\" 不算"
  );
  assert.equal(
    chips[0][1],
    "E:\\Workspace\\submodules\\LogLens\\docs\\screenshot.png",
    "相对路径应按文档目录解析成绝对路径"
  );
  assert.equal(chips[3][2], "url", "远程图片应是 url 类型");
  assert.equal(chips[5][2], "path", "第 10 节那条 src=\"x\" 没有图片后缀，应标成 path");
});

test("链接：外链/相对/锚点三类各自带上分流标记", () => {
  assert.ok(count(/data-md-external="1"/g) >= 3, "外链应带 data-md-external（含 mailto）");
  const docs = [...html.matchAll(/data-md-path="([^"]*)" data-md-kind="doc"/g)].map((m) => m[1]);
  assert.ok(docs.includes("E:\\Workspace\\submodules\\LogLens\\README.md"), "相对 .md 链接应解析成绝对路径");
  assert.ok(docs.includes(DOC_PATH), "指向自身的链接也应解析");
  assert.match(html, /data-md-anchor="4-表格"/, "锚点链接应带锚点 id");
});

test("其余块级元素：引用、分隔线、折叠块都在", () => {
  assert.ok(count(/<blockquote>/g) >= 2, "应有嵌套引用");
  assert.ok(count(/<hr>/g) >= 2, "应有分隔线");
  assert.match(html, /<details>/, "原始 HTML 的 <details> 应通过（清洗阶段再决定去留）");
  assert.match(html, /<kbd>Ctrl<\/kbd>/, "行内原始 HTML <kbd> 应保留");
});

test("脚注：第 12 节的三处引用按首次引用编号，未定义的那条保持原文", () => {
  assert.equal(rendered.footnotes, 2, "样例有两条带定义的脚注");
  const refs = [...html.matchAll(/data-md-footnote="([^"]*)"[^>]*>(\d+)</g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(
    refs,
    [
      ["one", "1"],
      ["one", "1"],
      ["two", "2"],
    ],
    "编号按首次引用顺序：同一标本同号（`one` 两次都是 1），`two` 虽定义在前仍是 2"
  );
  assert.equal(count(/data-md-footnote-item="/g), 2, "两条定义各产生一个条目");
  assert.equal(count(/<section class="md-footnotes"/g), 1, "脚注区只应有一个");
  assert.match(html, /\[\^todo\]/, "没有定义的引用应保持原文");
  assert.doesNotMatch(html, /\[\^one\]:/, "定义行不应留在正文里");
  assert.match(html, /续行用 4 个空格缩进，应折进同一条脚注里/, "多行定义应折进同一条");
  assert.ok(
    /<li id="footnote-one"[\s\S]*?<code>行内代码<\/code>[\s\S]*?<\/li>/.test(html),
    "脚注正文里的行内代码应照常渲染"
  );
  assert.match(html, /class="md-footnote-back"/, "每个条目都要带回跳箭头");
});

test("安全自检小节的注入样例确实进入了 HTML（由浏览器侧清洗负责拦掉）", () => {
  // 这里刻意断言「注入还在」：管线只负责渲染，拦截是 sanitize 的职责。
  // 若哪天有人在管线里加了粗糙的正则过滤，这条会失败，提醒去改 sanitize 而不是各处打补丁。
  for (const snippet of [
    "<script>window.__xss = 1;</script>",
    "<style>",
    "<iframe",
    "javascript:window.__xss=3",
    "<form",
    "<meta",
    "<link",
  ]) {
    assert.ok(html.includes(snippet), "管线不应自行吞掉注入片段：" + snippet);
  }
  // 例外是 <img>：它在管线里就被改写成容器了（见 imagePlaceholder），onerror 一起消失。
  // 断言「留下的 <img> 只能是容器自己产出、且不带 src」——文档写的 src 一个都不留。
  const imgTags = html.match(/<img\b[^>]*>/g) ?? [];
  assert.ok(imgTags.length > 0, "本地图片文件应产生容器的 <img>");
  for (const tag of imgTags) {
    assert.match(tag, /class="md-image-img"/, "只允许容器自产的 <img>，实际 " + tag);
    assert.ok(!/\ssrc=/.test(tag), "文档里的 src 不能留下（地址由页面用 asset 协议注入）：" + tag);
  }
});
