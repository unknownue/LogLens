// verify-markdown.test.mjs — Unit checks for the markdown rendering pipeline.
//
// 覆盖渲染管线里真正会出错的地方（而不是「marked 能不能渲染表格」）：
//   1. 公式边界：中文紧贴写法的 `$p$` 要能识别，价格/脚本变量里的 `$` 不能被误判；
//   2. 代码块：高亮只对可识别语言生效，未知语言保持转义原文；
//   3. 标题 id / 大纲：中文标题、重复标题去重、公式标题不产生乱码 id；
//   4. 链接与图片：相对路径按文档目录解析（含 %20 解码与 ../ 回溯），
//      外链与锚点走各自的通道，本地图片一律是占位符（CSP 下加载不了真图）；
//   5. 清洗是**注入**的一步：断言最终 HTML 来自注入的清洗器（真实清洗由浏览器 E2E 验）。
//
// 运行：node --test tools/verify-markdown.test.mjs
// （Node >= 23 直接剥离 TS 类型；DOMPurify 依赖 DOM，故本文件不碰它 —— 这正是管线把
//   sanitize 设计成注入参数的原因。）

import test from "node:test";
import assert from "node:assert/strict";

import { renderMarkdown, slugifyHeading } from "../src/markdown/markdown.ts";
import { extensionOf, isMarkdownPath, isSchemeHref, resolveRelativePath } from "../src/markdown/paths.ts";

/** 透传桩：记录被调用次数与入参，用于断言「清洗确实在链路上」。 */
function spySanitize() {
  const calls = [];
  const fn = (html) => {
    calls.push(html);
    return html;
  };
  fn.calls = calls;
  return fn;
}

/** 渲染工具：默认不带 docPath，需要路径解析的用例显式传。 */
function render(source, docPath = "") {
  const sanitize = spySanitize();
  const result = renderMarkdown(source, { sanitize, docPath });
  return { ...result, sanitize };
}

// ==================== 1. GFM 基本格式 ====================

test("gfm tables render with head and body", () => {
  const { html } = render("| 名称 | 值 |\n| --- | ---: |\n| 生命 | 100 |\n");
  assert.match(html, /<table>/);
  assert.match(html, /<thead>/);
  assert.match(html, /<th[^>]*>名称<\/th>/);
  assert.match(html, /<td[^>]*>生命<\/td>/);
  // marked 用遗留属性 `align` 表达对齐（不是 style）：CSS 里必须为它补规则，
  // 否则右对齐的数字列会靠左显示。
  assert.match(html, /<th align="right">值<\/th>/);
});

test("task lists, strikethrough and blockquote all survive", () => {
  const { html } = render("- [x] 已完成\n- [ ] 未完成\n\n~~删除~~\n\n> 引用\n");
  assert.match(html, /<input[^>]*checked[^>]*disabled/);
  assert.match(html, /<del>删除<\/del>/);
  assert.match(html, /<blockquote>/);
});

// ==================== 2. 公式边界 ====================

test("block math with $$ renders katex display mode", () => {
  const { html } = render("$$\nE = mc^2\n$$\n");
  assert.match(html, /class="katex-display"/);
  assert.match(html, /class="katex"/);
});

test("inline math works when chinese text is glued to the dollars", () => {
  // 这是选型的关键用例：marked-katex-extension 的默认规则要求 $ 两侧有空格，
  // 中文文档里最常见的写法恰恰是紧贴。
  const { html } = render("若整数 $p$ 满足条件，则调用 `f()`。\n");
  assert.match(html, /class="katex"/, "紧贴中文的 $p$ 必须识别为公式");
  assert.match(html, /<code>f\(\)<\/code>/, "行内代码不受影响");
});

test("inline math also supports \\( \\) form", () => {
  const { html } = render("解为 \\(x = \\frac{1}{2}\\) ，其中\n");
  assert.match(html, /class="katex"/);
});

test("block math also supports \\[ \\] form", () => {
  const { html } = render("\\[\n\\sum_{i=0}^{n} i\n\\]\n");
  assert.match(html, /class="katex-display"/);
});

