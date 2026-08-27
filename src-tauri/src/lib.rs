//! Tauri 后端入口：注册命令、初始化后台日志监控。

mod filter;
mod state;
mod tail;

use std::sync::Arc;

use filter::FilterSpec;
use state::{start_watching_for_session, AppState, LinesPayload};
use tail::LogLine;
use tauri::Emitter;

/// 打开日志文件并开始 tail-follow（针对指定 tab）。
#[tauri::command]
fn open_log_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    tab_id: String,
    path: String,
) -> Result<(), String> {
    let path = std::path::PathBuf::from(path);
    if !path.is_file() {
        return Err(format!("文件不存在: {}", path.display()));
    }

    let session = state.get_or_create(&tab_id);
    start_watching_for_session(app, tab_id, session, path);
    Ok(())
}

/// 设置过滤条件：更新指定 tab 的过滤状态，并通过 log-lines 事件（reset）下发结果。
#[tauri::command]
fn set_filter(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    tab_id: String,
    keywords: Vec<String>,
    regex: Option<String>,
    case_sensitive: bool,
) -> Result<Vec<LogLine>, String> {
    let spec = FilterSpec {
        keywords,
        regex,
        case_sensitive,
    };
    let session = state
        .get(&tab_id)
        .ok_or_else(|| format!("tab 不存在: {}", tab_id))?;
    let matched = session.apply_filter(spec);
    let _ = app.emit(
        "log-lines",
        LinesPayload { tab_id, lines: matched.clone(), reset: true },
    );
    Ok(matched)
}

/// 关闭指定 tab：停止其监控线程并移除会话。
#[tauri::command]
fn close_tab(state: tauri::State<'_, Arc<AppState>>, tab_id: String) -> Result<(), String> {
    state.close(&tab_id);
    Ok(())
}

/// 获取指定 tab 当前的过滤后视图（前端挂载时拉取，弥补挂载前错过的事件）。
#[tauri::command]
fn get_lines(
    state: tauri::State<'_, Arc<AppState>>,
    tab_id: String,
) -> Result<Vec<LogLine>, String> {
    let session = state
        .get(&tab_id)
        .ok_or_else(|| format!("tab 不存在: {}", tab_id))?;
    Ok(session.current_view())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(AppState::new()))
        .invoke_handler(tauri::generate_handler![open_log_file, set_filter, close_tab, get_lines])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
