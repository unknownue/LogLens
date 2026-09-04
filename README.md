# LogLens

A fast log viewer for Windows, built with **Tauri 2 + React + TanStack Virtual**.

Designed for large log files: follow them in real time and browse anywhere without loading everything.

## Features

- **Live tail** — incremental reads from the end of the file; survives truncation, rotation, and full external rewrites (even same-size rewrites).
- **Realtime filtering** — keyword (Aho-Corasick) and regex filtering in Rust; only matching lines reach the UI.
- **Sparse virtual scrolling** — the scrollbar maps the whole file; unloaded regions render as placeholders and load on demand, bidirectionally, with distance-prioritized prefetch.
- **Line index** — a sampled (every 64 lines) byte-offset index makes line lookups and line counts O(sample gap) instead of a full file scan.
- **Session restore** — reopens the tabs from the previous run; missing files show a warning instead of crashing.
- **Extras** — multi-tab, jump-to-line, keyword highlighting, copy-view, recent-files dropdown (last 10 opens, keeps missing files), bilingual UI (中文 / English).
- **Config-table viewer** — every file opens as a log by default; the top-right icon button (grid ⇄ lines) switches the *active* tab to a GM10 `client_cfg` config-table view (MemoryPack), parsed with the schema in `cfg_table_slots.json` (auto-located from the file path, or picked manually). Each tab's mode is independent; the table is virtualized with a sticky header and copy-view exports TSV. Format spec: [docs/client_cfg_bin_format.md](docs/client_cfg_bin_format.md).

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
```

Installer output: `src-tauri/target/release/bundle/nsis/LogLens_<version>_x64-setup.exe`
(LZMA compression, per-user install, Chinese/English, embedded WebView2 bootstrapper).

## Architecture

| Layer | Approach | Source |
|-------|----------|--------|
| Incremental reads | byte-offset tailing with boundary / truncation / rotation handling | `src-tauri/src/tail.rs` |
| Line index | sampled offsets, seeded on open, warmed to EOF in the background | `src-tauri/src/index.rs` |
| Filtering | Aho-Corasick multi-keyword + optional regex | `src-tauri/src/filter.rs` |
| State & events | per-tab sessions, `notify` watcher, batched events | `src-tauri/src/state.rs` |
| Rendering | sparse virtual list, placeholder rows, idle scroll anchoring, line-based wheel | `src/App.tsx` |

## Release build profile

`src-tauri/Cargo.toml` → `[profile.release]`: `opt-level = 3`, fat LTO, `codegen-units = 1`,
`strip = true`, `panic = "abort"`.