test("prices and shell variables are NOT treated as math", () => {
  // 误判代价很高：整段文字被塞进公式渲染器，会变成一堆乱码般的行内数学块。
  const cases = [
    "价格 $5 到 $10，请确认。",
    "运行 echo $PATH $HOME 查看。",
    "总价 $100。",
    "费用为 $5.00 元。",
  ];
  for (const source of cases) {
    const { html } = render(source);
    assert.doesNotMatch(html, /class="katex"/, `不应把公式渲染出来：${source}`);
    assert.match(html, /\$/, `原始 $ 应原样保留：${source}`);
  }
});

test("dollar inside inline code and code fences stays literal", () => {
  const inline = render("变量写作 `$a$` 的形式。\n");
  assert.doesNotMatch(inline.html, /class="katex"/, "行内代码里的 $a$ 不能被当作公式");
  assert.match(inline.html, /<code>\$a\$<\/code>/);

  const fenced = render("```bash\necho $PATH $HOME\n```\n");
  assert.doesNotMatch(fenced.html, /class="katex"/, "代码块里的 $ 不能被当作公式");
});

// ==================== 3. 代码高亮 ====================

test("known languages are highlighted, unknown ones stay escaped", () => {
  const known = render("```python\ndef f(x):\n    return x + 1\n```\n");
  assert.match(known.html, /class="hljs language-python"/);
  assert.match(known.html, /class="hljs-keyword"/);

  const unknown = render("```not-a-language\n<script>alert(1)</script>\n```\n");
  assert.match(unknown.html, /language-not-a-language/);
  assert.doesNotMatch(unknown.html, /<script>/, "未识别语言的代码块必须转义，不能把 <script> 放出来");
  assert.match(unknown.html, /&lt;script&gt;/);
});

// ==================== 4. 标题与大纲 ====================

test("headings get chinese-friendly unique anchors and an outline", () => {
  const { html, outline } = render("# 概览\n\n## 用法\n\ntext\n\n## 用法\n");
  assert.deepEqual(
    outline.map((h) => [h.depth, h.text, h.id]),
    [
      [1, "概览", "概览"],
      [2, "用法", "用法"],
      [2, "用法", "用法-2"],
    ]
  );
  assert.match(html, /<h2 id="用法">/);
  assert.match(html, /<h2 id="用法-2">/, "同名标题必须去重，否则大纲跳转会指错位置");
});

test("heading slug ignores markup and stays stable", () => {
  assert.equal(slugifyHeading("`code` 与 **粗体**"), "code-与-粗体");
  assert.equal(slugifyHeading("A B"), "a-b");
  assert.equal(slugifyHeading("？？？"), "section", "纯标点标题要有兜底 id");
});

test("outline follows the html that is actually rendered (markup stripped)", () => {
  const { outline } = render("## 带 `代码` 的标题\n");
  assert.equal(outline[0].text, "带 代码 的标题");
});

// ==================== 5. 链接与图片 ====================

const DOC = "D:\\Work\\docs\\guide\\index.md";

test("relative links resolve against the document directory", () => {
  const { html } = render("[下一章](./ch2/setup.md)\n[上级](../README.md)\n[带空格](imgs/a%20b.md)\n", DOC);
  assert.match(html, /data-md-path="D:\\Work\\docs\\guide\\ch2\\setup\.md" data-md-kind="doc"/);
  assert.match(html, /data-md-path="D:\\Work\\docs\\README\.md"/);
  assert.match(html, /data-md-path="D:\\Work\\docs\\guide\\imgs\\a b\.md"/, "%20 必须解码为空格");
});

test("anchors, external urls and absolute paths take their own channels", () => {
  const { html } = render("[锚点](#用法)\n[官网](https://example.com/a?b=1)\n[本地](D:\\logs\\a.log)\n", DOC);
  assert.match(html, /data-md-anchor="用法"/);
  assert.match(html, /data-md-external="1"/);
  assert.match(html, /data-md-path="D:\\logs\\a\.log"/);
});

