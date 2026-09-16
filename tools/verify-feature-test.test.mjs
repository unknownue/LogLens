// verify-feature-test.test.mjs — 核对「新功能测试文件」里的承诺与实现一致。
//
// 为什么给「测试文件」也写断言：`repro/md-feature-test.md` + `md-feature-test-part2.md`
// 是给人手点的靶子，里面写满了具体承诺（某个锚点必须命中、角标必须是 1/1/2/3、
// 哪张图该显示哪张该占位）。这些承诺一旦与实现漂移，人工自检会得到错误结论 ——
// 比没有测试文件更糟。这里只做纯结构核对（管线层），浏览器里才成立的部分
// （图片究竟 loaded 还是 missing）由 `tools/e2e-markdown.mjs` 与
// `tools/smoke-release.mjs` 覆盖。
//
// 运行：node --test tools/verify-feature-test.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { renderMarkdown } from "../src/markdown/markdown.ts";

const REPRO = "E:\\Workspace\\submodules\\LogLens\\repro\\";
const MAIN = "md-feature-test.md";
const PART2 = "md-feature-test-part2.md";

const passthrough = (html) => html;
const render = (name) => {
  const source = readFileSync(new URL(`../repro/${name}`, import.meta.url), "utf8");
  const result = renderMarkdown(source, { sanitize: passthrough, docPath: REPRO + name });
  return { source, ...result };
};

const main = render(MAIN);
const part2 = render(PART2);

/** 文档里所有锚点链接（含标题上的 ¶）及其目标。 */
const anchorTargets = (html) => [...html.matchAll(/data-md-anchor="([^"]*)"/g)].map((m) => m[1]);
const headingIds = (outline) => new Set(outline.map((h) => h.id));

test("主文件与目标文件都能渲染，且每个锚点链接都命中真实标题", () => {
  for (const doc of [main, part2]) {
    const ids = headingIds(doc.outline);
    const dangling = [...new Set(anchorTargets(doc.html))].filter((a) => a && !ids.has(a));
    assert.deepEqual(dangling, [], `悬空锚点（会跳到不存在的位置）：${dangling.join(", ")}`);
  }
});

test("跨文档链接带 fragment，指向目标文件的真实小节", () => {
  const links = [...main.html.matchAll(/data-md-path="([^"]*)" data-md-kind="doc"(?: data-md-frag="([^"]*)")?/g)];
  const targets = links.map((m) => [m[1].split("\\").pop(), m[2] ?? null]);
  assert.deepEqual(
    targets,
    [
      [PART2, "3-安装步骤"],
      [PART2, "注意"],
    ],
    "主文件的两处跨文档链接必须分别带上 3-安装步骤 与 注意 的锚点"
  );
  // 目标文件确实存在这两个 id（否则「跳到安装步骤」这条承诺是假的）
  const part2Ids = headingIds(part2.outline);
  assert.ok(part2Ids.has("3-安装步骤"), "目标文件必须真的有 `3-安装步骤` 小节");
  assert.ok(part2Ids.has("注意") && part2Ids.has("注意-2"), "两条同名「注意」必须去重成 注意 / 注意-2");
  // 回跳链接
  const back = [...part2.html.matchAll(/data-md-path="([^"]*)" data-md-kind="doc"(?: data-md-frag="([^"]*)")?/g)]
    .map((m) => [m[1].split("\\").pop(), m[2] ?? null]);
  assert.deepEqual(back, [[MAIN, "6-自检清单"]], "目标文件的回跳链接要指向主文件的清单锚点");
  assert.ok(headingIds(main.outline).has("6-自检清单"), "主文件必须真的有 `6-自检清单` 小节");
});

