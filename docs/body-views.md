# 正文多页面框架（body views）

正文区（tab 内容区）此前只有「文本视图 / 表格视图」两种形态，在 `App.tsx` 里用三元
表达式二选一。随着「文件不存在」「打开失败」这类**状态页面**出现，二元选择会迅速退化
成难读的嵌套三元，而且每加一个页面都要改动 App 的渲染树。

现在正文区是一个**多页面框架**：`tab 状态 → 带优先级的候选页面 → 命中的唯一页面`。

```
                ┌──────────────────────────────────────────────┐
   tab 状态 ──▶  │ APP_BODY_VIEWS（优先级 + 命中规则，纯数据）   │ ──▶ 唯一页面 id
（ctx）          └──────────────────────────────────────────────┘
                                    │
                                    ▼
                ┌──────────────────────────────────────────────┐
                │ APP_BODY_VIEW_RENDERERS（id → 渲染实现）      │ ──▶ 页面组件
                └──────────────────────────────────────────────┘
```

## 文件与职责

| 文件 | 职责 |
|------|------|
| `src/views/body-view.ts` | 框架核心（纯逻辑）：公共 props、错误分类 `classifyOpenError`、`BodyViewRegistry` |
| `src/views/app-body-views.ts` | **本应用的页面清单**：`id` / 优先级 / 命中规则 + `resolveAppBodyViewId`（纯数据，可单测） |
| `src/views/BodyViewHost.tsx` | 宿主：解析页面、写 `data-view`、页面级错误边界（页面崩了不白屏） |
| `src/views/use-body-view.ts` | 公共生命周期 hook：激活时注册「复制当前视图」/ 上报行数，失活时注销 |
| `src/views/NoticeLine.tsx` | 状态页外壳：正文区正中一行说明文字（含悬停提示） |
| `src/views/FileMissingView.tsx` | 「文件不存在」状态页 |
| `src/views/OpenErrorView.tsx` | 通用「打开失败」状态页（权限 / IO / 格式…） |
| `App.tsx` 的 `APP_BODY_VIEW_RENDERERS` | 「页面 id → 怎么渲染」：页面专属属性在这里组装，App 侧回调在这里注入 |

## 选择规则（优先级从高到低）

| 优先级 | 页面 id | 命中条件 | 说明 |
|-------|---------|---------|------|
| 100 | `file-missing` | 错误分类 = `missing` 且缺的是**文件本体** | 内容根本加载不出来，直接说明是哪件事、哪个路径 |
| 30 | `cfg-table` | `viewMode === "cfg"` | 表格视图自带错误面板（可重选 schema），故排在通用错误页之前 |
| 20 | `open-error` | 错误分类 = `denied` / `other` | 通用状态页，兜住未预料的失败 |
| 0 | `text-log` | 永远命中（`fallback`） | 文本日志视图 |

几条刻意的设计决定：

- **状态页就是一行文字**：`file-missing` / `open-error` 都只渲染一行说明（含完整路径），
  不放按钮。理由：这类页面只有一句话的信息量，堆操作反而把「看一眼就知道怎么回事」
  变成了「先读一排按钮」；要重新定位文件直接再打开一次即可。
- **`file-missing` 优先于一切内容视图**：文件不在，表格 / 文本都没有数据可显示。
- **`cfg-table` 优先于 `open-error`**：表格视图的解析错误需要它自己的错误面板
  （里面才有「选择 schema…」），不能被通用错误页顶掉。
- **「缺 schema」不是「缺文件」**：`classifyOpenError` 把
  `schema 文件不存在: …` 归到 `subject: "schema"`，此时仍留在表格视图里重选 schema ——
  否则页面会把**存在**的 bin 路径当成缺失文件展示。
- **兜底页唯一**：`BodyViewRegistry` 构造时就校验（重复 id / 缺兜底 / 多个兜底都直接抛错），
  这类配置错误不该等到渲染时才暴露。

## 新增一个页面（4 步）

以「权限不足」定制页为例：

