//! Tauri 后端入口：注册命令、初始化后台日志监控。

mod filter;
mod index;
pub mod perf;
mod state;
mod tail;

use std::sync::Arc;

use filter::FilterSpec;
use state::{start_watching_for_session, AppState, JumpPayload, LinesPayload};
use tail::LogLine;
use tauri::Emitter;
use tracing::instrument;

/// 初始化 Tracy 采样：仅 `tracy` feature 且环境变量 `TRACY=1` 时启用。
/// 平时为零开销（无 subscriber，所有 span 为空操作）。
#[cfg(feature = "tracy")]
fn init_tracy() {
    if std::env::var("TRACY").map(|v| v == "1").unwrap_or(false) {
        use tracing_subscriber::layer::SubscriberExt;
        use tracing_subscriber::Registry;
        let subscriber = Registry::default().with(tracing_tracy::TracyLayer::default());
        let _ = tracing::subscriber::set_global_default(subscriber);
        eprintln!("[perf] Tracy 采样已启用（请先运行 Tracy capture server）");
    }
}
#[cfg(not(feature = "tracy"))]
fn init_tracy() {}

/// 打开日志文件并开始 tail-follow（针对指定 tab）。
#[instrument(skip(app, state), fields(tab_id = %tab_id, path = %path))]
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
    let size = path.metadata().map(|m| m.len()).unwrap_or(0);
    perf::mark(&format!("open:start:{size}"));

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
    let total_lines = session.ensure_total_lines().unwrap_or(0);
    let avg_line_len = session.avg_line_len();
    let _ = app.emit(
        "log-lines",
        LinesPayload { tab_id, lines: matched.clone(), reset: true, total_lines, avg_line_len },
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
    perf::mark("get_lines");
    let session = state
        .get(&tab_id)
        .ok_or_else(|| format!("tab 不存在: {}", tab_id))?;
    Ok(session.current_view())
}

/// 历史行按需加载结果。
#[derive(serde::Serialize)]
struct HistoryPayload {
    lines: Vec<LogLine>,
    has_more: bool,
}

/// 加载指定 tab 的更早历史行（前端滚动到顶部时调用）。
#[instrument(skip(state), fields(tab_id = %tab_id, rows = rows))]
#[tauri::command]
fn load_history(
    state: tauri::State<'_, Arc<AppState>>,
    tab_id: String,
    rows: u64,
) -> Result<HistoryPayload, String> {
    let session = state
        .get(&tab_id)
        .ok_or_else(|| format!("tab 不存在: {}", tab_id))?;

    let (history, has_more, first_line_no) = {
        let mut rd = session.reader.lock();
        match rd.as_mut() {
            Some(r) => r
                .load_history(rows)
                .map_err(|e| format!("读取历史失败: {}", e))?,
            None => (Vec::new(), false, 0),
        }
    };

    let matched = session.prepend_history(history, first_line_no);
    Ok(HistoryPayload { lines: matched, has_more })
}

/// 按文件行号区间读取原始行（1-based `start_line` 起，至多 `count` 行）。
/// 稀疏虚拟列表使用：滚动到未加载区域时按块加载，双向（向上/向下）均可，
/// 使滚动条与全文件成比例、中段浏览只需一次请求。
#[instrument(skip(state), fields(tab_id = %tab_id, start_line, count))]
#[tauri::command]
fn get_range(
    state: tauri::State<'_, Arc<AppState>>,
    tab_id: String,
    start_line: u64,
    count: u64,
) -> Result<Vec<LogLine>, String> {
    let session = state
        .get(&tab_id)
        .ok_or_else(|| format!("tab 不存在: {}", tab_id))?;
    session.get_range(start_line, count)
}

/// 获取指定 tab 当前的文件总行数（懒计算并缓存；随追加实时增长）。
#[instrument(skip(state), fields(tab_id = %tab_id))]
#[tauri::command]
fn get_total_lines(
    state: tauri::State<'_, Arc<AppState>>,
    tab_id: String,
) -> Result<u64, String> {
    perf::mark("get_total_lines");
    let session = state
        .get(&tab_id)
        .ok_or_else(|| format!("tab 不存在: {}", tab_id))?;
    session.ensure_total_lines()
}

/// 每个稀疏块（`block_lines` 行/块，与前端 SPARSE_BLOCK_LINES 一致）的平均行长
/// （字节/行，来自行索引 64 行采样，无额外 IO）。前端据此按块估算未加载区域的
/// 占位行高：区域密度差异大时（堆栈/JSON 段 vs 短行），全局平均会让块加载后
/// 总高突变、滚动条跳变，表现为拖动幅度与实际进度不一致；按块估算后总高贴近
/// 真实值，滚动条映射稳定。索引未覆盖的块为 null（前端回退全局平均）。
#[instrument(skip(state), fields(tab_id = %tab_id, block_lines))]
#[tauri::command]
fn get_block_avg_lens(
    state: tauri::State<'_, Arc<AppState>>,
    tab_id: String,
    block_lines: u64,
) -> Result<Vec<Option<f64>>, String> {
    let session = state
        .get(&tab_id)
        .ok_or_else(|| format!("tab 不存在: {}", tab_id))?;
    Ok(session.block_avg_lens(block_lines))
}

/// 跳转到文件第 `line_no` 行（1-based）：加载其附近窗口并替换前端视图。
/// 与现有功能兼容：过滤条件继续生效（返回过滤后的窗口）、向上滚动仍可
/// 继续加载更早历史、尾部追加不受影响。
#[instrument(skip(state), fields(tab_id = %tab_id, line = line_no))]
#[tauri::command]
fn jump_to_line(
    state: tauri::State<'_, Arc<AppState>>,
    tab_id: String,
    line_no: u64,
) -> Result<JumpPayload, String> {
    let session = state
        .get(&tab_id)
        .ok_or_else(|| format!("tab 不存在: {}", tab_id))?;
    session.jump_to_line(line_no)
}

/// 前端首次绘制正文后的回执（打点用）：由前端在首屏内容渲染完成后调用一次。
#[tauri::command]
fn report_first_paint() {
    perf::mark("frontend:first-paint");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    perf::mark("run:start");
    init_tracy();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(AppState::new()))
        .setup(|_app| {
            perf::mark("webview:ready");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_log_file,
            set_filter,
            close_tab,
            get_lines,
            load_history,
            get_range,
            jump_to_line,
            get_total_lines,
            get_block_avg_lens,
            report_first_paint
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