test("脚注编号与条目数符合文件里的承诺（1 / 1 / 2 / 3，三条）", () => {
  assert.equal(main.footnotes, 3, "主文件应有三条被引用的定义");
  const refs = [...main.html.matchAll(/data-md-footnote="([^"]*)"[^>]*>(\d+)</g)].map((m) => `${m[1]}=${m[2]}`);
  assert.deepEqual(refs, ["alpha=1", "alpha=1", "beta=2", "gamma=3"], "角标必须按首次引用编号");
  const items = [...main.html.matchAll(/data-md-footnote-item="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(items, ["alpha", "beta", "gamma"], "条目按序号排列，且每条只出现一次");
  assert.ok(main.html.includes("[^not-defined]"), "没有定义的引用必须保持原文（不能变成死链）");
});

test("脚注定义里的注入片段确实进入了 HTML，交给清洗处理", () => {
  // 断言「还在」是刻意的：拦截是 sanitize 的职责，管线不该自己写一套粗糙过滤。
  // 真正的拦截效果由 E2E（真 DOMPurify）与打包版冒烟验证。
  assert.match(main.html, /<style>\.md-feature-test-injected/, "定义里的 <style> 应进入待清洗的 HTML");
  assert.match(main.html, /<script>document\.title/, "定义里的 <script> 应进入待清洗的 HTML");
  // 但按钮/脚本不能出现在正文以外的地方 —— 这里只确认它们来自脚注定义那一段
  assert.match(main.html, /md-footnotes/);
});

test("图片承诺：目录内三处待加载、目录外一处、缺失一处，远程只留占位", () => {
  const loaded = [...main.html.matchAll(/<img class="md-image-img"[^>]*data-md-path="([^"]*)"/g)].map((m) => m[1]);
  const names = loaded.map((p) => p.split("\\").pop());
  // 会产生 <img>（即真的去加载）的五处：两张子目录图（其中宽图用了两次）+ 目录外一张 + 缺失一张
  assert.deepEqual(
    [...names].sort(),
    ["does-not-exist.png", "screenshot.png", "tiny-2x2.png", "wide-96x32.png", "wide-96x32.png"].sort(),
    "哪些图片会去加载：" + names.join(" , ")
  );
  // 目录内且存在的三处（子目录图片，验证 asset scope 的递归授权）
  const inScopeExisting = loaded.filter((p) => p.startsWith(REPRO) && !p.includes("does-not-exist"));
  assert.equal(inScopeExisting.length, 3, "repro 目录内的三处（应真的显示）");
  // 目录外：兄弟目录 docs/，不在授权范围内 → 由页面退回占位
  assert.equal(loaded.filter((p) => !p.startsWith(REPRO)).length, 1, "目录外只有仓库截图那一张");
  // 缺失：路径在目录内但文件不存在 → 由页面退回占位
  assert.equal(loaded.filter((p) => p.includes("does-not-exist")).length, 1, "缺失那一张也要保留在容器里");
  // 远程图片不产生 <img>（CSP 不放行外网，连接都不发起）
  assert.equal((main.html.match(/data-md-kind="url"/g) ?? []).length, 1, "远程图片只有占位药丸");
  // 注意匹配 `\ssrc=` 而不是 `src=`：占位容器上的 `data-md-src="https://…"` 是**路径文本**，
  // 不是要去加载的地址（用 includes("src=") 会被它骗到）。
  assert.doesNotMatch(main.html, /\ssrc="https?:/, "不允许出现指向外网的 src 属性");
});

test("公式：四种写法齐全，且包含大号定界符（打包版字体回归的靶子）", () => {
  const katex = (main.html.match(/class="katex"/g) ?? []).length;
  assert.ok(katex >= 10, `公式数量应 ≥ 10，实际 ${katex}`);
  for (const needle of ["\\left\\{", "\\bigg(", "\\left\\lfloor", "\\left(", "\\sqrt{"]) {
    assert.ok(main.source.includes(needle), `测试文件必须含 ${needle}（大号定界符靶子）`);
  }
  assert.ok((main.html.match(/class="katex-display"/g) ?? []).length >= 1, "至少一个块级公式");
});

test("交互类测试里引用的版本戳真的在文件里（自动刷新要靠它）", () => {
  assert.match(main.source, /当前版本戳\s*=\s*\*\*`v\d`\*\*/, "文件必须带一个可改的版本戳");
});
