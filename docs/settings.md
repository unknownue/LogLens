# 设置页与字体定制（settings）

工具栏最右侧的齿轮（或首行左侧总菜单的「设置…」）打开一个模态设置页：

```
外观   主题（深色 / 浅色）、界面语言（中文 / English）
字体   非中文字体、中文字体（各带搜索框）、实际字体栈
      正文字号（10–20px 滑块，与工具栏 A-/A+ 同一个值）
预览   日志视图 / Markdown 视图 / 表格视图 三段实时样例
```

改动**立即生效并持久化**，没有「确定 / 取消」：设置项都是可逆的即时观感调整，
所见即所得比两段式确认更好用；底部「恢复默认设置」回到出厂值。

## 字体列表从哪来（本机所有字体，不是写死的候选表）

字体下拉列的是**本机所有可用字体**：后端命令 `list_system_fonts` 走 DirectWrite 的
系统字体集（`src-tauri/src/fonts.rs`），返回 `{ family, display, aliases, cjk, mono }[]`。
（参考值：Windows 10 + Office 的常见机器约 260–330 个 family。）

| 字段 | 来源 | 用途 |
|------|------|------|
| `family` | 该族的 en-us 名（缺了用第一条本地化名） | 写进 CSS 的 `font-family` |
| `display` | 界面语言对应的本地化名 | 中文界面下显示「微软雅黑」——用户是照着系统界面找名字的 |
| `aliases` | 除 `display` 外**其它**本地化名 | 跨语言搜索：英文界面下按「雅黑」也要搜得到 |
| `cjk` | `IDWriteFont::HasCharacter`（中、汉） | 分组到「含中文字形」 |
| `mono` | `IDWriteFont1::IsMonospacedFont` | 分组到「等宽字体」 |

为什么是 DirectWrite：

- **完整**：扫 `%WINDIR%\Fonts` 会漏掉装在用户目录或注册在其它路径的字体，而且拿到的是
  文件名（`msyh.ttc`）；读注册表拿到的是显示名（`微软雅黑 & Microsoft YaHei & … (TrueType)`），
  还得自己拆解。DirectWrite 的系统字体集就是 **WebView2（Chromium）取字体用的同一份集合** ——
  列出来的都能用。
- **事实准确**：`cjk` 必须问字体自己。**汉字在所有中文字体里都是一个 em 宽**，在页面上用
  canvas 量宽度对中文字体毫无区分度（中文字体与「查无此字体」量出来一样宽）。早期版本
  在浏览器里探测这两个事实，结果把所有中文字体都归进了「等宽 / 其它」组 —— 这正是
  `choicesFromSystem` 只做纯映射、不做任何探测的原因。

列表是两三百项，所以每个字体项上面配了搜索框：`family` / `display` / `aliases` 三者
都参与匹配，中文名（「雅黑」）与英文名（`yahei`）在任何界面语言下都能搜到
（英文界面下展示名是 `Microsoft YaHei`，中文名就只剩在 `aliases` 里）；大小写与空格
不敏感；搜不到时明确提示「没有匹配…」，而不是让下拉空着。

后端不可用时（浏览器复现环境、命令失败）自动回落到内置候选表
（`font-catalog.ts` 的 `LATIN_FONT_OPTIONS` / `CJK_FONT_OPTIONS`）：候选表本来就按角色
分成两份，所以「是否自带中文字形」等于「在哪一份里」，同样是**已知事实**而非探测；
右侧计数会写明「内置候选（未连上后端）」。

候选表仍然有用：候选表之外还有「自定义…」，可以手输任意 `font-family` 名
（逗号分隔可写多族栈）。

## 为什么要把字体分成「非中文」和「中文」两份

浏览器给一段文本挑字体是**逐字符**回退的：它沿 `font-family` 列表从第一项往后走，
谁能画出这个字符就用谁。于是「西文用 Consolas、中文用微软雅黑」不需要声明
`unicode-range`，只要把两份字体按顺序拼成一条列表：

```css
font-family: "Consolas", "Cascadia Mono", "Courier New",   /* 非中文字体（不含 CJK 字形） */
             "Microsoft YaHei UI", "Microsoft YaHei", …     /* 中文字体 */
             monospace;                                     /* 通用族兜底 */
```

- 西文字符命中 `Consolas`（`Consolas` / `Cascadia Mono` / `Courier New` 都没有中文字形）；
- 中文字符跳过前面所有纯西文字体，落到中文字体；
- 中英混排的一行里两种字形各走各的字体 —— 这正是终端类工具的做法（Windows Terminal 同理）。

**唯一的前提**：排在前面的非中文字体自己不能带中文字形（比如把「微软雅黑」当成非中文字体），
否则中文会被它先吃掉、中文字体设置看起来「没生效」。设置页对此有两条实时提示：

