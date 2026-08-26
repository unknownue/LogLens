//! Tauri 后端入口：注册命令、初始化后台日志监控。

mod filter;
mod state;
mod tail;

use std::sync::Arc;

use filter::FilterSpec;
use state::{start_watching, AppState};
use tail::LogLine;

/// 打开日志文件并开始 tail-follow。
#[tauri::command]
fn open_log_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<(), String> {
    let path = std::path::PathBuf::from(path);
    if !path.is_file() {
        return Err(format!("文件不存在: {}", path.display()));
    }

    // state 是 Arc<AppState> 的引用，clone 出独立 Arc 供后台线程使用。
    let shared = state.inner().clone();
    start_watching(app, shared, path);
    Ok(())
}

/// 设置过滤条件，返回重扫后的命中集（前端据此重建视图）。
#[tauri::command]
fn set_filter(
    state: tauri::State<'_, Arc<AppState>>,
    keywords: Vec<String>,
    regex: Option<String>,
    case_sensitive: bool,
) -> Result<Vec<LogLine>, String> {
    let spec = FilterSpec {
        keywords,
        regex,
        case_sensitive,
    };
    Ok(state.apply_filter(spec))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(AppState::new()))
        .invoke_handler(tauri::generate_handler![open_log_file, set_filter])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