1. **写组件**（`src/views/PermissionView.tsx`），props 继承公共契约
   (`BodyViewProps`)，生命周期用 `useBodyViewEffects`；状态页直接复用
   `NoticeLine` 外壳（正文区正中一行说明文字）：

   ```tsx
   export interface PermissionViewProps extends BodyViewProps {
     /** 后端原始报错，只在悬停提示里出现。 */
     error?: string;
   }

   export function PermissionView(props: PermissionViewProps) {
     const { lang, path, error } = props;
     useBodyViewEffects(props);            // 状态页：不产出复制内容 / 行数
     return (
       <NoticeLine
         tone="error"
         text={lang === "zh" ? `没有权限读取：${path}` : `Permission denied: ${path}`}
         title={error ?? path}
       />
     );
   }
   ```

2. **加一条规则**：在 `src/views/app-body-views.ts` 的 `APP_BODY_VIEWS` 里插一条，
   并把 id 加进 `AppBodyViewId` 联合类型。位置由 `priority` 决定（规则表见上）。

3. **加渲染实现**：在 `App.tsx` 的 `APP_BODY_VIEW_RENDERERS` / `APP_BODY_VIEW_TITLES`
   里补同名条目 —— 两者都是 `Record<AppBodyViewId, …>`，漏了编译不过。
   若新页面需要 App 侧数据或操作，往 `AppBodyViewCtx` 加字段，并在渲染 `BodyViewHost`
   处的 `ctx={{ … }}` 里提供。

4. **补验证**：`tools/verify-body-views.test.mjs` 里加 `resolveAppBodyViewId` 的优先级断言；
   端到端可照抄 `tools/e2e-file-missing.mjs`（CDP + mock 后端驱动真实交互）。

> 提取文案：视图模块自带中英文案（与 `CfgTableTab` 一致），不反向依赖 App 的 i18n 字典
> （App → views 是单向依赖，避免循环引用）。

## 约定与陷阱

- **状态页保持一行**：这类页面只有一句话的信息量，刻意不放按钮 / 图标 / 折叠详情
  （`NoticeLine` 就是全部）。内容视图才需要工具栏与操作。
- `match` 只做判定：不要在里面取数据、发请求或读缓存（它会在每次渲染被调用）。
- **页面切换会重新挂载**（宿主用 `key={页面 id}`）：页面内的局部状态会丢；确实需要
  跨页面保留的状态放到 App。
- 页面只认识公共契约与自己的专属 props：后端命令、tab 会话、视图模式都在 App 侧，
  换页面不用重写这套逻辑。
- **只激活的 tab 注册生命周期**：状态页激活时会清空右上角总行数、禁用「复制当前视图」，
  这正是 `useBodyViewEffects(props)`（不传 handlers）的语义。
- 错误分类依赖后端的**消息契约**（`src-tauri` 里 `文件不存在: …` /
  `schema 文件不存在: …` / `读取失败: 拒绝访问。 (os error 5)`）。后端改文案时同步改
  `classifyOpenError` 的匹配表与该单测里的真实样本。
- 不要匹配裸的「不存在」：`tab 不存在: tab-3` 这类会话错误也含这两个字，与文件系统无关
  （单测里有这条回归样本）。
- **失败 tab 的恢复路径**：状态页没有按钮，所以「同一个路径再次打开」必须顺手重试
  （`App.openPath` 里 `existing.openError → reopenTab`）—— 否则文件恢复后界面会一直
  停在「文件不存在」，等于说假话。

## 验证

```powershell
pnpm run build                                  # tsc + vite（类型与打包）
node --test tools/verify-body-views.test.mjs    # 规则单测：错误分类 / 页面优先级（无需浏览器）

pnpm run dev                                    # 另开一个终端：Vite dev server (127.0.0.1:5173)
node tools/e2e-file-missing.mjs --launch        # 浏览器端到端：CDP + mock 后端驱动真实交互
node tools/e2e-file-missing.mjs --launch --theme light --shot %TEMP%\loglens-e2e
                                                # 浅色主题 + 导出成品截图
```

端到端脚本覆盖的场景：会话恢复到一个已删除的文件 → 正文是一行「文件不存在：<路径>」
（无按钮）→ 同一路径再次打开不新增 tab → 文件恢复后再次打开自动切回文本视图 →
拒绝访问走通用错误页 → 表格视图选 schema / 渲染 / 复制 / 切回文本。
