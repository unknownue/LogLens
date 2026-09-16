// verify-settings.test.mjs — 设置页（字体定制 / 字号）的规则检查。
//
// 三类断言：
//   1. 纯函数：字体族归一化、字体栈拼装、设置解析与旧键迁移（不需要浏览器）；
//   2. 字体下拉的选项模型：分组 / 搜索过滤 / 展示名（纯逻辑，见 src/settings/font-options.ts）；
//   3. **CSS 一致性**（「统一应用到各种视图」的回归保护）：
//      - App.css 里 --font-latin / --font-cjk 的初值必须与 font-catalog.ts 的默认值一致；
//      - 任何样式表都不许再硬编码 font-family 字体族（只能用 var(--font-…) / inherit），
//        否则那个视图就会「不跟随设置」；
//      - 日志 / 表格 / Markdown 三个视图的关键规则必须显式引用 --font-stack。
//
// 运行：node --test tools/verify-settings.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CJK_FONT_OPTIONS,
  DEFAULT_CJK_FAMILIES,
  DEFAULT_LATIN_FAMILIES,
  LATIN_FONT_OPTIONS,
  buildFamilyList,
  buildFontStack,
  fontOptions,
  isCatalogFamily,
  isGenericFamily,
  normalizeFamily,
  parseFamilyList,
  quoteFamily,
} from "../src/settings/font-catalog.ts";
import {
  buildFontGroups,
  catalogChoices,
  choicesFromSystem,
  filterChoices,
  findChoice,
  matchesQuery,
  normalizeQuery,
  optionLabel,
  sameFamily,
} from "../src/settings/font-options.ts";
import {
  DEFAULT_SETTINGS,
  FONT_SIZE_DEFAULT,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  SETTINGS_KEY,
  applyFontSettings,
  clampFontSize,
  parseSettings,
  readSettings,
  resolveFontStack,
  writeSettings,
} from "../src/settings/settings.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

/** 读一个源文件。 */
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

/** 递归收集 src 下所有 .css。 */
function cssFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...cssFiles(full));
    } else if (name.endsWith(".css")) {
      out.push(full);
    }
  }
  return out;
}

/** 取一个选择器的规则体（`选择器 { ... }`，不含嵌套——本项目的 CSS 不嵌套）。 */
function ruleBody(css, selector) {
  const re = new RegExp(
    selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}",
    "m"
  );
  const m = css.match(re);
  return m ? m[1] : null;
}

