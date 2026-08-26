# tauri-logviewer

仅面向 Windows 平台的日志查看器桌面应用。技术栈：**Tauri 2（Rust 后端）+ React + TypeScript + TanStack Virtual（前端虚拟滚动）**。

面向场景：浏览数万行的大日志文件，并支持**实时增量刷新**与**实时文本过滤**。

## 核心设计

三段全部增量化，避免任何一个环节塌陷：

| 环节 | 方案 | 位置 |
|------|------|------|
| 增量读取 | `File::seek` 记字节偏移，只读新增字节；处理换行边界 + 截断/轮转 | `src-tauri/src/tail.rs` |
| 实时过滤 | Aho-Corasick 多关键词 + 可选正则，下沉到原生层，只推命中行 | `src-tauri/src/filter.rs` |
| 海量行渲染 | 虚拟滚动，只渲染可视区 ± 缓冲行 | `src/App.tsx`（`@tanstack/react-virtual`） |
| 文件监控 | `notify`（Windows 走 `ReadDirectoryChangesW`），监听父目录捕获轮转 | `src-tauri/src/state.rs` |

架构约定：

- 前端**只持有过滤后**的行，全量原文留在 Rust 内存。
- 行数据带稳定 `file_offset`，与「过滤结果显示序号」分离，为「跳转到源文件行」预留。
- 过滤条件变化时，后端对已加载行**重扫**，返回新命中集前端重建。
- 首屏默认从文件**尾部**加载（最新日志优先），而非从头读几十万行。

## 本地 Rust 工具链（不使用系统工具链）

Rust 工具链安装在**仓库外部**、仅本地使用，不写入系统/用户 PATH：

- `CARGO_HOME = E:\Workspace\.cargo`
- `RUSTUP_HOME = E:\Workspace\.rustup`

每个新终端先激活：

```powershell
. E:\Workspace\env\activate-rust.ps1   # 或直接调用 E:\Workspace\env\cargo.cmd
```

项目通过 `src-tauri/rust-toolchain.toml` 固定工具链版本。

> ⚠️ **版本固定原因**：rustc 1.98.0 stable 编译 `windows` crate v0.61.x（Tauri 2.11 官方依赖）时触发
> `STATUS_STACK_BUFFER_OVERRUN` 崩溃；固定到 **1.97.0** 可正常编译。升级工具链前需重新验证 `windows` crate 可编译。

## 构建与运行

```powershell
# 先激活本地 Rust 工具链
. E:\Workspace\env\activate-rust.ps1

# 开发模式（启动 Vite + 编译 Rust + 打开窗口）
pnpm tauri dev

# 仅前端
pnpm dev
# 仅后端测试
cd src-tauri && cargo test --lib
# 打包
pnpm tauri build
```

> ⚠️ **端口说明**：Vite dev server 用 **5173**（HMR 5174），而非 Tauri 默认的 1420/1421。
> 原因：本机 Windows 的 TCP 排除端口范围 `1401-2000`（WSL2 动态端口保留）导致 1420 无法绑定（EACCES）。

## 目录结构

```
src/                  # 前端 React + TS
  App.tsx             # 虚拟滚动列表 + 过滤条 + 尾部跟随
src-tauri/
  src/
    main.rs           # 入口
    lib.rs            # 命令注册 + 状态初始化
    tail.rs           # 增量 tail-follow（seek/offset/换行边界/轮转）
    filter.rs         # Aho-Corasick + 正则过滤
    state.rs          # 共享状态 + notify 后台线程 + 事件推送
  rust-toolchain.toml # 固定 Rust 1.97.0
  tauri.conf.json     # devUrl = http://127.0.0.1:5173
```

## 前置依赖

- Windows 10 1809+ / Windows 11（系统自带 WebView2）
- Visual Studio Build Tools（含 MSVC + Windows SDK，`cl.exe`/`link.exe`）
- Node.js ≥ 18 + pnpm

## TODO

- [ ] 日志轮转（rename + 同名新建）的父目录事件处理已实现基础版，需实测边界
- [ ] 搜索/高亮（关键词高亮命中文本）
- [ ] 过滤结果行号 → 源文件行号跳转（file_offset 已预留）
- [ ] 大文件按需分页/稀疏化（>50 万行时的进一步优化）
