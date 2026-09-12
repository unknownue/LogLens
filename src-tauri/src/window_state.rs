//! 窗口尺寸记忆：记住上一次退出时的窗口大小，下次打开时沿用。
//!
//! 放在后端而不是前端，有两个原因：
//!   1. **时机**：`setup` 钩子在窗口首次显示前就能 `set_size`，用户不会先看到
//!      默认的 800x600 再被跳变到记忆尺寸（前端方案必然有一次可见的跳变）。
//!   2. **可靠**：尺寸来自 Tauri 的窗口事件，不依赖前端挂载/卸载是否跑完；
//!      从任务栏关闭、系统关机等路径也都能落到。
//!
//! 只记忆**尺寸**，不记忆位置：位置涉及多显示器热插拔、分辨率变化、副屏拔掉后
//! 窗口落在屏幕外等一堆边界情况，收益不抵风险。
//!
//! 存储：`<app_data_dir>/window-size.json`，内容 `{"width":1600,"height":900}`（逻辑像素）。

use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{LogicalSize, Manager, WindowEvent};
use tracing::instrument;

/// 尺寸健全区间（逻辑像素）。超出即视为无效，退回默认尺寸。
/// 下限避免存成几乎不可用的窗口；上限用来挡掉损坏或手改文件里的离谱值。
const MIN_W: u32 = 320;
const MIN_H: u32 = 240;
const MAX_W: u32 = 20_000;
const MAX_H: u32 = 20_000;

/// 落盘前的静默窗口：拖动边框会连续触发 Resized，等用户停下来再写，
/// 避免把拖拽过程中的上百次中间尺寸写进磁盘。
const SAVE_DEBOUNCE: Duration = Duration::from_millis(500);

const FILE_NAME: &str = "window-size.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct WindowSize {
    width: u32,
    height: u32,
}

impl WindowSize {
    /// 是否是可用尺寸（异常值一律拒绝，交由默认尺寸兜底）。
    ///
    /// 也顺带挡掉窗口最小化时可能报出的 0 尺寸 —— 那会把记忆值抹成无效。
    fn is_sane(&self) -> bool {
        (MIN_W..=MAX_W).contains(&self.width) && (MIN_H..=MAX_H).contains(&self.height)
    }
}

fn sensible(w: u32, h: u32) -> Option<WindowSize> {
    let s = WindowSize { width: w, height: h };
    s.is_sane().then_some(s)
}

fn size_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(FILE_NAME))
}

/// 读取上次保存的窗口尺寸；文件缺失/损坏/越界都返回 None。
#[instrument(skip(app))]
fn load(app: &tauri::AppHandle) -> Option<WindowSize> {
    let path = size_file(app)?;
    let text = std::fs::read_to_string(&path).ok()?;
    match serde_json::from_str::<WindowSize>(&text) {
        Ok(size) if size.is_sane() => Some(size),
        Ok(size) => {
            tracing::warn!(
                width = size.width,
                height = size.height,
                "window-size.json 尺寸越界，忽略并沿用默认尺寸"
            );
            None
        }
        Err(e) => {
            tracing::warn!("window-size.json 解析失败，忽略并沿用默认尺寸: {e}");
            None
        }
    }
}

/// 把尺寸原子落盘（先写临时文件再 rename，避免崩溃/掉电留下半截 JSON）。
fn write(app: &tauri::AppHandle, size: WindowSize) {
    let Some(path) = size_file(app) else {
        return;
    };
    if let Some(dir) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(dir) {
            tracing::warn!("创建应用数据目录失败: {e}");
            return;
        }
    }
    let Ok(text) = serde_json::to_string(&size) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if let Err(e) = std::fs::write(&tmp, text) {
        tracing::warn!("写入窗口尺寸临时文件失败: {e}");
        return;
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        tracing::warn!("提交窗口尺寸失败: {e}");
    }
}

/// resize 落盘器：窗口事件线程只更新「最新尺寸 + 序号」，
/// 后台线程等静默 500ms 再写一次盘 —— 拖拽期间不反复写盘，也不在事件线程里做 IO。
struct SizeSaver {
    state: Mutex<SaverState>,
    cv: Condvar,
}

struct SaverState {
    /// 待写尺寸；None = 尚无变化。
    pending: Option<WindowSize>,
    /// 变化序号；写入方与落盘线程用它判断「是否有静默窗口内的新变化」。
    seq: u64,
}

impl SizeSaver {
    fn new() -> Self {
        Self {
            state: Mutex::new(SaverState { pending: None, seq: 0 }),
            cv: Condvar::new(),
        }
    }

    /// 记录最新尺寸并唤醒落盘线程（非阻塞，可安全地在窗口事件回调里调用）。
    fn update(&self, size: WindowSize) {
        if let Ok(mut g) = self.state.lock() {
            g.pending = Some(size);
            g.seq += 1;
            self.cv.notify_one();
        }
    }

