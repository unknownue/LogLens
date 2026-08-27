//! 共享状态与后台文件监控线程。
//!
//! 多 tab：每个 tab 对应一个 TabSession（独立日志缓冲、过滤、文件监控线程），
//! AppState 用 HashMap<tab_id, TabSession> 管理所有会话。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use notify::{RecursiveMode, Watcher};
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

use crate::filter::{Filter, FilterSpec};
use crate::tail::{LogLine, TailEvent, TailReader};

/// 传给前端的一批行事件负载（带 tab_id 用于前端路由到对应 tab）。
#[derive(Clone, serde::Serialize)]
pub struct LinesPayload {
    pub tab_id: String,
    pub lines: Vec<LogLine>,
    pub reset: bool,
}

/// 单个 tab 的会话状态。
pub struct TabSession {
    /// 全部已加载行（原文，用于过滤条件变化时重扫）。
    pub all_lines: Mutex<Vec<LogLine>>,
    /// 当前过滤条件。
    pub filter: Mutex<Filter>,
    /// 单调递增的行偏移（用于给新行分配稳定 file_offset）。
    pub next_offset: AtomicU64,
    /// 当前打开的日志文件路径。
    pub file_path: Mutex<Option<PathBuf>>,
    /// 停止信号：置 true 后监控线程退出（关闭 tab 时）。
    pub stop: Arc<AtomicBool>,
}

impl TabSession {
    pub fn new() -> Self {
        Self {
            all_lines: Mutex::new(Vec::new()),
            filter: Mutex::new(Filter::new(FilterSpec::default())),
            next_offset: AtomicU64::new(0),
            file_path: Mutex::new(None),
            stop: Arc::new(AtomicBool::new(false)),
        }
    }

    /// 分配一个新的 file_offset。
    fn alloc_offset(&self) -> u64 {
        self.next_offset.fetch_add(1, Ordering::SeqCst)
    }

    /// 设置过滤条件并重扫已加载行，返回新的命中集。
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

    /// 返回当前过滤后的视图（用于前端挂载时拉取，弥补挂载前错过的事件）。
    pub fn current_view(&self) -> Vec<LogLine> {
        let filter = self.filter.lock();
        let lines = self.all_lines.lock();
        lines.iter().filter(|l| filter.matches(&l.text)).cloned().collect()
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
                // 未命中也要保留到 all_lines（供过滤条件变化重扫）。
                let off = self.alloc_offset();
                all.push(LogLine::new(off, text));
            }
        }
        matched
    }

    /// 清空（截断/轮转/打开新文件时）。
    fn clear(&self) {
        self.all_lines.lock().clear();
    }
}

/// 全局状态：管理所有 tab 的会话。
pub struct AppState {
    sessions: Mutex<HashMap<String, Arc<TabSession>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// 获取或创建指定 tab 的会话。
    pub fn get_or_create(&self, tab_id: &str) -> Arc<TabSession> {
        let mut sessions = self.sessions.lock();
        sessions
            .entry(tab_id.to_string())
            .or_insert_with(|| Arc::new(TabSession::new()))
            .clone()
    }

    /// 获取指定 tab 的会话（不存在返回 None）。
    pub fn get(&self, tab_id: &str) -> Option<Arc<TabSession>> {
        self.sessions.lock().get(tab_id).cloned()
    }

    /// 关闭指定 tab：置停止信号并移除会话。
    pub fn close(&self, tab_id: &str) {
        let session = self.sessions.lock().remove(tab_id);
        if let Some(s) = session {
            s.stop.store(true, Ordering::SeqCst);
        }
    }
}

