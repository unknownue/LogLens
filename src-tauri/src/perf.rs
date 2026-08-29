//! 启动耗时打点：仅当环境变量 `LV_PERF_LOG` 指向一个文件路径时启用，
//! 以「进程启动后的毫秒数」追加写一行 `毫秒<TAB>标签`。
//! 平时零开销：未设置环境变量时所有 mark 直接返回（一次环境变量检查）。

use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Instant;

/// 进程启动基准时刻（第一次 mark 时定格）。
fn start() -> Instant {
    static T0: OnceLock<Instant> = OnceLock::new();
    *T0.get_or_init(Instant::now)
}

/// 打点日志文件路径（来自 LV_PERF_LOG；未设置则禁用打点）。
fn log_path() -> Option<&'static PathBuf> {
    static PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
    PATH.get_or_init(|| std::env::var_os("LV_PERF_LOG").map(PathBuf::from))
        .as_ref()
}

/// 记录一条打点（毫秒 + 标签）。未启用时为空操作。
pub fn mark(label: &str) {
    let Some(path) = log_path() else { return };
    let ms = start().elapsed().as_secs_f64() * 1_000.0;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(f, "{ms:>10.3}\t{label}");
    }
}