test("images become containers; local image files get a real (src-less) <img>", () => {
  const { html } = render(
    "![架构图](imgs/arch.png)\n![远程](https://example.com/x.png)\n![非图片](./notes/todo)\n",
    DOC
  );
  assert.match(html, /class="md-image"[^>]*data-md-src="D:\\Work\\docs\\guide\\imgs\\arch\.png"[^>]*data-md-kind="file"/);
  assert.match(html, /data-md-kind="url"/);
  // 本地图片文件带一个**没有 src** 的 <img>：真实地址由页面用 asset 协议填
  // （管线是纯函数，跑不了 Tauri API，也不该知道 asset:// 的形式）。
  assert.match(html, /<img class="md-image-img"[^>]*data-md-path="D:\\Work\\docs\\guide\\imgs\\arch\.png"/);
  assert.doesNotMatch(html, /<img[^>]*\ssrc=/, "管线不应写死 src");
  // 远程图片与非图片文件不产生 <img>
  assert.equal((html.match(/<img class="md-image-img"/g) ?? []).length, 1);
  assert.match(html, /架构图/);
});

test("raw html <img> is rewritten to the same container", () => {
  const { html } = render('<img src="imgs/x.jpg" alt="图" width="600">\n\n（原始 HTML 写法也要能预览）\n', DOC);
  assert.doesNotMatch(html, /<img class="md-image-img"[^>]*\ssrc=/, "原始 img 的 src 不应留下");
  assert.match(html, /data-md-src="D:\\Work\\docs\\guide\\imgs\\x\.jpg"/);
  assert.match(html, /data-md-path="D:\\Work\\docs\\guide\\imgs\\x\.jpg"/);
});

test("cross-document anchors survive path resolution", () => {
  const { html } = render("[下一章](./ch2/setup.md#安装步骤)\n[无锚点](./ch2.md)\n", DOC);
  assert.match(
    html,
    /data-md-path="D:\\Work\\docs\\guide\\ch2\\setup\.md" data-md-kind="doc" data-md-frag="安装步骤"/,
    "路径解析会剥掉 fragment，跨文档锚点必须单独带出来"
  );
  assert.match(
    html,
    /data-md-path="D:\\Work\\docs\\guide\\ch2\.md" data-md-kind="doc">/,
    "没有锚点时不产生多余的 data-md-frag"
  );
});

test("document-authored inline styles are stripped, katex's own ones survive", () => {
  // 公式排版完全依赖内联 style，而内联 style 在应用里是被 CSP 放行的
  // （见 tauri.conf.json 的 dangerousDisableAssetCspModification）——
  // 所以「文档作者手写的 style」必须在这一层删掉，否则一个 position:fixed 就能盖住界面。
  const raw = render(
    '<div style="position:fixed;inset:0;background:red">覆盖层</div>\n\n带 <span style="color:red">内联样式</span> 的段落\n',
    DOC
  );
  assert.doesNotMatch(raw.html, /\sstyle\s*=/i, "文档自带的内联样式必须被删掉");
  assert.match(raw.html, /覆盖层/, "删的是样式，内容要留住");
  assert.match(raw.html, /内联样式/);

  // `data-style` 之类的属性名不应被误伤
  const attr = render('<div data-style="keep">x</div>\n', DOC);
  assert.match(attr.html, /data-style="keep"/, "属性名里含 style 的不能被误删");

  // 渲染器自己产出的内联样式（KaTeX 的定位/高度）必须保留
  const math = render("行内 $p^2$ 与块级：\n\n$$\n\\frac{a}{b}\n$$\n", DOC);
  assert.match(math.html, /style="height:[^"]+"/, "KaTeX 的内联样式必须保留，否则公式排版会塌");
  assert.match(math.html, /style="top:-[^"]+"/, "上下标定位样式必须保留");
});

// ==================== 6. 脚注 ====================

test("the footnote section goes through sanitize too (no bypass for footnote HTML)", () => {
  // 脚注定义是**文档作者写的** markdown，里面的原始 HTML 和其他地方一样不可信：
  // 若把脚注区拼在 sanitize() 之后，`[^a]: <style>…</style>` 这种写法就能绕过清洗
  // 直接进 DOM（`<style>` 足以把整个界面藏起来）。
  const { sanitize, html } = render(
    "[^a]: <style>body{display:none}</style> 说明文字\n\n正文引用[^a]\n"
  );
  assert.equal(sanitize.calls.length, 1, "整篇 HTML 应一次性交给清洗器");
  assert.match(
    sanitize.calls[0],
    /md-footnotes/,
    "脚注区必须出现在交给清洗器的那份 HTML 里（不能拼接在 sanitize 之后）"
  );
  assert.equal(html, sanitize.calls[0], "返回的就是清洗后的结果");
});