    /// 落盘线程主循环：等变化 → 等静默 → 写盘。
    fn run(self: Arc<Self>, app: tauri::AppHandle) {
        let mut written_seq: u64 = 0;
        loop {
            let mut g = match self.state.lock() {
                Ok(g) => g,
                Err(_) => return, // 锁中毒：放弃落盘，不影响主流程
            };
            // 没有新变化就睡着等。
            while g.seq == written_seq {
                g = match self.cv.wait_timeout(g, Duration::from_secs(3600)) {
                    Ok((g, _)) => g,
                    Err(_) => return,
                };
            }
            // 静默窗口：期间每有新的 resize，就重新计时。
            loop {
                let before = g.seq;
                g = match self.cv.wait_timeout(g, SAVE_DEBOUNCE) {
                    Ok((g, _)) => g,
                    Err(_) => return,
                };
                if g.seq != before {
                    continue; // 静默窗口内又变了，重新等
                }
                break;
            }
            written_seq = g.seq;
            let size = g.pending;
            drop(g);
            if let Some(size) = size {
                write(&app, size);
            }
        }
    }
}

/// 启动时调用（在 `setup` 里、窗口首次显示前）：
///   1. 应用上次的尺寸；
///   2. 挂 resize 监听，把之后的尺寸变化持久化。
pub fn install(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        tracing::warn!("未找到 main 窗口，跳过窗口尺寸记忆");
        return;
    };

    // 1) 沿用上次尺寸。窗口尚未显示，这一步对用户不可见，因此不会出现
    //    「先看到默认尺寸再被改大」的跳变。
    match load(app) {
        Some(size) => match window.set_size(LogicalSize::new(size.width, size.height)) {
            Ok(()) => {
                perf_mark(&format!("winst:restored={}x{}", size.width, size.height));
                tracing::info!(
                    width = size.width,
                    height = size.height,
                    "已沿用上次的窗口尺寸"
                );
            }
            Err(e) => {
                perf_mark(&format!("winst:restore_failed:{e}"));
                tracing::warn!("应用上次窗口尺寸失败: {e}");
            }
        },
        None => {
            perf_mark("winst:no_history");
            tracing::info!("无历史窗口尺寸，使用默认尺寸");
        }
    }

    // 2) 监听后续变化并持久化。
    let saver = Arc::new(SizeSaver::new());
    let saver_writer = Arc::clone(&saver);
    let app_for_thread = app.clone();
    if let Err(e) = std::thread::Builder::new()
        .name("window-size-saver".into())
        .spawn(move || saver_writer.run(app_for_thread))
    {
        tracing::warn!("启动窗口尺寸落盘线程失败: {e}");
    }

    let win_handle = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Resized(physical) = event {
            // 事件给的是物理像素；记忆值按逻辑像素统一存放，
            // 这样换显示器（缩放比不同）后窗口的「观感大小」保持一致。
            let logical = physical.to_logical::<u32>(win_handle.scale_factor().unwrap_or(1.0));
            if let Some(size) = sensible(logical.width, logical.height) {
                saver.update(size);
            }
        }
    });
}

/// 打点：沿用项目既有的 `LV_PERF_LOG` 通道（未设置环境变量时是空操作），
/// 便于排查「尺寸没恢复」这类问题。
fn perf_mark(label: &str) {
    crate::perf::mark(label);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sz(w: u32, h: u32) -> WindowSize {
        WindowSize { width: w, height: h }
    }

    #[test]
    fn typical_sizes_are_accepted() {
        for (w, h) in [(800, 600), (1024, 768), (1920, 1080), (3840, 2160)] {
            assert!(sz(w, h).is_sane(), "{w}x{h} 应被接受");
        }
    }

    /// 0 尺寸是真实会遇到的脏值（窗口最小化时可能报 0）——
    /// 若被当成有效值存下来，下次启动就会得到一个不可用的窗口，
    /// 而且记忆值会被永久抹掉，所以必须拒绝。
    #[test]
    fn zero_and_tiny_sizes_are_rejected() {
        assert!(!sz(0, 0).is_sane());
        assert!(!sz(0, 600).is_sane());
        assert!(!sz(800, 0).is_sane());
        assert!(!sz(MIN_W - 1, MIN_H - 1).is_sane());
        // 边界值本身应当接受。
        assert!(sz(MIN_W, MIN_H).is_sane());
    }

    #[test]
    fn absurd_sizes_are_rejected() {
        assert!(!sz(99_999, 10).is_sane());
        assert!(!sz(MAX_W + 1, 600).is_sane());
        assert!(!sz(800, MAX_H + 1).is_sane());
        assert!(sz(MAX_W, MAX_H).is_sane());
    }

    /// 文件里存的就是这个形状；解析失败/越界都必须退回 None（用默认尺寸），
    /// 而不是让应用启动失败。
    #[test]
    fn json_shape_round_trips_and_garbage_is_rejected() {
        let text = serde_json::to_string(&sz(1280, 720)).unwrap();
        assert_eq!(text, r#"{"width":1280,"height":720}"#);
        let back: WindowSize = serde_json::from_str(&text).unwrap();
        assert_eq!(back, sz(1280, 720));

        assert!(serde_json::from_str::<WindowSize>("not json").is_err());
        assert!(serde_json::from_str::<WindowSize>("{}").is_err());
        // 解析成功但越界 -> is_sane 拦下（load 里据此返回 None）。
        let out_of_range: WindowSize = serde_json::from_str(r#"{"width":99999,"height":10}"#).unwrap();
        assert!(!out_of_range.is_sane());
    }

    #[test]
    fn sensible_wraps_is_sane() {
        assert!(sensible(1200, 800).is_some());
        assert!(sensible(0, 0).is_none());
        assert!(sensible(99_999, 99_999).is_none());
    }
}
