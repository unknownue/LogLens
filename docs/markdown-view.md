# Markdown 预览视图（md-view）

`.md` / `.markdown` 文件默认以**文档形态**打开：GFM 表格、任务列表、代码高亮、
LaTeX 公式（KaTeX），外加右侧大纲与页内查找。本文记录它的选型、边界与已知取舍 ——
「为什么是这个样子」比「有哪些函数」更值得写下来。

## 一、页面在框架里的位置

正文区多页面框架（见 [body-views.md](body-views.md)）里的第 2 号页面：

| 优先级 | 页面 id | 命中条件 |
|-------|---------|---------|
| 100 | `file-missing` | 文件不存在（含被删的 .md） |
| **40** | **`md-view`** | `viewMode === "md"` |
| 32 | `csv-table` | `viewMode === "table"` 且扩展名不是 `.bin` |
| 30 | `cfg-table` | `viewMode === "table"` 且扩展名是 `.bin` |
| 20 | `open-error` | 权限 / IO 等通用失败（**文本视图下**才落到这里） |
| 0 | `text-log` | 兜底 |

两条刻意的排序理由：

- `md-view` 必须高于 `open-error`：Markdown 页自带「读取失败 + 重试」面板。读文件失败
  （被外部删掉、编码问题、权限）时留在原地重读，比被换成一行通用报错有用。
- `file-missing` 仍在最前面：Markdown 页没有内容可渲染时，就只是「文件不存在」这一件事。

视图模式三态（`text` / `md` / `table`）由 `TabInfo.viewMode` 表达，会话存档
（`lv-tabs` 的 `modes` 字段）会一起保存；**老存档没有 `modes`，按扩展名推断** ——
所以升级后第一次启动，之前打开过的 .md 文件也会自动进预览。
`table` 这个取值对应界面上的「表格视图」，它底下有两种解析后端（`.bin` 配置表 /
CSV 文本），见 [csv-view.md](csv-view.md)；更早的存档把它写作 `"cfg"`，
读入时会迁移成 `"table"`。

## 二、文件与职责

| 文件 | 职责 |
|------|------|
| `src/markdown/markdown.ts` | 管线本体（纯函数）：marked 配置、标题锚点、大纲提取、图片占位、链接改写 |
| `src/markdown/math.ts` | marked 的公式扩展（`$…$`、`$$…$$`、`\(…\)`、`\[…\]` + 防误判规则） |
| `src/markdown/footnotes.ts` | marked 的脚注扩展（`[^1]` + 首次引用编号 + 脚注区） |
| `src/markdown/paths.ts` | 相对链接 / 图片路径解析（Windows 路径、`%20`、`..`、`file://`） |
| `src/markdown/sanitize.ts` | DOMPurify 白名单清洗（**唯一需要 DOM 的一步**，单独成文件） |
| `src/markdown/markdown.css` | 排版与代码配色（暗/浅两套走同一批主题变量） |
| `src/views/MarkdownView.tsx` | 页面：工具栏、大纲、页内查找、链接/图片分流、失败与截断状态 |
| `src-tauri/src/document.rs` | 后端 `read_text_file`：整篇读取 + 大小上限 + BOM/lossy 解码 |

## 三、为什么是这套依赖

| 选择 | 体积（min） | 理由 |
|------|------------|------|
| `marked` | 进 md chunk 的 334 KB 里 | 原生支持 GFM（表格 / 任务列表 / 删除线），无需插件拼装 |
| `katex` | 266 KB JS + 24 KB CSS + 250 KB woff2 字体 | 公式必须离线渲染；KaTeX 是唯一体积可控且排版可靠的选择（MathJax 约 3 倍） |
| `dompurify` | 同上 | Tauri 里 XSS 等于交出 IPC 能力（读写文件、调后端命令），CSP 挡不住事件属性与 CSS 注入 |
| `highlight.js/lib/common` | 160 KB | 只带常用语言子集；全量语言包是 1 MB，不值 |

**这些全部不进主包**：`MarkdownView` 由 `React.lazy(() => import(...))` 按需加载，
`src/views/index.ts` 刻意不导出它（否则 App 的静态 import 会把它们拖进主 chunk）。
实测：主 chunk 315 KB（改前 303 KB），md chunk 514 KB + 39 KB CSS + 字体，只在进预览时加载。