/** 取一个自定义属性的值（`:root` 上的 `--name: value;`）。 */
function cssVar(css, name) {
  const re = new RegExp(`--${name}\\s*:\\s*([^;]+);`);
  const m = css.match(re);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

// ==================== 1. 字体族归一化 ====================

test("family names are trimmed, unquoted and whitespace-collapsed", () => {
  assert.equal(normalizeFamily("  Consolas  "), "Consolas");
  assert.equal(normalizeFamily('"Sarasa Mono SC"'), "Sarasa Mono SC");
  assert.equal(normalizeFamily("'JetBrains Mono'"), "JetBrains Mono");
  assert.equal(normalizeFamily("Microsoft   YaHei"), "Microsoft YaHei");
  assert.equal(normalizeFamily(""), "");
  assert.equal(normalizeFamily(undefined), "");
});

test("absurdly long family names are capped (corrupted localStorage must not reach CSS)", () => {
  const long = "x".repeat(500);
  assert.ok(normalizeFamily(long).length <= 64);
});

test("a comma separated list is split, de-duplicated and stripped of generics", () => {
  assert.deepEqual(parseFamilyList("Consolas, Courier New"), ["Consolas", "Courier New"]);
  // 全角逗号（中文输入法下最常见的输入）
  assert.deepEqual(parseFamilyList("微软雅黑，Sarasa Mono SC"), ["微软雅黑", "Sarasa Mono SC"]);
  // 大小写不同的同一族只留第一条；通用族由 buildFontStack 统一补在末尾
  assert.deepEqual(parseFamilyList("consolas, Consolas, monospace"), ["consolas"]);
  assert.deepEqual(parseFamilyList(" , , "), []);
  assert.deepEqual(parseFamilyList("Microsoft YaHei, noto sans cjk sc"), [
    "Microsoft YaHei",
    "noto sans cjk sc",
  ]);
});

test("generic families are recognised without quotes", () => {
  assert.equal(isGenericFamily("monospace"), true);
  assert.equal(isGenericFamily(" Sans-Serif "), true);
  assert.equal(isGenericFamily("Consolas"), false);
  assert.equal(isGenericFamily("微软雅黑"), false);
});

test("family names get CSS quotes, generic keywords stay bare", () => {
  // 统一加引号：生成的字体栈与 App.css 里的手写默认值逐字符一致（见下面的 CSS 断言）
  assert.equal(quoteFamily("Consolas"), '"Consolas"');
  assert.equal(quoteFamily("Courier New"), '"Courier New"');
  assert.equal(quoteFamily("Sarasa Mono SC"), '"Sarasa Mono SC"');
  // 中文字体名必须加引号，否则 CSS 会按标识符解析
  assert.equal(quoteFamily("微软雅黑"), '"微软雅黑"');
  // 通用族关键字加引号就失去含义了
  assert.equal(quoteFamily("monospace"), "monospace");
  assert.equal(quoteFamily(""), "");
});

// ==================== 2. 字体栈拼装 ====================

test("an empty setting falls back to the built-in default lists", () => {
  assert.equal(
    buildFamilyList("", DEFAULT_LATIN_FAMILIES),
    '"Consolas", "Cascadia Mono", "Courier New"'
  );
  assert.equal(
    buildFamilyList("", DEFAULT_CJK_FAMILIES),
    '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC"'
  );
  assert.equal(buildFamilyList("   ", DEFAULT_CJK_FAMILIES), buildFamilyList("", DEFAULT_CJK_FAMILIES));
});

test("the font stack puts non-CJK first, CJK second and the generic family last", () => {
  const stack = buildFontStack("Courier New", "微软雅黑");
  assert.equal(stack, '"Courier New", "微软雅黑", monospace');
  // 顺序即优先级：非中文字体必须在前，否则中文字体里的西文字形会先命中
  assert.ok(stack.indexOf("Courier New") < stack.indexOf("微软雅黑"));
  assert.ok(stack.endsWith("monospace"));
});

test("the font stack de-duplicates across the two roles", () => {
  // 更纱黑体同时含中西文字形：用户两边填同一个字体时只应出现一次
  assert.equal(buildFontStack("Sarasa Mono SC", "Sarasa Mono SC"), '"Sarasa Mono SC", monospace');
});

test("an empty font stack falls back to both default lists", () => {
  assert.equal(
    buildFontStack("", ""),
    '"Consolas", "Cascadia Mono", "Courier New", "Microsoft YaHei UI", "Microsoft YaHei", ' +
      '"PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", monospace'
  );
});

test("a generic family typed by the user is not duplicated in the middle", () => {
  const stack = buildFontStack("Consolas", "monospace");
  assert.equal(stack, '"Consolas", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", ' +
    '"Noto Sans CJK SC", "Source Han Sans SC", monospace');
});

test("catalog lookups are case-insensitive and role-aware", () => {
  assert.equal(isCatalogFamily("latin", "consolas"), true);
  assert.equal(isCatalogFamily("latin", "Microsoft YaHei"), false);
  assert.equal(isCatalogFamily("cjk", "Microsoft YaHei"), true);
  assert.equal(isCatalogFamily("cjk", "NotARealFont"), false);
  assert.ok(fontOptions("latin").every((o) => typeof o.mono === "boolean"));
  assert.ok(LATIN_FONT_OPTIONS.length > 0 && CJK_FONT_OPTIONS.length > 0);
});

// ==================== 3. 设置解析 / 迁移 / 持久化 ====================

test("garbage settings fall back per field instead of wiping everything", () => {
  // 存档被写坏：字体字段非法只丢字体，字号仍然可用
  assert.deepEqual(parseSettings("not an object"), { ...DEFAULT_SETTINGS });
  assert.deepEqual(parseSettings(null, 17), {
    latinFont: "",
    cjkFont: "",
    fontSize: 17,
  });
  assert.deepEqual(parseSettings({ latinFont: 42, cjkFont: null, fontSize: "abc" }), {
    ...DEFAULT_SETTINGS,
  });
});

test("font values are normalised on the way in and out", () => {
  const s = parseSettings({ latinFont: ' "Consolas" , monospace ', cjkFont: "微软雅黑" });
  assert.equal(s.latinFont, "Consolas");
  assert.equal(s.cjkFont, "微软雅黑");
});

test("font size is clamped to the toolbar range", () => {
  assert.equal(clampFontSize(12), 12);
  assert.equal(clampFontSize(0), FONT_SIZE_MIN);
  assert.equal(clampFontSize(999), FONT_SIZE_MAX);
  assert.equal(clampFontSize(12.6), 13);
  assert.equal(clampFontSize(Number.NaN), FONT_SIZE_DEFAULT);
  assert.equal(clampFontSize("nope"), FONT_SIZE_DEFAULT);
  assert.equal(parseSettings({ fontSize: 3 }).fontSize, FONT_SIZE_MIN);
  assert.equal(parseSettings({ fontSize: 400 }).fontSize, FONT_SIZE_MAX);
});

test("the legacy lv-fontsize key is migrated only when the new key has no size", () => {
  // 老版本只存了字号：升级后字号要保住
  assert.equal(parseSettings(null, 16).fontSize, 16);
  // 新键里有字号时以它为准（老键只是残留）
  assert.equal(parseSettings({ fontSize: 11 }, 16).fontSize, 11);
});

test("settings storage degrades quietly without a browser", () => {
  // Node 里没有 localStorage：读要拿到默认值，写要静默失败而不是抛异常
  assert.deepEqual(readSettings(), { ...DEFAULT_SETTINGS });
  assert.doesNotThrow(() => writeSettings({ latinFont: "Consolas", cjkFont: "", fontSize: 14 }));
  // 没有 document 时应用字体必须是无害的空操作
  assert.doesNotThrow(() => applyFontSettings({ ...DEFAULT_SETTINGS }));
  assert.equal(SETTINGS_KEY, "lv-settings");
});

test("the resolved stack is what the modal shows", () => {
  assert.equal(
    resolveFontStack({ latinFont: "Consolas", cjkFont: "SimSun", fontSize: 12 }),
    '"Consolas", "SimSun", monospace'
  );
});

// ==================== 4. CSS 一致性（「统一应用到各种视图」的回归保护） ====================

const APP_CSS = read("src/App.css");
const MD_CSS = read("src/markdown/markdown.css");

test("App.css declares the font variables with exactly the built-in defaults", () => {
  assert.equal(cssVar(APP_CSS, "font-latin"), buildFamilyList("", DEFAULT_LATIN_FAMILIES));
  assert.equal(cssVar(APP_CSS, "font-cjk"), buildFamilyList("", DEFAULT_CJK_FAMILIES));
  assert.equal(
    cssVar(APP_CSS, "font-stack"),
    "var(--font-latin), var(--font-cjk), monospace"
  );
});

// ==================== 3b. 字体下拉的选项模型（系统字体 / 搜索 / 分组） ====================

/** 造一个下拉选项。 */
const choice = (family, display, mono, cjk, aliases = []) => ({
  family,
  display,
  mono,
  cjk,
  aliases,
});

test("options are grouped by the two facts that matter: monospace and CJK coverage", () => {
  const groups = buildFontGroups(
    [
      choice("Consolas", "Consolas", true, false),
      choice("Arial", "Arial", false, false),
      choice("Microsoft YaHei", "微软雅黑", false, true),
      choice("Sarasa Mono SC", "更纱黑体 SC", true, true),
      choice("Courier New", "Courier New", true, false),
    ],
    "zh"
  );
  assert.deepEqual(
    groups.map((g) => g.key),
    ["mono", "cjk", "other"],
    "分组顺序固定：等宽 → 含中文字形 → 其它"
  );
  const byKey = Object.fromEntries(groups.map((g) => [g.key, g.choices.map((c) => c.family)]));
  assert.deepEqual([...byKey.mono].sort(), ["Consolas", "Courier New"]);
  // 含中文字形的等宽字体归到「含中文字形」：它当非中文字体会连中文一起接管
  assert.deepEqual([...byKey.cjk].sort(), ["Microsoft YaHei", "Sarasa Mono SC"]);
  assert.deepEqual(byKey.other, ["Arial"]);
});

test("empty groups are not emitted (the dropdown must not show empty headings)", () => {
  const groups = buildFontGroups([choice("Consolas", "Consolas", true, false)]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, "mono");
  assert.deepEqual(buildFontGroups([]), []);
});

test("search matches both the CSS family and the localized display name", () => {
  const yahei = choice("Microsoft YaHei", "微软雅黑", false, true);
  // 中文界面下按中文名搜
  assert.equal(matchesQuery(yahei, "雅黑"), true);
  // 按英文名搜（忽略大小写与空格）
  assert.equal(matchesQuery(yahei, "yahei"), true);
  assert.equal(matchesQuery(yahei, "MICROSOFT YAHEI"), true);
  assert.equal(matchesQuery(yahei, "microsoftyahei"), true);
  assert.equal(matchesQuery(yahei, "consolas"), false);
  // 空搜索词 = 不过滤
  assert.equal(matchesQuery(yahei, "  "), true);
  assert.equal(normalizeQuery("  Microsoft  YaHei "), "microsoftyahei");
});

test("search also matches the other localized names (cross-language)", () => {
  // 英文界面：展示名是 Microsoft YaHei，中文名只剩在别名里 ——
  // 用户在系统里认的是「雅黑」，切成英文界面后照样要能搜到。
  const en = choice("Microsoft YaHei", "Microsoft YaHei", false, true, ["微软雅黑"]);
  assert.equal(matchesQuery(en, "雅黑"), true);
  assert.equal(matchesQuery(en, "微软"), true);
  // 反过来：中文界面下别名是英文名
  const zh = choice("Microsoft YaHei", "微软雅黑", false, true, ["Microsoft YaHei"]);
  assert.equal(matchesQuery(zh, "yahei"), true);
  // 没有别名字段时不能炸（老后端 / 手写的 mock）
  assert.equal(matchesQuery(choice("Consolas", "Consolas", true, false), "consolas"), true);
});

test("filtering narrows the list and keeps the original order", () => {  const choices = [
    choice("Consolas", "Consolas", true, false),
    choice("Courier New", "Courier New", true, false),
    choice("SimSun", "宋体", false, true),
  ];
  assert.equal(filterChoices(choices, "").length, 3);
  assert.deepEqual(filterChoices(choices, "cou").map((c) => c.family), ["Courier New"]);
  assert.deepEqual(filterChoices(choices, "宋").map((c) => c.family), ["SimSun"]);
  assert.deepEqual(filterChoices(choices, "zzz"), []);
  // 不改动入参（纯函数）
  assert.equal(choices.length, 3);
});

test("the option label carries the CSS name when it differs from the localized one", () => {
  assert.equal(optionLabel(choice("Microsoft YaHei", "微软雅黑", false, true)), "微软雅黑（Microsoft YaHei）");
  assert.equal(optionLabel(choice("Consolas", "Consolas", true, false)), "Consolas");
  // 本地化名缺失时退回 family，不能出现空标签
  assert.equal(optionLabel(choice("SomeFace", "", false, false)), "SomeFace");
});

test("the current value is recognised regardless of quotes and case", () => {
  const choices = [choice("Courier New", "Courier New", true, false)];
  assert.ok(findChoice(choices, "courier new"));
  assert.ok(findChoice(choices, '"Courier New"'));
  assert.equal(findChoice(choices, "Consolas"), undefined, "不在候选里 = 走「自定义」");
  assert.equal(sameFamily("", ""), false, "空值不算命中（否则下拉会显示成空项）");
});

test("a value outside the list falls back to the custom input", () => {
  // 下拉里没有的非候选字体（用户手输的多族栈也算）：必须能落回自定义输入，
  // 否则用户之前存下的字体名会在设置页里「消失」。
  const choices = [choice("Consolas", "Consolas", true, false)];
  assert.equal(findChoice(choices, "My Handmade Mono"), undefined);
  assert.equal(findChoice(choices, "Consolas, Courier New"), undefined);
});

test("the system font list maps straight onto options (facts come from the backend)", () => {
  const choices = choicesFromSystem([
    { family: "Consolas", display: "Consolas", cjk: false, mono: true },
    // 中文名与 CSS 名不同：展示名要带上 CSS 名，报告里也能照着复制
    { family: "SimSun", display: "宋体", cjk: true, mono: false, aliases: ["SimSun"] },
    // 后端字段缺失（老版本后端 / mock）：按「未知 = false」处理，不能崩
    { family: "Mystery" },
  ]);
  assert.deepEqual(choices[0], {
    family: "Consolas",
    display: "Consolas",
    aliases: [],
    mono: true,
    cjk: false,
  });
  assert.equal(optionLabel(choices[1]), "宋体（SimSun）");
  assert.deepEqual(choices[1].aliases, ["SimSun"]);
  assert.equal(choices[2].cjk, false);
  assert.equal(choices[2].mono, false);
  assert.deepEqual(choices[2].aliases, []);
  assert.equal(choices[2].display, "Mystery", "展示名缺失时退回 family");
});

test("the fallback catalog is split by role, so its facts are known without probing", () => {
  // 浏览器复现环境（没有后端）：拉丁候选表里没有中文字形，中文候选表里都有。
  const latin = catalogChoices("latin", "zh");
  const cjk = catalogChoices("cjk", "zh");
  assert.ok(latin.length > 0 && cjk.length > 0);
  assert.ok(latin.every((c) => !c.cjk), "拉丁候选不该被标成自带中文字形");
  assert.ok(cjk.every((c) => c.cjk), "中文候选都该被标成自带中文字形");
  // 中文候选表里的等宽字体（更纱黑体等）要保住等宽标记
  assert.ok(cjk.some((c) => c.mono), "中文候选里应保留等宽标记");
  // 分组结果与系统字体路径一致（同一套分组规则）
  const groups = buildFontGroups(latin, "zh");
  assert.deepEqual(groups.map((g) => g.key), ["mono", "other"]);
});

test("no stylesheet hard-codes a font family any more", () => {
  // 硬编码 font-family 的后果：那条规则不会跟随设置页 —— 正是本功能要消灭的东西。
  // 允许的写法只有 var(--font-…)（跟随设置）与 inherit（跟随父元素）。
  const offenders = [];
  for (const file of cssFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    text.split(/\r?\n/).forEach((line, i) => {
      const m = line.match(/font-family\s*:\s*([^;]+);/);
      if (!m) {
        return;
      }
      const value = m[1].trim();
      if (!/^var\(--font-[a-z-]+\)$/.test(value) && value !== "inherit") {
        offenders.push(`${relative(ROOT, file).replace(/\\/g, "/")}:${i + 1} → ${value}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "这些 font-family 不跟随设置页：要么用 var(--font-stack)，要么用 inherit\n" + offenders.join("\n")
  );
});

test("the log view follows the setting", () => {
  // 日志行 + 复制视图弹窗里的两种行样式
  for (const selector of [".row", ".body-modal-line"]) {
    const body = ruleBody(APP_CSS, selector);
    assert.ok(body, `App.css 里找不到 ${selector}`);
    assert.match(body, /font-family:\s*var\(--font-stack\)/, `${selector} 未跟随设置页字体`);
  }
});

test("the table view follows the setting", () => {
  const body = ruleBody(APP_CSS, ".cfg-scroll");
  assert.ok(body, "App.css 里找不到 .cfg-scroll");
  assert.match(body, /font-family:\s*var\(--font-stack\)/, "表格视图未跟随设置页字体");
  assert.match(body, /font-size:\s*var\(--log-font-size\)/, "表格视图未跟随正文字号");
});

test("the markdown view follows the setting", () => {
  // 正文 / 源码视图 / 行内代码：三处都要跟随（其余元素继承 .md-body）
  for (const selector of [".md-body", ".md-source", ".md-body code"]) {
    const body = ruleBody(MD_CSS, selector);
    assert.ok(body, `markdown.css 里找不到 ${selector}`);
    assert.match(body, /font-family:\s*var\(--font-stack\)/, `${selector} 未跟随设置页字体`);
  }
});

test("every view uses the shared body font size as well", () => {
  // 字号统一走 --log-font-size（由 App 内联在容器上）：日志 / 表格 / Markdown 三处一致
  assert.match(ruleBody(APP_CSS, ".row"), /font-size:\s*var\(--log-font-size\)/);
  assert.match(ruleBody(MD_CSS, ".md-body"), /font-size:\s*var\(--log-font-size\)/);
});

// ==================== 5. 设置界面把两个角色都接上了 ====================

test("the settings modal edits both font roles and the shared font size", () => {
  const modal = read("src/settings/SettingsModal.tsx");
  assert.match(modal, /role="latin"/, "设置页缺少「非中文字体」项");
  assert.match(modal, /role="cjk"/, "设置页缺少「中文字体」项");
  assert.match(modal, /onChange\(\{\s*latinFont:/, "「非中文字体」没有接回设置状态");
  assert.match(modal, /onChange\(\{\s*cjkFont:/, "「中文字体」没有接回设置状态");
  assert.match(modal, /onChange\(\{\s*fontSize:/, "字号没有接回设置状态");
});

test("the app writes the font variables on <html> (portalled menus must follow too)", () => {
  const settings = read("src/settings/settings.ts");
  assert.match(
    settings,
    /document\.documentElement\.style|documentElement\.style\.setProperty/,
    "字体变量必须写在 documentElement 上，否则 portal 到 body 的菜单拿不到"
  );
  assert.match(settings, /--font-latin/);
  assert.match(settings, /--font-cjk/);
});

test("the settings modal is reachable from the toolbar and the app menu", () => {
  const app = read("src/App.tsx");
  assert.match(app, /className="icon-btn settings-btn"/, "工具栏缺少设置入口");
  assert.match(app, /appT\.settingsTitle/, "总菜单缺少设置项");
  assert.match(app, /<SettingsModal/, "App 未渲染设置模态框");
});

// ==================== 6. 字体列表来自系统（后端枚举），而不是写死的候选表 ====================

test("the modal asks the backend for the full system font list", () => {
  const modal = read("src/settings/SettingsModal.tsx");
  assert.match(modal, /loadSystemFonts\(lang\)/, "设置页没有去取系统字体列表");
  assert.match(modal, /choicesFromSystem\(props\.systemFonts\)/, "系统字体列表没有被用作下拉选项");
  // 拿不到后端时要有兜底，否则浏览器复现环境里下拉是空的
  assert.match(modal, /catalogChoices\(role, lang\)/, "缺少后端不可用时的候选表兜底");
  assert.match(modal, /className="settings-search"/, "长列表需要搜索框");
});

test("font facts come from the font tables, never from a browser-side guess", () => {
  // 汉字在所有中文字体里都是一个 em 宽 —— 页面上量宽度分不出「这是中文字体」。
  // 等宽 / 中文字形必须取自后端（DirectWrite），页面只做纯映射。
  const options = read("src/settings/font-options.ts");
  assert.match(options, /choicesFromSystem/, "缺少「系统字体 → 选项」的纯映射");
  assert.doesNotMatch(
    options,
    /isMonospaceFamily|familyProvidesCjk|canvas|measureText/,
    "选项模型不该在页面里探测字体事实（中文字形探测不可靠）"
  );
  const rust = read("src-tauri/src/fonts.rs");
  assert.match(rust, /HasCharacter/, "后端没有用 HasCharacter 判断中文字形覆盖");
  assert.match(rust, /IsMonospacedFont/, "后端没有用 IsMonospacedFont 判断等宽");
});

test("the frontend calls the backend command and degrades quietly", () => {
  const mod = read("src/settings/system-fonts.ts");
  assert.match(mod, /invoke<SystemFontInfo\[\]>\("list_system_fonts"/, "没有调用 list_system_fonts 命令");
  assert.match(mod, /catch\s*\{[\s\S]*return null;/, "命令失败必须降级为 null 而不是抛错");
});

test("the backend enumerates DirectWrite's system font collection", () => {
  const rust = read("src-tauri/src/fonts.rs");
  // 走 DirectWrite 的系统字体集：与 WebView2 取字体同一份集合，扫目录 / 读注册表都会漏
  assert.match(rust, /GetSystemFontCollection/, "没有用 DirectWrite 的系统字体集");
  assert.match(rust, /GetFamilyNames/, "没有取 family 的本地化名");
  // 命令要真的注册进 invoke_handler，否则前端调用会静默失败退回候选表
  const lib = read("src-tauri/src/lib.rs");
  assert.match(lib, /fn list_system_fonts\(/, "后端缺少 list_system_fonts 命令");
  assert.match(lib, /list_system_fonts\s*\n\s*\]\)/, "list_system_fonts 没有注册进 invoke_handler");
  const cargo = read("src-tauri/Cargo.toml");
  assert.match(cargo, /Win32_Graphics_DirectWrite/, "Cargo.toml 缺少 DirectWrite feature");
});