| 提示 | 触发条件 | 含义 |
|------|---------|------|
| 该字体自带中文字形… | 非中文字体提供了 CJK 字形 | 中文也会用这个字体渲染 |
| 比例字体：列对齐与表格列宽只能按估算值处理 | 非中文字体不是等宽 | 见下面的「已知近似」 |
| 未检测到该字体… | 列表里没有这个名字 | 实际渲染会回落到字体栈里后面的字体 |

分组是**事实分组**，不是推荐排序（顺序即「能不能当非中文字体用」）：

| 分组 | 条件 |
|------|------|
| 等宽字体 | 等宽且不含中文字形 —— 日志 / 表格列对齐的首选 |
| 含中文字形 | 自带中文字形（含「更纱黑体」这类中文等宽） |
| 其它字体 | 其余比例字体 |

把「微软雅黑」这类字体选进非中文字体时，提示会直说「中文也会用它渲染」——
比让用户以为中文字体设置没生效要好。

**只用系统已安装的字体**，不加载字体文件 —— 桌面工具没必要为字体引入资源与 CSP 负担
（`tauri.conf.json` 的 `font-src 'self'` 也印证了这一点）。

## 统一应用到所有视图的做法

一条 CSS 变量链，而不是给每个视图各写一遍字体：

| 位置 | 内容 |
|------|------|
| `src/App.css` 的 `:root` | `--font-latin` / `--font-cjk` / `--font-stack: var(--font-latin), var(--font-cjk), monospace` |
| `src/settings/settings.ts` | `applyFontSettings()` 把前两个变量写到 **`document.documentElement`** 上 |
| 各视图样式表 | 字体一律写 `font-family: var(--font-stack)`（不再硬编码字体族） |

消费这条链的地方：

| 视图 | 规则 |
|------|------|
| 日志正文 | `.row`（`App.css`） |
| 复制视图弹窗 | `.body-modal-line`（与日志正文同口径） |
| 表格视图 | `.cfg-scroll`（`CfgTableTab` 的容器，单元格继承） |
| Markdown 正文 | `.md-body` |
| Markdown 源码视图 | `.md-source` |
| Markdown 行内代码 / 代码块 | `.md-body code` / `.md-body pre.md-pre code` |
| 界面本身（菜单、标签栏、设置页…） | `:root` 的 `font-family` |

写在 `<html>` 上而不是 `.loglens` 容器上是有原因的：应用菜单、tab 右键菜单、拖拽 ghost
都是 `createPortal` 到 `document.body` 的，它们在 `.loglens` 之外，写在容器上它们拿不到新字体。

> **唯一刻意不跟随的是公式**：Markdown 里的 LaTeX（KaTeX）用的是 KaTeX 自带的数学字体
> （`KaTeX_Main`，随 katex.min.css 一起打包），数学字形与正文字体本就该分开 ——
> 换成正文字体反而会让上下标、积分号等排版走样。需要改数学字体属于另一个话题。

正文字号沿用既有的 `--log-font-size`（由 App 内联在 `.loglens` 上），日志 / 表格 /
Markdown 三处共用，因此工具栏的 A-/A+ 与设置页的滑块改的是同一个值。

## 文件与职责

| 文件 | 职责 |
|------|------|
| `src/settings/font-catalog.ts` | 内置候选表 + 族名归一化 / 字体栈拼装（**纯逻辑**，Node 可直接单测） |
| `src/settings/font-options.ts` | 下拉的选项模型：系统字体 → 选项的纯映射、分组、搜索过滤、展示名（**纯逻辑**） |
| `src/settings/system-fonts.ts` | 向后端要系统字体列表（`list_system_fonts`），失败降级为 `null` |
| `src/settings/settings.ts` | 设置模型：读写 `localStorage`、旧键迁移、写入 CSS 变量（纯逻辑为主） |
| `src/settings/font-probe.ts` | canvas 探测：手输字体的**是否安装**（等宽 / 中文字形由后端事实优先，探测只作兜底） |
| `src/settings/SettingsModal.tsx` | 设置模态框（自带中英文案，与 `src/views` 下的页面同一约定） |
| `src/settings/settings.css` | 模态框样式（预览区刻意复用各视图的字号变量与边框口径） |
| `src-tauri/src/fonts.rs` | 后端：DirectWrite 枚举系统字体 + 本地化名挑选（挑名规则为纯函数，有单测） |
| `src/settings/index.ts` | 模块出口（App 只 import 它） |

## 持久化与迁移