字体只保留 woff2：KaTeX 的 CSS 给每个字体列了 woff2/woff/ttf 三种回退，Vite 会把
`url()` 引用到的资源全部 emit（约 1 MB）。WebView2 百分百支持 woff2，于是
`vite.config.ts` 里有一个 15 行的 PostCSS 插件把非 woff2 的回退链删掉
（只在确实找到 woff2 时改写；KaTeX 换写法也只是退回「三种都打包」）。实测 dist 从
约 1.9 MB 降到 1.1 MB。

## 四、公式的判定规则（最容易踩的地方）

`marked-katex-extension` 的默认规则要求 `$` 两侧有空格，中文文档里最常见的
`质数$p$满足…` 会整篇漏渲染；开 `nonStandard` 又走向另一个极端 ——
`echo $PATH $HOME`、`价格 $5 到 $10` 会被当成公式。于是公式扩展自己写，规则是：

1. 内容非空，首尾都不能是空白（`$ 100` / `$5 到 $` 不成立）；
2. 内容不含换行与裸 `$`（`$a$b$` 不会把 `$a$` 咬下来）；
3. 收尾 `$` 后不能紧跟数字（`$5$10` 不是公式）；
4. 内容不能是纯数字/标点（**`$5$`、`价格$5$个` 这类价格写法不成立**）；
5. `$$…$$`、`\(…\)`、`\[…\]` 语义无歧义，不施加上述限制。

第 4 条是明确取舍：放弃「把单个数字写成公式」，换取「正文价格不被误判」。
要写单个数字公式用 `\(2\)`。这几条都有单测（`tools/verify-markdown.test.mjs`），
包括「行内代码与代码块里的 `$` 必须保持字面量」—— 那条靠 marked 的扩展优先级成立，
不是靠运气，所以专门有回归样例。

## 五、脚注：编号必须按「首次引用」算

`marked` 18 不带脚注（`marked-footnote` 是第三方插件），这里自己写了一个
（`src/markdown/footnotes.ts`）。真正的难点不是语法，而是**编号规则**：

定义写在哪儿、引用写在第几段，两者顺序经常相反（文末「注释」区的定义往往引用更早）。
按定义顺序编号，读者会看到 1、3、2 这样跳号的角标；按**首次引用顺序**编号才是
从上到下 1、2、3 —— 与 GitHub 一致。于是渲染被拆成三段：