test("footnotes are numbered by first reference, not by definition order", () => {
  // 定义顺序与引用顺序刻意相反：读者看到的角标必须是 1、2（从上到下），
  // 而不是「定义写在前面所以先编号」。
  const { html, footnotes } = render(
    "正文引用甲[^a]，随后引用乙[^b]。\n\n[^b]: 乙的说明\n\n[^a]: 甲的说明\n"
  );
  assert.equal(footnotes, 2);
  assert.match(html, /data-md-footnote="a"[^>]*>1</, "先被引用的甲应是 1 号");
  assert.match(html, /data-md-footnote="b"[^>]*>2</, "后被引用的乙应是 2 号");
  // 定义行必须从正文里消失（否则读者会看到一行 `[^b]: …`）
  assert.doesNotMatch(html, /\[\^b\]:/, "定义行不应留在正文里");
  // 条目顺序与序号一致
  assert.match(
    html,
    /<li id="footnote-a"[^>]*>甲的说明[\s\S]*<li id="footnote-b"[^>]*>乙的说明/
  );
  // 脚注区在正文末尾，带类名与标记（CSS / E2E 依赖它们）
  assert.match(html, /<section class="md-footnotes" data-md-footnotes="1">/);
});

test("the same footnote referenced twice keeps one number", () => {
  const { html, footnotes } = render("甲[^x] 与 乙[^y] 再提一次甲[^x]。\n\n[^x]: X\n[^y]: Y\n");
  assert.equal(footnotes, 2);
  assert.equal((html.match(/data-md-footnote="x"/g) ?? []).length, 2, "两处引用都要渲染");
  assert.match(html, /data-md-footnote="x"[^>]*>1</);
  assert.match(html, /data-md-footnote="x"[^>]*>1</);
  assert.match(html, /data-md-footnote="y"[^>]*>2</, "第二次引用甲不应把乙挤后");
  assert.equal((html.match(/data-md-footnote-item="x"/g) ?? []).length, 1, "条目只出现一次");
});

test("a reference without a definition stays literal", () => {
  // 写完忘记加定义时，宁可留下原文（一眼可见），也不要变成一个指向不存在锚点的死链接。
  const { html, footnotes } = render("待补充[^todo] 与正常[^ok]。\n\n[^ok]: 有定义\n");
  assert.equal(footnotes, 1);
  assert.match(html, /\[\^todo\]/, "没有定义的引用应保持原文");
  assert.doesNotMatch(html, /data-md-footnote="todo"/);
});

test("unused definitions disappear entirely", () => {
  const { html, footnotes } = render("正文没有引用。\n\n[^ghost]: 孤儿定义\n");
  assert.equal(footnotes, 0);
  assert.doesNotMatch(html, /<section class="md-footnotes"/, "没有脚注时不产空区块");
  assert.doesNotMatch(html, /ghost|\^ghost/, "孤儿定义连原文都不该留下");
});

test("footnote bodies keep inline markup but are not block-wrapped", () => {
  const { html } = render("见[^fmt]。\n\n[^fmt]: 带 `code`、**粗体** 与 [链接](https://example.com) 的说明\n");
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<strong>粗体<\/strong>/);
  assert.match(html, /data-md-external="1"/, "脚注内的外链同样走分流标记");
  assert.doesNotMatch(html, /<li[^>]*>[\s\S]*?<p>/, "条目正文不应被包成段落");
});

test("multi-line definitions fold continuation lines", () => {
  const { html, footnotes } = render("引用[^m]。\n\n[^m]: 第一行\n    第二行\n\n正文继续。\n");
  assert.equal(footnotes, 1);
  assert.match(html, /第一行 第二行/, "续行应折进同一条脚注");
  assert.match(html, /正文继续/, "空行之后的正文不受影响");
});

test("footnote syntax inside code stays literal", () => {
  // 围栏刻意用 `~~~` 而不是反引号：反引号在 JS 字符串里要转义（```），写错了就会
  // 变成「单个反引号」，那条用例其实什么都没测到 —— 这里用波浪线围栏，源码可读且不会踩。
  const { html, footnotes } = render(
    "~~~\n[^1]: 代码里的定义\n\n引用 [^1] 也只是文本\n~~~\n\n真正的[^real]引用。\n\n[^real]: 真定义\n"
  );
  assert.equal(footnotes, 1, "围栏里的定义不算定义");
  assert.match(html, /\[\^1\]: 代码里的定义/, "代码块内容必须原样保留");
  assert.match(html, /data-md-footnote="real"/);
  assert.equal((html.match(/<section class="md-footnotes"/g) ?? []).length, 1, "只应有一个脚注区");
});

