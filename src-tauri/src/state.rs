//! 共享状态与后台文件监控线程。
//!
//! 结构：AppState 持有 Mutex 日志缓冲与过滤条件；后台线程用 notify 监听文件变化，
//! 轮询 TailReader 增量读取，经 Filter 过滤后通过 Tauri AppHandle emit 给前端。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use notify::{RecursiveMode, Watcher};
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

use crate::filter::{Filter, FilterSpec};
use crate::tail::{LogLine, TailEvent, TailReader};

/// 传给前端的一批行事件负载。
#[derive(Clone, serde::Serialize)]
pub struct LinesPayload {
    pub lines: Vec<LogLine>,
    pub reset: bool,
}

pub struct AppState {
    /// 全部已加载行（原文，用于过滤条件变化时重扫）。仅保留文本 + offset。
    pub all_lines: Mutex<Vec<LogLine>>,
    /// 当前过滤条件。
    pub filter: Mutex<Filter>,
    /// 单调递增的行偏移（用于给新行分配稳定 file_offset）。
    pub next_offset: AtomicU64,
    /// 当前打开的日志文件路径。
    pub file_path: Mutex<Option<PathBuf>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            all_lines: Mutex::new(Vec::new()),
            filter: Mutex::new(Filter::new(FilterSpec::default())),
            next_offset: AtomicU64::new(0),
            file_path: Mutex::new(None),
        }
    }

    /// 分配一个新的 file_offset。
    fn alloc_offset(&self) -> u64 {
        self.next_offset.fetch_add(1, Ordering::SeqCst)
    }

    /// 设置过滤条件并重扫已加载行，返回新的命中集（带 file_offset 稳定定位）。
    pub fn apply_filter(&self, spec: FilterSpec) -> Vec<LogLine> {
        let mut filter = self.filter.lock();
        let new_filter = Filter::new(spec);
        let result = {
            let lines = self.all_lines.lock();
            lines.iter().filter(|l| new_filter.matches(&l.text)).cloned().collect::<Vec<_>>()
        };
        *filter = new_filter;
        result
    }

    /// 追加新行（经过滤），返回命中的行。
    fn append_lines(&self, new_lines: Vec<String>) -> Vec<LogLine> {
        let filter = self.filter.lock();
        let mut all = self.all_lines.lock();
        let mut matched = Vec::new();
        for text in new_lines {
            if filter.matches(&text) {
                let off = self.alloc_offset();
                let line = LogLine::new(off, text.clone());
                matched.push(line.clone());
                all.push(line);
            } else {
                // 未命中也要保留到 all_lines（供过滤条件变化重扫），但用分配后的 offset 占位。
                let off = self.alloc_offset();
                all.push(LogLine::new(off, text));
            }
        }
        matched
    }

    /// 清空（截断/轮转时）。
    fn clear(&self) {
        self.all_lines.lock().clear();
    }
}

/// 初始化文件监控：返回后台线程 JoinHandle 与初始尾部行。
pub fn start_watching(app: AppHandle, state: Arc<AppState>, path: PathBuf) {
    // 先加载初始尾部。
    let mut reader = TailReader::new(path.clone());
    let initial = match reader.init_tail(1000) {
        Ok(lines) => lines,
        Err(e) => {
            eprintln!("[tail] init_tail failed: {}", e);
            Vec::new()
        }
    };
    let matched = state.append_lines(initial);
    let _ = app.emit("log-lines", LinesPayload { lines: matched, reset: false });

    *state.file_path.lock() = Some(path.clone());

    // 后台线程：notify 监听 + 轮询 TailReader。
    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();

        // 监听父目录，以便捕获 rename/create（轮转）。
        let watch_path = path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| path.clone());
        let mut watcher = match notify::recommended_watcher(tx) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[watch] failed to create watcher: {}", e);
                return;
            }
        };

        if let Err(e) = watcher.watch(&watch_path, RecursiveMode::NonRecursive) {
            eprintln!("[watch] failed to watch {}: {}", watch_path.display(), e);
            return;
        }

        let file_name = path.file_name().map(|s| s.to_os_string());
        let mut reader = reader;

        // 事件累积 + 节流：按时间片批量推送。
        loop {
            let event = rx.recv();
            match event {
                Ok(Ok(ev)) => {
                    // 只关心目标文件自身的事件（或父目录里的同名 create）。
                    let relevant = ev.paths.iter().any(|p| {
                        match &file_name {
                            Some(n) => p.file_name().map(|f| f == n).unwrap_or(false),
                            None => false,
                        }
                    });
                    if !relevant {
                        continue;
                    }

                    // 轮转：检测到 create/rename 后重开。
                    if ev.kind == notify::EventKind::Create(notify::event::CreateKind::File)
                        || ev.kind
                            == notify::EventKind::Modify(notify::event::ModifyKind::Name(
                                notify::event::RenameMode::To,
                            ))
                    {
                        if let Err(e) = reader.reopen() {
                            eprintln!("[tail] reopen failed: {}", e);
                        } else {
                            state.clear();
                            let _ = app.emit(
                                "log-lines",
                                LinesPayload { lines: Vec::new(), reset: true },
                            );
                        }
                    }

                    match reader.poll() {
                        Ok(events) => {
                            let mut matched = Vec::new();
                            let mut reset = false;
                            for e in events {
                                match e {
                                    TailEvent::Lines(lines) => {
                                        matched.extend(state.append_lines(lines));
                                    }
                                    TailEvent::Reset => {
                                        state.clear();
                                        reset = true;
                                    }
                                }
                            }
                            if reset || !matched.is_empty() {
                                let _ = app.emit(
                                    "log-lines",
                                    LinesPayload { lines: matched, reset },
                                );
                            }
                        }
                        Err(e) => {
                            eprintln!("[tail] poll failed: {}", e);
                        }
                    }
                }
                Ok(Err(e)) => {
                    eprintln!("[watch] error: {}", e);
                }
                Err(_) => {
                    // channel closed => watcher dropped => exit thread.
                    break;
                }
            }
        }
    });
}