1. **预处理**取出所有 `[^id]: …` 定义行（正文里不该出现这一行），同时记下每个 id
   第一次被引用的位置。跟随围栏代码块：`` ``` `` / `~~~` 里的 `[^1]` 是字面量，
   既不认定义也不认引用（这条有单测守着，之前用反引号写夹具时转义成一个反引号，
   测试其实什么都没验到，改成 `~~~` 之后才真正生效）；
2. **tokenizer** 把 `[^id]` 渲染成上标角标。只有**存在定义**的 id 才算：
   `[^todo]` 这种写完忘记加定义的写法保持原文，一眼可见，而不是变成一个死链接；
3. **收尾**把脚注区（`<section class="md-footnotes">`）追加到正文末尾。条目正文按
   **行内**解析（`parseInline`），所以脚注里的 `` `code` ``、**粗体**、链接照常生效，
   但不支持块级结构（列表 / 代码块），续行用「缩进 ≥ 2 空格」折进同一条。

两条刻意的取舍：

- **未被引用的定义直接丢掉**：既不出现在脚注区，也不占编号。否则删掉正文里的一处
  引用会留下一个带编号的孤儿条目；
- **同一标本重复引用只算一条**：角标数字相同，条目里只有一个 `↩`（回跳箭头指向第一次引用）。

脚注区与正文**拼在一起后一起过清洗**（`sanitize(rawHtml + renderFootnoteSection(...))`）。
这里踩过一次坑：最初把它拼在 `sanitize` **之后**，理由是「HTML 由管线自己产出、内容已过
marked 转义」—— 但**脚注定义正文是文档作者写的**，`[^evil]: <style>body{display:none}</style>`
这种写法一样能进 DOM，等于给唯一那道过滤开了个后门（`<style>` 足以把整个界面藏起来）。
现在单测断言「清洗器收到的那份 HTML 里必须含脚注区」，E2E 也放了一条带 `<style>`/`<script>`
的脚注定义，实测标签被拦、脚本未执行。

角标的 `id`（`footnote-ref-<id>`）与条目的 `id`（`footnote-<id>`）
都是可直接分享的锚点，点击时分流到容器内滚动 + 闪一下高亮（见「跳转落点」一节）。
所有插值进属性的 id/标题都过 `escapeHtml` —— 脚注 id 允许出现引号（`[^a"b]` 是合法的），
不转义就是一个属性注入点。

## 六、安全：清洗是注入的一步

`sanitize` 是管线的一个**参数**，原因有两个：

- DOMPurify 在无 DOM 的 Node 里不可用（`isSupported === false`，连 `sanitize` 都没有），
  单测只能传桩、断言「整篇 HTML 确实经过清洗」；
- 真正的清洗效果由浏览器 E2E 验证（注入 `<script>` / `<style>` / `onerror` /
  `javascript:` / `<iframe>`，断言全部失效且应用没被藏起来）。

清洗策略：白名单 html + svg（KaTeX 的伸缩括号用内联 SVG）+ mathMl（无障碍与复制公式），
整段丢弃 `style`/`link`/`meta`/`base`/`iframe`/`frame`/`object`/`embed`/`form`
（一条 `body{display:none}` 就能让整个应用白屏，这是「显示别人的文档」不该有的能力）。
链接与图片一律 `preventDefault` 后自己分流 —— Tauri 的 WebView 一旦被导航走就回不来了。

## 六、布局与用户偏好

这几处交互都要「跨文档、跨会话」保持一致，因此都落在 localStorage（键名沿用 App 的 `lv-*`）
| 交互 | 行为 | 偏好键 |
|------|------|--------|
| 大纲位置 | 正文**左侧**（视线从左上进入，先目录后正文；早期版本在右侧，与悬浮查找框互相挤压） | — |
| 大纲折叠 | 标题栏 `«` 折叠成 26px 竖轨（整条可点，竖排「大纲」二字）；标题数 ≥ 3 时默认展开，否则默认折叠；**点过一次就记住**，不再按标题数自动决定 | `lv-md-outline`（`open` / `closed`） |
| 正文宽度 | 工具栏滑块 20–100%、步进 1%，也可用方向键逐 1% 调整；数值即当前百分比，点它回默认 70% | `lv-md-width`（整数） |
| 跟随文件变化 | 默认开；每 1.5s 查一次 mtime/size，mtime 变了就重读；文本**逐字未变**时只闪一下「无变化」，不重排版 | `lv-md-follow`（`1` / `0`） |
| 阅读位置 | 滚动时按**比例**记录，重开文档（含重启应用）恢复到原位置附近；带锚点打开时不恢复，位置交给锚点 | `lv-md-scroll`（`{ 路径: 比例 }`，最多 60 篇） |

快捷键（都只在 Markdown 页激活时生效，不与文本视图抢）：

| 键 | 行为 |
|----|------|
| `Ctrl+F` | 打开页内查找（在源码视图下按会先切回预览） |
| `Ctrl+E` | 预览 ⇄ 源码往返（读技术文档时最频繁的一次切换） |
| `Esc` | 关闭查找并清掉命中标记 |

几个实现要点：

- **宽度作用在「文档列」而不是正文块**：预览与源码共用同一列（`.md-column`），
  切换视图时列宽不跳变；百分比相对**可用宽度**（不含大纲面板），所以折叠大纲后
  正文会明显变宽，符合直觉。
- **大纲在源码视图下也可用**：源码视图没有渲染后的标题锚点，点大纲条目会先切回预览、
  渲染完成后跳转（`pendingHeading`），而不是静默失败。
- **折叠后必须留竖轨**：只靠工具栏按钮的状态，用户容易「找不到大纲去哪了」；
  竖轨既是提示也是入口。
- **自动刷新用轮询而不是 fs watcher**：编辑器普遍「写临时文件再 rename」地原子保存，
  watcher 要正确处理得盯父目录 + 处理重命名（`tail.rs` 为日志做过一遍）；这里关心的
  只有「内容变了没」，1.5s 的 `stat_text_file` 足够便宜，也天然扛住原子保存。
  重读后若文本与上次**逐字相同**（编辑器空保存也会改 mtime），App 侧直接丢弃结果，
  不触发整篇重解析，页面只闪一下「无变化」。
  轮询的基线（上次确认变化的 mtime/size）存在 **ref** 里而不是 effect 的局部变量：
  effect 的依赖含 `doc`，而「文件真的变了」正好会让 `doc` 换引用 → effect 重建 →
  局部基线被清空 → 下一轮 stat 被当成首次采样而不再触发刷新（实测到的连环失效，
  表现为「改一次能刷新，再改就没反应」）。基线只在**内容确实变了**之后前移，
  所以「只动 mtime 不动内容」的文件最坏是每轮多读一遍文件，不会白做重排版。
- **跨文档锚点**：`other.md#sec` 打开新 tab 后要落到 `sec` 那一节。路径解析会丢掉
  fragment，所以渲染器把它单独挂在 `data-md-frag` 上；App 用一张「待跳锚点表」
  （键为小写路径）把它交给目标 tab，页面渲染完成后消费并清除。

### 跳转落点：容器相对计算，不用 `scrollIntoView`

标题跳转、脚注角标 / 回跳、大纲条目都走同一个 `scrollWithin()`：用
`target.getBoundingClientRect().top - scroller.getBoundingClientRect().top` 算差值，
加进 `scrollTop` 再夹进 `[0, scrollHeight - clientHeight]`。

为什么不用 `element.scrollIntoView()`：正文里嵌着图片容器、KaTeX 的块级元素，各有自己的
`overflow`，`scrollIntoView` 会去对齐「最近的滚动祖先」——选中谁并不确定，实测落点会偏出
一百多像素；更糟的是它可能连窗口一起滚，而滚动位置记忆记的是容器的比例。夹取还有个
副作用值得记住：**目标靠近文末时，滚动条物理上到不了「贴顶」的位置**，只会停在容器底部
（E2E 里的判据因此是数据驱动的：能贴顶就要求贴顶，不能就要求「确实进了视口」）。

点击后的可见反馈由「闪一下高亮」（`.md-flash`）负责，所以跳转本身不依赖平滑滚动动画。
页内查找是唯一保留 `behavior: "smooth"` 的地方：那是「顺着看下去」的动作，闪一下到会丢上下文。

### 图片：本地显示、失败降级

| 情形 | 行为 |
|------|------|
| 本地图片、存在、且在「打开过的文档目录」内 | **真的显示**（走 asset 协议） |
| 本地图片但文件不存在，或落在文档目录之外 | 退回占位样式（🖼 + 文件名 + 完整路径，点击在资源管理器定位） |
| 远程 `http(s)` 图片 | 始终占位（CSP 的 `img-src` 不放行外网；放行等于「打开文档」就产生对外请求） |
| 原始 HTML `<img>` | 与 Markdown 语法同样改写，`onerror` 等属性一并消失 |

实现分两层：渲染管线只产出**没有 `src` 的 `<img data-md-path>`**（纯函数，不碰 Tauri API），
页面再用 `convertFileSrc` 填真实地址，并给 `img` 挂 `load`/`error` 监听分别打上
`data-md-state="loaded" | "missing"`，CSS 据此切换两种形态。

**可读面收敛**：`tauri.conf.json` 里 asset 协议的静态 `scope` 是**空的**，后端在
`read_text_file` 成功后调用 `app.asset_protocol_scope().allow_directory(dir, true)`
动态授权 —— 只有用户真的打开过的文档目录（含子目录）能通过 asset 协议读到，
而不是写死一个宽泛的通配路径。注意它需要 `tauri` 的 `protocol-asset` feature：
`tauri-build` 会校验 `Cargo.toml` 的 feature 与 `tauri.conf.json` 的 `assetProtocol.enable`
是否一致，**只开一边会直接编译失败**。

### 公式的 MathML 注解

KaTeX 会输出 `<semantics><annotation encoding="application/x-tex">LaTeX 源码</annotation></semantics>`，
而 DOMPurify 的 MathML 白名单里没有 `semantics`/`annotation`（只有 `math/mrow/mi/…`），
默认行为是「删标签、留文本」—— 视觉上看不出来（那层本来就被 `.katex-mathml` 裁成 1px），
但**复制公式拿不到 LaTeX、读屏软件也少了注解**。`src/markdown/sanitize.ts` 用 `ADD_TAGS`
把这两个标签放回来了。

### 深色主题的滚动条

WebView2 的原生滚动条默认跟**系统**亮/暗，不跟页面主题 —— 深色主题下正文右侧挂着
一根接近白色的滚动条（日志列表看不出问题，因为那里是自绘滚动条，只有表格 / Markdown /
大纲这些用原生滚动的区域暴露）。两层处理：

1. `:root { color-scheme: dark }`（浅色主题下 `light`）：原生滚动条、勾选框、下拉、
   范围滑块一并跟随主题 —— 顺带修好了 Markdown 任务列表的勾选框与宽度滑块的配色；
2. 再用全局 `::-webkit-scrollbar*` 把滚动条画成本应用自绘滚动条那一套（轨道透明、
   拇指 `--border-light`、hover 提亮、四周缩进 2px 圆角），两套主题自动跟随变量。

## 七、CSP：公式排版依赖内联样式（踩过一次的坑）

**症状**（只在打包后的应用里出现，浏览器里怎么点都正常）：行内公式只显示上半截，
上下标掉到下一行（`a²+b²=c²` 显示成 `a+b=c` 加一行 `2 2 2`），块级公式挤成一团。

**根因**：KaTeX 的排版**完全依赖内联 `style`**（`top:-3.063em`、`height:2.7em`… 由
`.vlist` 体系按每个公式实例算出），而 Tauri 会把 CSP 改写一遍 —— 它给 `style-src`
追加了 `'nonce-<随机>'`（同时给 index.html 里的 `<style>` 打上 nonce 属性）。按 CSP 规范，
**一个指令里出现 nonce/hash 会让同指令里的 `'unsafe-inline'` 失效**，于是：

- 样式表照常生效（`<link>` 由 `'self'` 放行）→ 页面其它部分看起来完全正常；
- 内联 `style` **属性**全部失效 → 只有公式塌掉。

字段实测（真实应用 vs 浏览器）：

| | 浏览器 / dev | 打包应用（修复前） |
|---|---|---|
| `style="height:5px"` 的 div | `height: 5px` | `height: 0px` |
| `.katex .vlist > span` 的 `top` | `-41.8px` | `0px` |
| 实际 CSP | 无（devCsp: null） | `style-src 'self' 'unsafe-inline' 'nonce-…'` |

**修复**（`src-tauri/tauri.conf.json`）：只关掉 `style-src` 这一路的 CSP 改写，让
`'unsafe-inline'` 重新生效，`script-src` 仍然保留 Tauri 的 hash：

```json
"security": {
  "csp": "…; style-src 'self' 'unsafe-inline'; …",
  "dangerousDisableAssetCspModification": ["style-src"]
}
```

（Tauri 侧对应 `set_csp()` 里的 `can_modify("style-src")` 分支：关掉后既不会往
`<style>` 标签里插 nonce，也不会把 `'nonce-…'` 加进 `style-src`。）

**配套收敛**：内联样式放行后，文档作者手写的 `style` 也就能生效了（一个
`position:fixed;inset:0` 足以盖住整个界面）。所以管线里加了一层：`markdown.ts` 的
`html` 渲染器把**原始 HTML** 里的 `style` 属性全部删掉 —— KaTeX 的内联样式由渲染器
自己产出、不经过那一步，因此公式排版不受影响，样式面收敛到「公式排版」这一件事上。
`src/markdown/markdown.ts` 有对应单测（含 `data-style` 不被误伤、KaTeX 的
`style="top:-…"` 必须保留）。

**教训**：浏览器 E2E（`tools/e2e-markdown.mjs`）跑在 Vite dev server 上，那里**没有 CSP**，
这类「只在打包应用里复现」的问题它一点都测不到。改动 CSP、或引入依赖内联样式的渲染器
（KaTeX / 图表库 / 语法高亮）之后，必须**在打包后的应用里看一眼**：

```powershell
make loglens-build
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
.\src-tauri\target\release\LogLens.exe     # 再用 CDP 连上去量内联样式是否生效
```

## 八、已知取舍（都是有意的）

- **远程图片不加载**：CSP 的 `img-src` 只放行 `'self' data: asset:`。放行 `https:` 意味着
  「打开一个文档」就可能产生对外的网络请求（隐私 + 离线体验），所以远程图只显示占位符。
  本地图片则通过**动态授权的 asset 协议**显示（见「图片」一节）。
- **图片只在「打开过的文档目录」内可见**：asset 协议的可读范围由后端按文档目录动态授权，
  文档引用目录外的图片（`../../shared/x.png`）会退回占位符 —— 这是有意的收敛，
  而不是 bug。
- **本地文件不用系统默认程序打开**（`opener.openPath`）：那需要额外申请
  `opener:allow-open-path` 权限，且「点一下文档里的链接就启动本机程序」是文档视图
  不该有的能力。定位到资源管理器已经够用。
- **非 UTF-8 文档**：`read_text_file` 与文本视图一致地做 lossy 解码，GBK 文档会看到
  替换字符。进阶方案（`encoding_rs` 探测 + 编码选择器）留待需要时再加。
- **大文件截断**：前端把 `maxBytes` 收到 2 MiB（后端默认 4 MiB）。整篇解析 + 公式排版
  是主线程同步操作，超过这个量级切页会明显卡顿；截断时正文顶部有横幅说明，
  并提示可以用文本视图（稀疏读取）看全文。
- **页内查找只命中单个文本节点内**的匹配（跨 `<em>`/`<a>` 的命中不算），
  且跳过公式内部（往 KaTeX 的排版结构里插 `<mark>` 会把公式拆坏）。
- **脚注只支持行内正文**：条目内容按 `parseInline` 解析，`- 列表` / 代码块这类块级
  结构在脚注里不会渲染成块（会被折成一行）。真要做块级得处理 GFM 的续行缩进规则，
  而中文技术文档里的脚注几乎都是一句话，暂不值得。
- **脚注里的锚点不参与跨文档跳转**：`[^x]` 是本文档内的引用，跨文档带 fragment
  只认标题锚点（见「跨文档锚点」）。
- **宽度按百分比而不是像素**：百分比在不同窗口尺寸 / 折叠大纲后都成立，不必为
  每种窗口宽度记一个像素值；代价是无法精确表达「每行 80 字符」这类排版约束。
- **自动刷新是 1.5s 轮询**，不是即时推送：省一次 fs watcher 的生命周期管理，
  代价是最坏 1.5s 的延迟（文档阅读场景够用）。改到毫秒级没有意义。
- **无 Markdown 编辑能力**：本页是查看器，源码视图只读（这是刻意的：编辑交给编辑器）。
- **放行内联样式**：这是公式排版的硬要求（见上一节）。代价是文档里的原始 HTML 若带
  `style` 也本会生效，所以管线主动删掉了文档自带的 `style`；仍保留的是渲染器自己产出的
  内联样式。

## 九、验证

```powershell
pnpm run build                                   # tsc + vite（类型与打包，含 md chunk 切分）
node --test tools/verify-markdown.test.mjs       # 管线规则（公式边界 / 路径 / 大纲 / 脚注 / 清洗注入）
node --test tools/verify-body-views.test.mjs     # 页面优先级（md-view 的位置）
node --test tools/verify-md-sample.test.mjs      # 手工样例 repro/md-sample.md 的结构核对
node tools/e2e-markdown.mjs --launch             # 浏览器 E2E（需先 pnpm run dev）
make loglens-build                               # 打包版冒烟需要真实 exe
node tools/smoke-release.mjs --shot %TEMP%\loglens-smoke-shots   # 真 WebView2 + 真 CSP 的冒烟
```

**为什么要有两个 E2E**：`tools/e2e-markdown.mjs` 跑在 dev server 上，而 dev 的 CSP 是空的
（`devCsp: null`）—— 「Tauri 给 `style-src` 加 nonce 导致内联样式全失效」「被 Vite 内联成
`data:` 的字体被 `font-src 'self'` 拦掉」这两类问题它一次都测不到，而它们**只在打包后复现**。
`tools/smoke-release.mjs` 因此直接在真 exe + 真 WebView2 上断言：内联 style 生效、
公式排版（`.vlist` 的 `top` 被应用）有真实高度、字体无 error、`color-scheme` 与滚动条规则在、
页面零错误日志，另外两条打包版专属项 —— **公式的 `<annotation>` 仍在**（复制公式能拿到
LaTeX）与 **fixture 同目录的本地图片真的加载出来**（同时证明 asset 协议、CSP 的 `img-src`
与后端动态目录授权这三件事都到位）。

**手工自检样例**：[`repro/md-sample.md`](../repro/md-sample.md)。13 个小节覆盖标题层级、
行内格式、列表/任务列表、表格（对齐 + 10 列宽表 + 竖线转义）、四种公式写法与防误判、
7 种代码块、5 处图片写法、三类链接、引用/分隔线/原始 HTML、8 条注入尝试、边界内容、
脚注（编号顺序 / 同标本同号 / 未定义引用保持原文），最后一节是 37 项自检清单（表格形式）。

**交互能力靶子**：[`repro/md-feature-test.md`](../repro/md-feature-test.md) +
[`md-feature-test-part2.md`](../repro/md-feature-test-part2.md) + `repro/imgs/`（两张真实图片）。
单文件演示不了的能力都放在这里：**跨文档锚点**（必须有第二篇才验得到，含「目标已打开时复用
标签页」与「同名标题去重」两条路径）、**本地图片显示 vs 占位降级**（目录内 / 目录外 / 缺失 /
远程四种情形各一处，并写明各自该显示什么）、**脚注边界**（含定义里的 `<style>`/`<script>`
注入尝试）、**大号定界符**（`\left\{`、`\bigg(`、`\left\lfloor` —— 打包版字体那条回归的靶子）、
以及需要手动做的五项（自动刷新用文件顶部的**版本戳**、跟随开关、阅读位置记忆、`Ctrl+E`、
`¶` 复制锚点）。文件里每条承诺都已实测过（例：点跨文档链接后目标标题距正文顶部 8px）。

两份文档同样是结构回归夹具：`verify-md-sample` 与 `verify-feature-test` 会把它们过一遍真实
管线，核对元素数量（表格数、勾选框、`.katex` 与 `.katex-display`、图片路径分类、脚注编号、
锚点是否都能命中真实标题、跨文档 fragment 是否指向真的存在的小节），样例与实现一起漂移时
会立刻失败。观感类问题（配色、间距、溢出）仍需人眼过一遍，脚本覆盖不到。

E2E 覆盖：老存档按扩展名自动进预览 → GFM 表格/任务列表 → 四种公式写法（断言
`.katex` 有真实排版尺寸，不只是标记存在）→ 价格不误判 → 代码高亮与转义 →
图片容器与降级（asset 协议不可用时退回占位）→ 注入全部失效 → 大纲跳转与高亮 →
Ctrl+F 查找与计数 → 外链/锚点/相对链接三条分流 → 源码/预览往返 → 截断横幅 →
读取失败 + 重试 → 文件不存在 + 恢复后自动回预览 → **脚注（4 处引用只产生 3 个条目、
编号按首次引用、点角标跳条目并闪高亮、点 `↩` 回到引用处、脚注定义里的
`<style>`/`<script>` 一并被清洗且不执行）/ `Ctrl+E` 往返且不丢阅读位置 /
点标题 `¶` 把带锚点的完整链接写进剪贴板并给瞬时提示** → **大纲在左侧 / 折叠与展开（含持久化）/
折叠后正文变宽 / 源码视图点大纲切回预览并跳转 / 宽度 20–100% 按百分比生效且 1% 精度 /
点数值回默认 / `color-scheme` 与 `::-webkit-scrollbar` 规则确实生效** →
**跨文档锚点（新文档与已打开文档两条路径都要落到目标小节）/ 阅读位置落盘与刷新后恢复 /
自动刷新（外部改动被轮询检测到、重读后新内容出现、且不把阅读位置拽走、关掉开关就不再刷新）**。