test("footnote anchors are linkable and back-links exist", () => {
  const { html } = render("引用[^1]。\n\n[^1]: 说明\n");
  assert.match(html, /id="footnote-ref-1" href="#footnote-1"/, "角标要能直接分享锚点");
  assert.match(html, /id="footnote-1"/, "条目锚点用 footnote-N 形式");
  assert.match(html, /class="md-footnote-back" href="#footnote-ref-1"/, "条目要能跳回引用处");
});

test("footnotes work together with math and headings", () => {
  // 回归：脚注是**行内扩展**，必须与公式扩展、标题 slug 共存（都能拿到自己的 token）
  const { html, outline } = render(
    "# 概览[^n]\n\n公式 $p$ 与脚注[^n] 同段。\n\n[^n]: 一条说明\n"
  );
  assert.match(html, /<h1 id="概览"/, "标题里的脚注不应污染 slug");
  assert.equal(outline[0].text, "概览", "大纲文本不应带上角标");
  assert.match(html, /class="katex"/, "同一段里的公式照常渲染");
  assert.match(html, /data-md-footnote="n"/);
});

// ==================== 7. 清洗注入 & 收尾 ====================

test("sanitize is injected exactly once and its output is what ships", () => {
  const { sanitize, html } = render("# 标题\n\n正文\n");
  assert.equal(sanitize.calls.length, 1, "管线必须把整篇 HTML 交给清洗器一次");
  assert.match(sanitize.calls[0], /<h1/);
  assert.equal(html, sanitize.calls[0], "返回的 HTML 必须是清洗后的结果，而不是解析结果");
});

test("crlf markdown parses like lf markdown", () => {
  const lf = render("# 标题\n\n| a | b |\n| - | - |\n| 1 | 2 |\n");
  const crlf = render("# 标题\r\n\r\n| a | b |\r\n| - | - |\r\n| 1 | 2 |\r\n");
  assert.equal(crlf.html.replace(/\r/g, ""), lf.html);
  assert.equal(crlf.outline.length, 1);
});

test("line count matches the source, empty document yields zero", () => {
  assert.equal(render("a\nb\nc").lines, 3);
  assert.equal(render("").lines, 0);
});

// ==================== 7. 路径工具 ====================
test("path helpers classify hrefs", () => {
  assert.ok(isSchemeHref("https://example.com"));
  assert.ok(isSchemeHref("mailto:a@b.c"));
  assert.ok(isSchemeHref("file:///D:/a.md"));
  assert.ok(!isSchemeHref("#anchor"));
  assert.ok(!isSchemeHref("./a.md"));
  assert.ok(!isSchemeHref("D:\\a.md"));
  assert.ok(isMarkdownPath("D:\\a\\b.MD"));
  assert.ok(isMarkdownPath("b.markdown"));
  assert.ok(!isMarkdownPath("b.txt"));
  assert.equal(extensionOf("D:\\a\\b.MD"), "md");
  assert.equal(extensionOf("noext"), "");
});

test("resolveRelativePath handles windows separators and backtracking", () => {
  assert.equal(resolveRelativePath(DOC, "a.md"), "D:\\Work\\docs\\guide\\a.md");
  assert.equal(resolveRelativePath(DOC, "./a/b.md"), "D:\\Work\\docs\\guide\\a\\b.md");
  assert.equal(resolveRelativePath(DOC, "../a.md"), "D:\\Work\\docs\\a.md");
  assert.equal(resolveRelativePath(DOC, "../../../../esc.md"), "D:\\esc.md", "回溯不能越过盘根");
  assert.equal(resolveRelativePath(DOC, "a.md#sec"), "D:\\Work\\docs\\guide\\a.md", "锚点不进入路径");
  assert.equal(resolveRelativePath(DOC, "file:///D:/x/y.md"), "D:\\x\\y.md");
  assert.equal(resolveRelativePath("D:/docs/a.md", "b.md"), "D:/docs/b.md", "分隔符跟随文档路径");
  assert.equal(resolveRelativePath("", "b.md"), "b.md");
});
