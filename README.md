# LogLens

A fast log viewer for Windows, built with **Tauri 2 + React + TanStack Virtual**.

Designed for large log files: follow them in real time and browse anywhere without loading everything.

## Features

- **Live tail** — incremental reads from the end of the file; survives truncation, rotation, and full rewrites.
- **Filtering** — keyword and regex as two mutually exclusive modes sharing one input box; keyword is the default.
- **Find in content** — a VSCode-style floating widget (`Ctrl+F`); forward search, match-case and whole-word, Enter to step through hits. Its scope follows the filter.
- **Sparse virtual scrolling** — the scrollbar maps the whole file; unloaded regions load on demand.
- **Line index** — a sampled byte-offset index makes line lookups O(sample gap) instead of a full scan.
- **Session restore** — reopens the previous tabs, and reuses the last window size.
- **Extras** — multi-tab, jump-to-line, keyword highlighting, copy-view, recent files, bilingual UI (中文 / English), custom borderless title bar.
- **Config-table viewer** — switch a tab to a GM10 `client_cfg` (MemoryPack) table view via the icon button at the left of its toolbar; columns size themselves to their content. Format spec: [docs/client_cfg_bin_format.md](docs/client_cfg_bin_format.md).
- **Body pages** — the content area is a small page framework (text / table / file-missing / open-error). A tab whose file was deleted or moved (recent files, session restore) shows a one-line “File not found: <path>” notice instead of a blank body; reopening the same path re-checks it. Guide: [docs/body-views.md](docs/body-views.md).

## Screenshot

![LogLens](docs/screenshot.png)

## Requirements

- Windows 10 1809+ (WebView2)
- Rust 1.97 (pinned in `src-tauri/rust-toolchain.toml`; 1.98+ crashes on the `windows` crate)
- Node.js ≥ 18 + pnpm

## Build & run

```powershell
make loglens            # run the release exe (no HTTP server, frontend embedded)
make loglens-build      # rebuild release (--no-bundle)
make loglens-package    # build the NSIS installer
make loglens-dev        # dev mode (Vite dev server on 5173)
cd src-tauri && cargo test --lib   # backend tests
node --test tools/verify-body-views.test.mjs   # body-page rules (no browser needed)
node tools/e2e-file-missing.mjs --launch       # browser E2E (run `pnpm run dev` first)
```

Installer output: `src-tauri/target/release/bundle/nsis/LogLens_<version>_x64-setup.exe`.

## Architecture

| Layer | Source |
|-------|--------|
| Incremental reads | `src-tauri/src/tail.rs` |
| Line index | `src-tauri/src/index.rs` |
| Filtering | `src-tauri/src/filter.rs` |
| Find in content | `src-tauri/src/search.rs` |
| State & events | `src-tauri/src/state.rs` |
| Window size memory | `src-tauri/src/window_state.rs` |
| Body pages (text / table / file-missing / open-error) | `src/views/` — see [docs/body-views.md](docs/body-views.md) |
| Rendering | `src/App.tsx` |

Release profile (`src-tauri/Cargo.toml`): `opt-level = 3`, fat LTO, `codegen-units = 1`, `strip = true`, `panic = "abort"`.