| 键 | 内容 |
|----|------|
| `lv-settings` | `{ latinFont, cjkFont, fontSize }`（字体存**族列表字符串**，空串 = 内置默认） |
| `lv-fontsize` | 旧版本的标量字号：**只读**。读不到 `lv-settings` 时迁进 `fontSize`，随后写入新键 |

容错是逐字段的：存档被写脏时，坏掉的字段回落到默认值，其余字段照常保留 ——
不会因为一个字段非法就把用户的字体 / 字号一起清掉。族名还会在写入与读出时各归一化一次
（去引号、折叠空白、剥掉通用族、限制条数与长度），保证畸形输入进不了 CSS。

## 已知近似（等宽字体假设）

日志虚拟滚动的行宽估算与表格列宽估算用的是「字符数 × 字宽」的比例模型
（`metricsForFontSize` / `cfg-columns.ts` 的 `fontSize × 0.55` 半角、`× 1.1` 全角），
它假定正文字体等宽。选比例字体后：

- 日志视图的水平滚动宽度、折行行高仍是估算值（滚动本身是虚拟化的，不受影响）；
- 表格列宽按估算值定宽，超长单元格照旧用省略号截断（列宽上限 600px）；
- 字符对齐（等宽下天然对齐的列）不再对齐。

因此设置页在选中非等宽字体时会明确提示这一点，而不是假装无事发生。
若要做精确估算，得改成 canvas 实测字宽并让比例随字体变化 —— 目前不值得为此增加复杂度。

## 验证

```powershell
cd src-tauri && cargo test --lib fonts          # DirectWrite 枚举 + 挑名规则
node --test tools/verify-settings.test.mjs      # 纯规则 + CSS 一致性（不需要浏览器）
node tools/e2e-settings.mjs --launch            # 真实浏览器 E2E（先 pnpm run dev）
```

后端 `src-tauri/src/fonts.rs` 的单测分两层：挑名规则是纯函数（构造的本地化名输入，
不依赖机器）；系统字体集那两条是**集成断言**，只断言结构性事实（数量 ≥ 20、无重名、
等宽 / 非等宽 / 带中文字形 / 不带中文字形各有其类），再对 Consolas / SimSun / Arial
这类「装了才断言」的字体核对事实 —— 不断言具体字体清单，换台机器也能跑。带上
`-- --nocapture` 会打印本机分布（如 `267 个：等宽 15 / 含中文字形 74 / 其它 178`），
排障时先看这行。

`verify-settings.test.mjs` 里最值钱的是 **CSS 一致性**那几条：任何样式表再出现硬编码的
`font-family`（而不是 `var(--font-…)` / `inherit`）都会失败 —— 那正是「某个视图不跟随设置」
的根因；`App.css` 里 `--font-latin` / `--font-cjk` 的初值也必须与 `font-catalog.ts`
的默认值逐字符一致。另外它还会卡住「选项模型里不许出现 canvas 探测」——
`font-options.ts` 只做纯映射，字体事实一律来自后端（见上文「事实准确」那段踩过的坑）。

`e2e-settings.mjs` 分两层断言字体是否真的生效：

1. **CSS 层**：计算样式里的 `font-family` 是否包含所选字体、中文是否排在西文之后；
2. **渲染层**：用元素自己的计算字体在 canvas 上量一段西文样本，与该字体单独量的宽度比对 ——
   宽度一致才说明这些字形真的是那个字体画的，而不只是样式表里写着。

> 中文侧做不到同样的宽度判据：所有中文字体的全角汉字都是一个 em 宽，换字体只变字形、
> 不变宽度。所以中文以「顺序 + 已安装 + 计算样式」为准，汉字墨迹高度只作为观测值打印。

E2E 里的后端是 mock 的，`list_system_fonts` 返回一份**固定的小字体集**
（含等宽 / 比例 / 中文字形三类），因此列表内容、分组计数（2/2/1）、搜索命中
（中文名与英文名各搜一次）都是确定性的断言。真实系统字体集由后端的集成测试覆盖。

覆盖的场景：工具栏齿轮打开设置页 → 字体列表来自后端（条数 / 分组计数 / 中英文名搜索 /
英文界面下按中文名搜索 / 搜不到的提示）→ 选 `Courier New` + `SimSun` → 字号滑块（含旧键迁移）→
日志 / Markdown 正文 / Markdown 源码 / 表格单元格四处统一生效（含 portal 到 body 的菜单）→
刷新页面后仍在 → 恢复默认回到内置字体栈。

> E2E 跑在 Vite dev server 的浏览器里，**没有真后端**，字体列表是 mock 的。真实系统字体集
> 由两处覆盖：后端 `cargo test --lib fonts` 的集成断言，以及打包版人工确认
> （`make loglens-build` 后打开设置页，本机显示 267 个 family：等宽 15 / 含中文字形 74 / 其它 178）。