/// 为指定 tab 的会话启动文件监控（命令层先 get_or_create 会话）。
pub fn start_watching_for_session(app: AppHandle, tab_id: String, session: Arc<TabSession>, path: PathBuf) {
    // 打开新文件：清空该 tab 旧文件的残留状态。
    session.clear();

    // 先加载初始尾部。
    let mut reader = TailReader::new(path.clone());
    let initial = match reader.init_tail(1000) {
        Ok(lines) => lines,
        Err(e) => {
            eprintln!("[tail] init_tail failed: {}", e);
            Vec::new()
        }
    };
    let matched = session.append_lines(initial);
    // reset=true：告知前端这是全新加载，替换现有视图而非追加。
    let _ = app.emit(
        "log-lines",
        LinesPayload { tab_id: tab_id.clone(), lines: matched, reset: true },
    );

    *session.file_path.lock() = Some(path.clone());

    let stop = session.stop.clone();

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

        // 事件驱动的增量读取 + 定时兜底轮询 + emit 时间片合并。
        // 100ms 为一个周期：期间累积的新行合并成一批 emit，
        // 高频日志时大幅减少 IPC 事件次数与前端渲染频率。
        const POLL_INTERVAL_MS: u64 = 100;
        let mut pending_lines: Vec<LogLine> = Vec::new();
        let mut pending_reset = false;
        let mut last_flush = std::time::Instant::now();

        loop {
            // 关闭 tab：退出线程。
            if stop.load(Ordering::SeqCst) {
                break;
            }

            let event = rx.recv_timeout(std::time::Duration::from_millis(POLL_INTERVAL_MS));
            match event {
                Ok(Ok(ev)) => {
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
                            session.clear();
                            pending_lines.clear();
                            pending_reset = true;
                        }
                    }
                }
                Ok(Err(e)) => {
                    eprintln!("[watch] error: {}", e);
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    // 定时兜底：无事件也 poll 一次。
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    break;
                }
            }

            // 统一 poll 一次，把增量累积到待发批次。
            match reader.poll() {
                Ok(events) => {
                    for e in events {
                        match e {
                            TailEvent::Lines(lines) => {
                                pending_lines.extend(session.append_lines(lines));
                            }
                            TailEvent::Reset => {
                                session.clear();
                                pending_lines.clear();
                                pending_reset = true;
                            }
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[tail] poll failed: {}", e);
                }
            }

            // 到时间片则合并 flush 一批。
            if (pending_reset || !pending_lines.is_empty())
                && last_flush.elapsed() >= std::time::Duration::from_millis(POLL_INTERVAL_MS)
            {
                let payload = LinesPayload {
                    tab_id: tab_id.clone(),
                    lines: std::mem::take(&mut pending_lines),
                    reset: pending_reset,
                };
                pending_reset = false;
                last_flush = std::time::Instant::now();
                let _ = app.emit("log-lines", payload);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session_with(lines: Vec<&str>) -> Arc<TabSession> {
        let s = TabSession::new();
        let owned: Vec<String> = lines.into_iter().map(|l| l.to_string()).collect();
        s.append_lines(owned);
        Arc::new(s)
    }

    #[test]
    fn apply_filter_with_space_keyword_returns_phrase_matches() {
        let s = session_with(vec![
            "2026/01/01 INFO all good",
            "2026/01/01 ERROR a database error occurred",
            "2026/01/01 WARN database is healthy",
            "2026/01/01 ERROR DATABASE ERROR fatal",
            "2026/01/01 INFO an error happened",
        ]);

        let spec = FilterSpec {
            keywords: vec!["database error".to_string()],
            regex: None,
            case_sensitive: false,
        };
        let matched = s.apply_filter(spec);
        let texts: Vec<&str> = matched.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(texts, vec![
            "2026/01/01 ERROR a database error occurred",
            "2026/01/01 ERROR DATABASE ERROR fatal",
        ]);
    }

    #[test]
    fn apply_filter_empty_keywords_returns_all() {
        let s = session_with(vec!["aaa", "bbb"]);
        let matched = s.apply_filter(FilterSpec::default());
        assert_eq!(matched.len(), 2);
    }

    #[test]
    fn after_filter_new_lines_are_still_filtered() {
        let s = session_with(vec!["ERROR db error", "INFO ok"]);

        let spec = FilterSpec {
            keywords: vec!["error".to_string()],
            regex: None,
            case_sensitive: false,
        };
        let matched = s.apply_filter(spec);
        assert_eq!(matched.len(), 1);

        let newly = s.append_lines(vec![
            "ERROR another db error".to_string(),
            "INFO still ok".to_string(),
            "ERROR third error".to_string(),
        ]);
        assert_eq!(newly.len(), 2);
        let texts: Vec<&str> = newly.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(texts, vec![
            "ERROR another db error",
            "ERROR third error",
        ]);
    }

    #[test]
    fn tabs_are_isolated() {
        // 两个 tab 互不影响。
        let s1 = session_with(vec!["aaa one"]);
        let s2 = session_with(vec!["bbb two"]);

        // 只在 s1 设置过滤，s2 不受影响。
        let spec = FilterSpec {
            keywords: vec!["one".to_string()],
            regex: None,
            case_sensitive: false,
        };
        let m1 = s1.apply_filter(spec.clone());
        assert_eq!(m1.len(), 1);

        // s2 未设置过滤，应全命中。
        let m2 = s2.apply_filter(FilterSpec::default());
        assert_eq!(m2.len(), 1);
        assert_eq!(m2[0].text, "bbb two");
    }

    #[test]
    fn current_view_returns_filtered_lines() {
        let s = session_with(vec!["ERROR e1", "INFO i1", "ERROR e2"]);
        // 未过滤：全量。
        assert_eq!(s.current_view().len(), 3);
        // 过滤 error 后：只剩 2 行。
        let spec = FilterSpec {
            keywords: vec!["error".to_string()],
            regex: None,
            case_sensitive: false,
        };
        s.apply_filter(spec);
        let view = s.current_view();
        assert_eq!(view.len(), 2);
    }

    /// 性能探针：10 万行的 apply_filter 重扫（含 clone）+ JSON 序列化成本。
    #[test]
    fn perf_probe_apply_filter_100k() {
        use std::time::Instant;

        let s = TabSession::new();
        let mut all: Vec<String> = Vec::with_capacity(100_000);
        for i in 0..100_000 {
            all.push(format!(
                "2026-01-01 12:00:00.000 [{}] [module{}] message id={} value={}",
                ["INFO", "DEBUG", "WARN", "ERROR"][i % 4],
                i % 20,
                i,
                i * 7
            ));
        }
        s.append_lines(all);

        // 重扫（含 clone 命中行）。
        let spec = FilterSpec {
            keywords: vec!["error".to_string()],
            regex: None,
            case_sensitive: false,
        };
        let t = Instant::now();
        let matched = s.apply_filter(spec);
        let el = t.elapsed();
        eprintln!("[perf] apply_filter 100k (25k hits, incl clone): {:?}, hits={}", el, matched.len());

        // JSON 序列化（emit 成本）。
        let t2 = Instant::now();
        let json = serde_json::to_string(&matched).unwrap();
        eprintln!("[perf] serialize {} hits to JSON: {:?}, bytes={}", matched.len(), t2.elapsed(), json.len());
    }
}
