//! 共享状态与后台文件监控线程。
//!
//! 多 tab：每个 tab 对应一个 TabSession（独立日志缓冲、过滤、文件监控线程），
//! AppState 用 HashMap<tab_id, TabSession> 管理所有会话。

use std::collections::HashMap;
use std::io::{Read, Seek};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;

use notify::{RecursiveMode, Watcher};
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};
use tracing::{info_span, instrument};

use crate::encoding::{self, EncodingDef, EncodingInfo, Resolved};
use crate::filter::{Filter, FilterSpec};
use crate::index::{LineIndex, SharedIndex, SCAN_CHUNK_BYTES};
use crate::perf;
use crate::search::{self, MatchKind, SearchHit, SearchPage};
use crate::tail::{LogLine, TailEvent, TailReader};

/// 传给前端的一批行事件负载（带 tab_id 用于前端路由到对应 tab）。
#[derive(Clone, serde::Serialize)]
pub struct LinesPayload {
    pub tab_id: String,
    pub lines: Vec<LogLine>,
    pub reset: bool,
    /// **暂停跟随时是否仍要应用这批整体替换**（只有 `reset = true` 时有意义）。
    ///
    /// 为什么需要这个字段：前端的「自动刷新」开关会丢弃实时批次（那正是暂停的意思
    /// —— 别动我的视图）。但「整体替换」有三个来源，它们的性质并不相同：
    ///
    /// - **会话重建**（打开文件、`set_encoding` 换编码）：用户刚做的一个动作，
    ///   必须生效。被暂停开关吞掉的话，正文会**永远**停在旧编码解出来的内容上，
    ///   而且不会自愈 —— 这个事件不会再发第二次。→ `true`
    /// - **轮转 / 截断**：实时跟踪的自然结果，暂停时不该打断用户正在看的内容。→ `false`
    /// - **过滤条件重扫**：暂停期间不应用，恢复跟随时由 `toggleAutoRefresh` 统一补齐
    ///   （那是前端既有的设计，这里保持不动）。→ `false`
    pub apply_when_paused: bool,
    /// 文件当前总行数（实时，随追加增长；轮转后从 0 重新计）。
    pub total_lines: u64,
    /// 平均行长（字节/行，来自行索引覆盖区）：前端占位行高度/滚动条比例的估算依据。
    pub avg_line_len: Option<f64>,
}

/// 单个 tab 的会话状态。
pub struct TabSession {
    /// 全部已加载行（原文，用于过滤条件变化时重扫）。
    pub all_lines: Mutex<Vec<LogLine>>,
    /// 当前过滤条件。
    pub filter: Mutex<Filter>,
    /// 单调递增的行偏移（用于给新行分配稳定 file_offset）。
    pub next_offset: AtomicI64,
    /// 历史行的 file_offset（负值递减，插入头部时使用）。
    pub history_offset: AtomicI64,
    /// 当前打开的日志文件路径。
    pub file_path: Mutex<Option<PathBuf>>,
    /// 文件读取器（后台线程与 load_history 命令共用）。
    pub reader: Mutex<Option<TailReader>>,
    /// 行索引（与 reader 共享同一实例）：行号 ↔ 字节偏移 O(采样间隔) 定位。
    pub index: Mutex<SharedIndex>,
    /// 停止信号：置 true 后监控线程退出（关闭 tab 时 / 会话被换掉时）。
    pub stop: Arc<AtomicBool>,
    /// 「发事件」与「被新会话取代」之间的互斥闸门。
    ///
    /// 为什么需要它：`set_encoding` 会整体换掉会话（见 [`AppState::replace_session`]），
    /// 而旧会话的监控线程可能正处在「已经取好一批行、还没 emit」的中间态。若它抢在
    /// 新会话的 `reset` 事件**之后**送达，前端会把旧编码解出来的行**追加**到新视图上
    /// （旧事件 `reset = false`，语义正是「追加」）—— 表现为正文里混着一段乱码。
    ///
    /// 闸门把这两件事串起来：监控线程持锁发事件，取代方持锁置 `stop`。于是旧会话的
    /// 最后一个事件一定落在新会话的 reset **之前**，前端状态天然自洽；代价是
    /// `replace_session` 可能等一次 emit（毫秒级）。
    pub emit_gate: Mutex<()>,
    /// 文件总行数缓存（懒计算；文件轮转/截断时失效）。用于「跳转到行」的范围校验。
    pub total_lines: Mutex<Option<u64>>,
    /// 本 tab 的文本编码：用户的**选择**（`auto` 或目录 id）+ 解析出的编码定义。
    ///
    /// 选择与解析结果都要存：状态栏要显示「自动 → GB18030」这类信息，而重新打开
    /// 文件时要沿用用户的原始选择（`auto` 得继续自动探测，不能固化成上次的结果）。
    /// 解析结果在 `start_watching_for_session` 里按文件内容定下，之后只读。
    pub encoding: Mutex<Option<(String, Resolved)>>,
}

/// 每 tab 行数上限：防长时间运行 + 高频日志导致内存无限增长。
/// 20 万行（约 70 字节/行）≈ 14MB，可接受。
const MAX_LINES_PER_TAB: usize = 200_000;
/// 触发裁剪时保留的行数（留 2 万余量，避免每次追加都裁剪 O(n)）。
const TRIM_TO_LINES: usize = 180_000;

/// 「跳转到行」窗口：目标行前后各一半。
const JUMP_WINDOW_LINES: u64 = 3000;
/// 窗口起点到文件尾不超过该行数时，窗口直接延伸到 EOF，
/// 避免跳转后「下方断层」（向上滚动仍可继续加载更早历史）。
const JUMP_EXTEND_TO_EOF_MAX: u64 = 50_000;

/// 「跳转到行」命令的返回负载。
#[derive(serde::Serialize)]
pub struct JumpPayload {
    /// 窗口内经过滤的命中行（整体替换前端视图）。
    pub lines: Vec<LogLine>,
    /// 目标行在 lines 中的下标（前端滚动定位用）。
    pub target_index: usize,
    /// 目标行是否出现在过滤后的视图中。
    pub target_visible: bool,
    /// 文件总行数。
    pub total_lines: u64,
    /// 窗口起点之前是否还有更早的历史。
    pub has_more: bool,
    /// 窗口第一行的文件行号（1-based）。
    pub first_line_no: u64,
}

impl TabSession {
    pub fn new() -> Self {
        Self {
            all_lines: Mutex::new(Vec::new()),
            filter: Mutex::new(Filter::new(FilterSpec::default())),
            next_offset: AtomicI64::new(0),
            history_offset: AtomicI64::new(-1),
            file_path: Mutex::new(None),
            reader: Mutex::new(None),
            index: Mutex::new(std::sync::Arc::new(parking_lot::Mutex::new(LineIndex::new()))),
            stop: Arc::new(AtomicBool::new(false)),
            emit_gate: Mutex::new(()),
            total_lines: Mutex::new(None),
            encoding: Mutex::new(None),
        }
    }

    /// 当前生效的编码定义：决定换行符形态与解码方式。
    ///
    /// 未打开文件（或解析结果缺失）时按 UTF-8 兜底 —— 此时没有任何字节可读，
    /// 返回什么都不影响结果，但让调用点不必处理 Option。
    pub fn encoding_def(&self) -> &'static EncodingDef {
        self.encoding
            .lock()
            .as_ref()
            .map(|(_, r)| r.def)
            .unwrap_or_else(encoding::utf8)
    }

    /// 当前编码信息的 IPC 载荷（未打开文件 → None）。
    pub fn encoding_info(&self) -> Option<EncodingInfo> {
        self.encoding
            .lock()
            .as_ref()
            .map(|(choice, r)| encoding::info(choice, *r))
    }

    /// 记下「用户选择 + 解析结果」。
    pub fn set_encoding_resolved(&self, choice: String, resolved: Resolved) {
        *self.encoding.lock() = Some((choice, resolved));
    }

    /// 取出行索引的共享句柄（克隆 Arc，不长期占外层锁；再 `.lock()` 即得独占访问）。
    fn idx(&self) -> SharedIndex {
        self.index.lock().clone()
    }

    /// 平均行长（索引覆盖区字节 ÷ 完整行数）：前端占位行高度/滚动条比例的估算依据。
    pub fn avg_line_len(&self) -> Option<f64> {
        self.idx().lock().avg_line_len()
    }

    /// 每个稀疏块（`block_lines` 行/块，与前端 SPARSE_BLOCK_LINES 一致）的平均行长。
    /// 由行索引 64 行采样纯算术推算（无 IO）；`ensure_total_lines` 保证索引已覆盖
    /// 到 EOF，因此各块基本都有值。前端据此按块估算占位行高，使滚动条总高
    /// 贴近真实内容，消除块加载后滚动条跳变（拖动幅度与进度不一致的根因）。
    pub fn block_avg_lens(&self, block_lines: u64) -> Vec<Option<f64>> {
        let total = self.ensure_total_lines().unwrap_or(0);
        self.idx().lock().block_avg_lens(block_lines, total)
    }

    /// 分配一个新的 file_offset。
    fn alloc_offset(&self) -> i64 {
        self.next_offset.fetch_add(1, Ordering::SeqCst)
    }

    /// 设置过滤条件并重扫已加载行，返回新的命中集。
    #[instrument(skip(self))]
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

    /// 当前过滤条件（原始 spec）：换编码重建会话时原样搬到新会话。
    pub fn filter_spec(&self) -> FilterSpec {
        self.filter.lock().spec().clone()
    }

    /// 返回当前过滤后的视图（用于前端挂载时拉取，弥补挂载前错过的事件）。
    pub fn current_view(&self) -> Vec<LogLine> {
        let filter = self.filter.lock();
        let lines = self.all_lines.lock();
        lines.iter().filter(|l| filter.matches(&l.text)).cloned().collect()
    }

    /// 追加新行（经过滤），返回命中的行。
    /// `first_line_no`：本批首行在文件中的行号（1-based）。
    #[instrument(skip(self), fields(count = new_lines.len()))]
    fn append_lines(&self, new_lines: Vec<String>, first_line_no: u64) -> Vec<LogLine> {
        let filter = self.filter.lock();
        let mut all = self.all_lines.lock();
        let mut matched = Vec::new();
        for (i, text) in new_lines.into_iter().enumerate() {
            let file_line = first_line_no + i as u64;
            if filter.matches(&text) {
                let off = self.alloc_offset();
                let line = LogLine::new(off, file_line, text.clone());
                matched.push(line.clone());
                all.push(line);
            } else {
                // 未命中也要保留到 all_lines（供过滤条件变化重扫）。
                let off = self.alloc_offset();
                all.push(LogLine::new(off, file_line, text));
            }
        }
        // 行数有界化：超过上限时裁剪最旧的行（tail 场景丢弃历史最合理）。
        // 裁剪到 TRIM_TO_LINES 留余量，使裁剪均摊为 O(1)。
        if all.len() > MAX_LINES_PER_TAB {
            let excess = all.len() - TRIM_TO_LINES;
            all.drain(0..excess);
        }
        matched
    }

    /// 清空（截断/轮转/打开新文件时）。
    fn clear(&self) {
        self.all_lines.lock().clear();
    }

    /// 把更早的历史行插入到已加载行的头部（经过滤返回命中的行）。
    /// 历史行分配负 file_offset（递减），保证与现有行标识不冲突。
    /// 保持 i64 传输：负数绝对值小，JSON/JS 精度无损，前端 key 不碰撞。
    /// `first_line_no`：本批首行在文件中的行号（1-based）。
    #[instrument(skip(self), fields(count = history.len()))]
    pub fn prepend_history(&self, history: Vec<String>, first_line_no: u64) -> Vec<LogLine> {
        if history.is_empty() {
            return Vec::new();
        }
        let filter = self.filter.lock();
        let mut all = self.all_lines.lock();

        let mut items: Vec<LogLine> = Vec::with_capacity(history.len());
        for (i, text) in history.into_iter().enumerate() {
            let off = self.history_offset.fetch_sub(1, Ordering::SeqCst);
            let line = LogLine::new(off, first_line_no + i as u64, text);
            items.push(line);
        }

        let mut matched = Vec::new();
        for line in &items {
            if filter.matches(&line.text) {
                matched.push(line.clone());
            }
        }

        // 头部插入历史行（O(n) 移动，n 为窗口上限 20 万，约亚毫秒级）。
        all.splice(0..0, items);

        // 行数有界化（历史行在最旧端，超出窗口时被自然裁剪）。
        if all.len() > MAX_LINES_PER_TAB {
            let excess = all.len() - TRIM_TO_LINES;
            all.drain(0..excess);
        }
        matched
    }

    /// 文件总行数（懒计算并缓存；轮转/截断后由监控线程失效）。
    /// 首选监控线程每 100ms 刷新的 O(1) 缓存；缓存缺失时走行索引
    /// （后台预热任务通常已扫到 EOF，此处为 O(1)；未完成时按需补扫一次）。
    pub fn ensure_total_lines(&self) -> Result<u64, String> {
        {
            let cached = self.total_lines.lock();
            if let Some(n) = *cached {
                return Ok(n);
            }
        }
        let path = self
            .file_path
            .lock()
            .clone()
            .ok_or_else(|| "tab 未打开文件".to_string())?;
        let n = self
            .idx()
            .lock()
            .total_lines(&path)
            .map_err(|e| format!("统计行数失败: {e}"))?;
        *self.total_lines.lock() = Some(n);
        Ok(n)
    }

    /// 按文件行号区间读取原始行（1-based `start_line` 起，至多 `count` 行）。
    /// 稀疏视图模式使用：前端滚动到未加载区域时按块调用，双向均可。
    /// 不经过滤（稀疏模式 = 无过滤），行号/文本与文件原文一致。
    #[instrument(skip(self), fields(start_line, count))]
    pub fn get_range(&self, start_line: u64, count: u64) -> Result<Vec<LogLine>, String> {
        if count == 0 || start_line == 0 {
            return Ok(Vec::new());
        }
        let path = self
            .file_path
            .lock()
            .clone()
            .ok_or_else(|| "tab 未打开文件".to_string())?;

        let total = self.ensure_total_lines()?;
        if start_line > total {
            return Ok(Vec::new());
        }
        let end_line = (start_line - 1 + count).min(total); // 0-based 开区间终点
        let (start_off, end_off) = self
            .idx()
            .lock()
            .locate_range(&path, start_line - 1, end_line)
            .map_err(|e| format!("定位行失败: {e}"))?;
        if end_off <= start_off {
            return Ok(Vec::new());
        }

        let mut file = crate::tail::open_shared_file(&path)
            .map_err(|e| format!("打开文件失败: {e}"))?;
        file.seek(std::io::SeekFrom::Start(start_off))
            .map_err(|e| format!("seek 失败: {e}"))?;
        let mut buf = vec![0u8; (end_off - start_off) as usize];
        file.read_exact(&mut buf)
            .map_err(|e| format!("读取行区间失败: {e}"))?;
        // 起点偏移参与切分：UTF-16 的换行对齐判定与「首行剥 BOM」都依赖它。
        let texts = encoding::split_inclusive(&buf, start_off, self.encoding_def());

        let mut items: Vec<LogLine> = Vec::with_capacity(texts.len());
        for (i, text) in texts.into_iter().enumerate() {
            let off = self.alloc_offset();
            let file_line = start_line + i as u64;
            items.push(LogLine::new(off, file_line, text));
        }
        Ok(items)
    }

    /// 正文内搜索：纯前向、不做全局计数（产品决策），一次调用返回一段命中窗口。
    ///
    /// - **范围随过滤状态切换**：过滤生效时搜「过滤后的行」（用户看得见的那些行）；
    ///   未生效时从 `from_file_line` 对应的字节偏移起**流式**扫描整个文件
    ///   （分块读取，不把文件读进内存）。
    /// - `from_file_line` 为 1-based 且**含**该行；起点超出文件末尾 → 空页（不报错）。
    /// - 空/全空白查询 → 空页（`complete: true`），不报错。
    /// - 命中封顶 [`search::SEARCH_HIT_CAP`]：越限时 `complete = false`（后面可能还有）。
    ///
    /// 锁：只在「定位起始行」时短暂持有行索引锁（与 [`Self::get_range`] 一致），
    /// 随后的整文件扫描只用独立文件句柄，不长时间挡住 tail / 后台索引线程。
    #[instrument(skip(self), fields(from_file_line, query_len = query.chars().count()))]
    pub fn search_forward(
        &self,
        query: &str,
        kind: MatchKind,
        case_sensitive: bool,
        from_file_line: u64,
    ) -> Result<SearchPage, String> {
        let from = from_file_line.max(1);
        let filter_active = self.filter.lock().is_active();

        // 空/全空白查询：空页（不回落到「命中所有行」，也不报错）。
        if query.trim().is_empty() {
            let scope_total = if filter_active {
                self.current_view().len() as u64
            } else {
                self.ensure_total_lines().unwrap_or(0)
            };
            return Ok(SearchPage::empty(scope_total));
        }

        // 过滤态：范围就是「过滤后的行」——前端当前渲染的那些行。
        // 先取出视图再扫描（扫描期间不持锁），避免长时间阻塞 tail 线程的追加。
        if filter_active {
            let view = self.current_view();
            let scope_total = view.len() as u64;
            let ac = search::build_matcher(query, case_sensitive)?;
            let mut hits: Vec<SearchHit> = Vec::new();
            let mut capped = false;
            for line in &view {
                if line.file_line < from {
                    continue;
                }
                if search::collect_line_hits(&ac, kind, &line.text, line.file_line, &mut hits) {
                    capped = true;
                    break;
                }
            }
            return Ok(SearchPage {
                hits,
                complete: !capped,
                scope_total,
            });
        }

        // 未过滤态：整文件流式扫描（不依赖已加载窗口，也不整文件入内存）。
        let path = self
            .file_path
            .lock()
            .clone()
            .ok_or_else(|| "tab 未打开文件".to_string())?;
        let total = self.ensure_total_lines()?;
        // 起始行 → 字节偏移：短锁内定位（行索引内部按需补扫），随后释放锁再扫描。
        let start_off = {
            let shared = self.idx();
            let mut idx = shared.lock();
            idx.locate_line(&path, from)
                .map_err(|e| format!("定位行失败: {e}"))?
        };
        let Some(start_off) = start_off else {
            return Ok(SearchPage::empty(total)); // 起点已超出文件末尾
        };
        let ac = search::build_matcher(query, case_sensitive)?;
        let (hits, complete) =
            search::scan_file_from(&path, start_off, from, &ac, kind, self.encoding_def())?;
        Ok(SearchPage {
            hits,
            complete,
            scope_total: total,
        })
    }

    /// 失效总行数缓存（文件截断/轮转/重新打开时调用）。
    pub fn invalidate_total_lines(&self) {
        *self.total_lines.lock() = None;
    }

    /// 跳转到文件第 `line_no` 行（1-based；`0` 表示最后一行）：
    /// 加载其附近的窗口（默认前后各 1500 行；距文件尾近时延伸到 EOF），
    /// 整体替换已加载视图，并把历史加载游标移到窗口起点——
    /// 之后向上滚动仍可继续加载更早的历史，与现有 on-demand 加载完全兼容。
    /// 返回的 lines 是**过滤后**的窗口视图；目标行被过滤时 target_index
    /// 指向窗口内最接近的命中行。
    #[instrument(skip(self), fields(line_no))]
    pub fn jump_to_line(&self, line_no: u64) -> Result<JumpPayload, String> {
        let total = self.ensure_total_lines()?;
        if total == 0 {
            return Err("文件为空".to_string());
        }
        let line_no = if line_no == 0 { total } else { line_no };
        if line_no > total {
            return Err(format!("行号超出范围：文件共 {total} 行"));
        }
        let target = line_no - 1; // 0-based
        let half = JUMP_WINDOW_LINES / 2;
        let start_line = target.saturating_sub(half);
        let mut end_line = (target + half).min(total);
        if total.saturating_sub(start_line) <= JUMP_EXTEND_TO_EOF_MAX {
            end_line = total; // 距尾部近：窗口延伸到 EOF，避免下方断层
        }

        let path = self
            .file_path
            .lock()
            .clone()
            .ok_or_else(|| "tab 未打开文件".to_string())?;
        // 行索引定位：O(采样间隔)，不再从文件头全扫（原 line_range_offsets 的 O(文件大小)）。
        let (start_off, end_off) = self
            .idx()
            .lock()
            .locate_range(&path, start_line, end_line)
            .map_err(|e| format!("定位行失败: {e}"))?;

        // 读取窗口字节并切行（末行无换行也保留）。
        let mut file = crate::tail::open_shared_file(&path)
            .map_err(|e| format!("打开文件失败: {e}"))?;
        file.seek(std::io::SeekFrom::Start(start_off))
            .map_err(|e| format!("seek 失败: {e}"))?;
        let mut buf = vec![0u8; (end_off - start_off) as usize];
        file.read_exact(&mut buf)
            .map_err(|e| format!("读取窗口失败: {e}"))?;
        let window_texts = encoding::split_inclusive(&buf, start_off, self.encoding_def());

        // 生成行对象（alloc 新 id，保证与既有行/历史行标识不冲突），
        // 并记录目标行在窗口内的位置。
        let target_window_idx = target - start_line;
        let filter = self.filter.lock();
        let mut items: Vec<LogLine> = Vec::with_capacity(window_texts.len());
        let mut target_id: Option<i64> = None;
        for (i, text) in window_texts.into_iter().enumerate() {
            let off = self.alloc_offset();
            if i as u64 == target_window_idx {
                target_id = Some(off);
            }
            let file_line = start_line + 1 + i as u64; // 1-based 文件行号
            items.push(LogLine::new(off, file_line, text));
        }
        let target_id = target_id.unwrap_or_else(|| self.alloc_offset());

        let mut matched = Vec::new();
        for line in &items {
            if filter.matches(&line.text) {
                matched.push(line.clone());
            }
        }
        let target_visible = matched.iter().any(|l| l.file_offset == target_id);
        let target_index = matched
            .iter()
            .position(|l| l.file_offset >= target_id)
            .unwrap_or_else(|| matched.len().saturating_sub(1));

        // 替换已加载视图（不再是「头部历史 + 尾部追加」的连续段，而是跳转窗口）。
        *self.all_lines.lock() = items;
        // 历史加载游标移到窗口起点：向上滚动继续加载更早内容。
        {
            let mut rd = self.reader.lock();
            if let Some(r) = rd.as_mut() {
                r.set_history_start(start_off, start_line + 1);
            }
        }

        Ok(JumpPayload {
            lines: matched,
            target_index,
            target_visible,
            total_lines: total,
            has_more: start_line > 0,
            first_line_no: start_line + 1,
        })
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
            // 与监控线程的 emit 互斥：确保「关掉之后」不再有事件发出。
            let _gate = s.emit_gate.lock();
            s.stop.store(true, Ordering::SeqCst);
        }
    }

    /// 换掉指定 tab 的会话（换编码时用），返回新会话。
    ///
    /// 为什么整体换会话而不是就地改字段：编码决定**换行符的字节形态**
    /// （UTF-8 是 1 字节、UTF-16 是 2 字节），一旦变，行索引的采样偏移、pending
    /// 残片、已加载窗口全部失效。就地重置要在五六个字段上各写一遍，漏一处就是
    /// 「行号对但内容错位」这种极难查的 bug；新建一个 TabSession 天然干净。
    ///
    /// 唯一需要搬过去的是**过滤条件**：用户不该因为换个编码就丢掉正在过滤的关键词。
    /// 旧会话的监控线程与索引预热任务随后由 `stop` 信号退出（新会话是新的 stop）。
    ///
    /// **顺序很重要**：先建好新会话（此时还没人知道它），再拿旧会话的 `emit_gate`
    /// 置 `stop`，最后替换 map 里的条目。持闸门置位保证旧会话的最后一个事件一定
    /// 先于新会话的首次 reset 送达前端；而替换放在置位之后，则保证任何在
    /// `get()` 里读到旧会话的命令（如并发的 `set_filter`）不会对着一个「已经不在
    /// map 里」的会话操作。
    pub fn replace_session(&self, tab_id: &str) -> Arc<TabSession> {
        let mut sessions = self.sessions.lock();
        let filter_spec = sessions.get(tab_id).map(|s| s.filter_spec());
        let fresh = Arc::new(TabSession::new());
        if let Some(spec) = filter_spec {
            fresh.apply_filter(spec);
        }
        if let Some(old) = sessions.get(tab_id) {
            let _gate = old.emit_gate.lock();
            old.stop.store(true, Ordering::SeqCst);
        }
        sessions.insert(tab_id.to_string(), fresh.clone());
        fresh
    }
}

/// 为指定 tab 的会话启动文件监控（命令层先 get_or_create 会话）。
///
/// `encoding_choice` 是用户的**选择**（`auto` 或目录 id，见 [`crate::encoding`]）：
/// 这里把它解析成具体编码（`auto` 会读文件头部探测），解析结果写回会话并用于
/// 建 reader（换行形态 + 解码）。返回解析出的编码信息，供前端状态栏显示。
pub fn start_watching_for_session(
    app: AppHandle,
    tab_id: String,
    session: Arc<TabSession>,
    path: PathBuf,
    encoding_choice: String,
) -> EncodingInfo {
    // 打开新文件：清空该 tab 旧文件的残留状态。
    session.clear();
    session.invalidate_total_lines();

    // 编码解析要在建 reader 之前：换行符形态由它决定。
    let resolved = encoding::resolve(&path, &encoding_choice);
    session.set_encoding_resolved(encoding_choice, resolved);
    let info = session
        .encoding_info()
        .expect("刚刚写入过编码信息，必然存在");
    let def = resolved.def;

    // 先加载初始尾部。
    perf::mark("open:tail-start");
    let mut reader = TailReader::new(path.clone(), def);
    let (initial, first_line_no) = match reader.init_tail(1000) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[tail] init_tail failed: {}", e);
            (Vec::new(), 1)
        }
    };
    perf::mark("open:tail-done");
    let matched = session.append_lines(initial, first_line_no);
    let total_lines = reader.total_lines();
    let avg_line_len = reader.index.lock().avg_line_len();
    // reset=true：告知前端这是全新加载，替换现有视图而非追加。
    // apply_when_paused=true：打开文件 / 换编码都是用户动作，暂停跟随也得生效
    //（否则换个编码正文却不动 —— 见 LinesPayload::apply_when_paused）。
    //
    // 持 emit_gate 发：与 replace_session / close 的置 stop 互斥，保证同一个 tab 的
    // 两次「会话重建」事件不会被别的发射点插队颠倒顺序。
    {
        let _gate = session.emit_gate.lock();
        let _ = app.emit(
            "log-lines",
            LinesPayload {
                tab_id: tab_id.clone(),
                lines: matched,
                reset: true,
                apply_when_paused: true,
                total_lines,
                avg_line_len,
            },
        );
    }
    perf::mark("open:emit-done");

    *session.file_path.lock() = Some(path.clone());
    // 会话与 reader 共享同一行索引。
    *session.index.lock() = reader.index.clone();
    // reader 存入会话：后台线程与 load_history 命令共用。
    *session.reader.lock() = Some(reader);

    // 后台预热任务：把行索引扫到 EOF（之后定位/统计 O(1)）。
    spawn_index_scan(&session, path.clone());

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
                        let reopened = {
                            let mut rd = session.reader.lock();
                            rd.as_mut().map(|r| r.reopen()).transpose()
                        };
                        match reopened {
                            Ok(Some(())) => {
                                session.clear();
                                session.invalidate_total_lines();
                                pending_lines.clear();
                                pending_reset = true;
                                // 新文件：重新启动行索引预热。
                                spawn_index_scan(&session, path.clone());
                            }
                            Ok(None) => {}
                            Err(e) => {
                                eprintln!("[tail] reopen failed: {}", e);
                            }
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
            {
                let _span = info_span!("tail_poll").entered();
                let mut rd = session.reader.lock();
                match rd.as_mut().map(|r| r.poll()).transpose() {
                    Ok(Some(events)) => {
                        for e in events {
                            match e {
                                TailEvent::Lines {
                                    lines,
                                    first_line_no,
                                } => {
                                    pending_lines.extend(session.append_lines(lines, first_line_no));
                                }
                                TailEvent::Reset => {
                                    session.clear();
                                    session.invalidate_total_lines();
                                    pending_lines.clear();
                                    pending_reset = true;
                                    // 文件被截断/完全重写：行索引已失效，重新预热。
                                    spawn_index_scan(&session, path.clone());
                                }
                            }
                        }
                    }
                    Ok(None) => {}
                    Err(e) => {
                        eprintln!("[tail] poll failed: {}", e);
                    }
                }
            }

            // 到时间片则合并 flush 一批。
            if (pending_reset || !pending_lines.is_empty())
                && last_flush.elapsed() >= std::time::Duration::from_millis(POLL_INTERVAL_MS)
            {
                // 实时总行数（reader 游标推算，O(1)），并同步会话缓存（跳转范围校验用）。
                let (total_lines, avg_line_len) = {
                    let rd = session.reader.lock();
                    match rd.as_ref() {
                        Some(r) => {
                            let n = r.total_lines();
                            *session.total_lines.lock() = Some(n);
                            (n, r.index.lock().avg_line_len())
                        }
                        None => (0, None),
                    }
                };
                let payload = LinesPayload {
                    tab_id: tab_id.clone(),
                    lines: std::mem::take(&mut pending_lines),
                    reset: pending_reset,
                    // 监控线程只会产出「实时数据」的整体替换（轮转 / 截断 / 重写），
                    // 暂停跟随时前端应当丢弃，别打断用户正在看的内容。
                    apply_when_paused: false,
                    total_lines,
                    avg_line_len,
                };
                pending_reset = false;
                last_flush = std::time::Instant::now();
                // 过「取代闸门」再发：换编码会换掉整个会话，本线程可能已经是被取代
                // 的那个。持锁 emit 保证本批一定落在这个 tab 下一次 reset 之前，
                // 否则前端会把旧编码解出来的行追加到新视图上（见 TabSession::emit_gate）。
                let _gate = session.emit_gate.lock();
                if !stop.load(Ordering::SeqCst) {
                    let _span = info_span!("emit_log_lines", count = payload.lines.len()).entered();
                    let _ = app.emit("log-lines", payload);
                }
            }
        }
    });

    info
}

/// 后台行索引预热：分块把索引扫到 EOF（每块 [`SCAN_CHUNK_BYTES`]，块间释放锁，
/// 不与监控线程/命令线程抢 IO）。文件轮转后索引代际变化，本任务自动退出。
fn spawn_index_scan(session: &Arc<TabSession>, path: PathBuf) {
    let session = session.clone();
    let stop = session.stop.clone();
    std::thread::spawn(move || {
        let generation = session.idx().lock().generation;
        loop {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            let done = {
                let shared = session.idx();
                let mut idx = shared.lock();
                if idx.generation != generation {
                    break; // 文件已轮转/重开，新任务接管
                }
                match idx.scan_step(&path, SCAN_CHUNK_BYTES) {
                    Ok(done) => done,
                    Err(e) => {
                        eprintln!("[index] 后台扫描失败: {e}");
                        break;
                    }
                }
            };
            if done {
                break; // 已到 EOF；后续增长由按需补扫覆盖
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
        s.append_lines(owned, 1);
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

    /// 关键词模式与正则模式互斥：前端一次只填一个字段，
    /// 切换模式即整表重扫，两模式各自得到独立的命中集合。
    #[test]
    fn keyword_and_regex_modes_are_mutually_exclusive() {
        let lines = vec![
            "INFO login uid=12345", // 只命中正则  \d+
            "ERROR login failed",   // 只命中关键词 error
            "INFO uid=abc",         // 两者都不命中
        ];

        // 关键词模式：正则字段为空 => 只有 error 命中。
        let keyword_spec = FilterSpec {
            keywords: vec!["error".to_string()],
            regex: None,
            case_sensitive: false,
        };
        let kw = session_with(lines.clone()).apply_filter(keyword_spec);
        assert_eq!(kw.len(), 1);
        assert_eq!(kw[0].text, "ERROR login failed");

        // 正则模式：关键词字段为空 => 只有 uid=数字 命中。
        let regex_spec = FilterSpec {
            keywords: vec![],
            regex: Some(r"uid=\d+".to_string()),
            case_sensitive: false,
        };
        let re = session_with(lines.clone()).apply_filter(regex_spec);
        assert_eq!(re.len(), 1);
        assert_eq!(re[0].text, "INFO login uid=12345");

        // 二者命中集合互不相同 —— 证明模式切换确实换掉了过滤语义，
        // 而不是两种条件叠加（叠加会得到 2 行）。
        assert_ne!(kw[0].file_line, re[0].file_line);

        // 切回关键词模式：结果与第一次完全一致（模式切换可逆）。
        let back = session_with(lines).apply_filter(FilterSpec {
            keywords: vec!["error".to_string()],
            regex: None,
            case_sensitive: false,
        });
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].text, "ERROR login failed");
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

        let newly = s.append_lines(
            vec![
                "ERROR another db error".to_string(),
                "INFO still ok".to_string(),
                "ERROR third error".to_string(),
            ],
            10,
        );
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

    // ==================== 换编码：会话替换 ====================

    /// 换会话（`set_encoding` 的底层）：必须换成一个**新**会话、旧会话收到停止信号、
    /// 过滤条件搬过去。
    ///
    /// 三条都不能少：不换新会话 → 行索引/残片带着旧换行形态；不停旧会话 → 旧监控
    /// 线程继续往同一个 tab 发事件（正文混入旧编码的行）；不搬过滤条件 → 用户换个
    /// 编码就把正在过滤的关键词丢了。
    #[test]
    fn replace_session_stops_the_old_one_and_keeps_the_filter() {
        let state = AppState::new();
        let old = state.get_or_create("t1");
        old.apply_filter(FilterSpec {
            keywords: vec!["ERROR".to_string()],
            regex: None,
            case_sensitive: false,
        });
        assert!(old.filter.lock().is_active(), "前置条件：旧会话在过滤");

        let fresh = state.replace_session("t1");

        assert!(!std::sync::Arc::ptr_eq(&old, &fresh), "必须换成一个新会话");
        assert!(old.stop.load(Ordering::SeqCst), "旧会话必须收到停止信号");
        assert!(!fresh.stop.load(Ordering::SeqCst), "新会话不该带着停止信号");
        assert_eq!(
            fresh.filter_spec().keywords,
            vec!["ERROR".to_string()],
            "过滤条件必须搬到新会话"
        );
        assert!(fresh.filter.lock().is_active());
        let registered = state.get("t1").expect("会话应仍在 map 里");
        assert!(
            std::sync::Arc::ptr_eq(&registered, &fresh),
            "map 里的会话必须已经是新的那个"
        );
    }

    /// 会话不存在时 `replace_session` 也要能建出一个（等价于新建），不 panic。
    #[test]
    fn replace_session_on_a_missing_tab_creates_one() {
        let state = AppState::new();
        let fresh = state.replace_session("nope");
        assert!(!fresh.stop.load(Ordering::SeqCst));
        assert!(state.get("nope").is_some());
    }

    /// `LinesPayload` 的序列化契约：前端按这些键名读。
    ///
    /// 尤其是 `apply_when_paused` —— 它决定「暂停跟随时换编码要不要生效」。键名改动
    /// 不会编译报错，只会静默退化成「前端读到 undefined → 一律丢弃」，也就是这个
    /// 功能在暂停跟随时失效。
    #[test]
    fn lines_payload_serializes_with_the_documented_keys() {
        let json = serde_json::to_string(&LinesPayload {
            tab_id: "tab-1".to_string(),
            lines: vec![LogLine::new(1, 1, "hi".to_string())],
            reset: true,
            apply_when_paused: true,
            total_lines: 42,
            avg_line_len: Some(12.5),
        })
        .unwrap();
        assert!(json.contains(r#""tab_id":"tab-1""#), "{json}");
        assert!(json.contains(r#""reset":true"#), "{json}");
        assert!(json.contains(r#""apply_when_paused":true"#), "{json}");
        assert!(json.contains(r#""total_lines":42"#), "{json}");
        assert!(json.contains(r#""avg_line_len":12.5"#), "{json}");
    }

    #[test]
    fn current_view_returns_filtered_lines() {        let s = session_with(vec!["ERROR e1", "INFO i1", "ERROR e2"]);
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

    /// 回归测试：file_offset 必须唯一且落在 JS 安全整数范围内。
    /// 历史行曾用「负数 i64 as u64」分配（≈2^64），JSON 传到 JS 后超出
    /// Number.MAX_SAFE_INTEGER（2^53-1）导致精度丢失，相邻行 file_offset
    /// 碰撞 → 前端虚拟滚动按 key 缓存的测量值错乱 → 相邻行文字重叠。
    #[test]
    fn file_offsets_are_unique_and_js_safe() {
        use std::collections::HashSet;

        let s = TabSession::new();
        let tail: Vec<String> = (0..3000).map(|i| format!("tail line {i}")).collect();
        s.append_lines(tail, 1);
        let hist: Vec<String> = (0..5000).map(|i| format!("history line {i}")).collect();
        s.prepend_history(hist, 1);
        // 历史加载期间日志仍在写入：追加一批新行，验证正负区间仍不冲突。
        let more: Vec<String> = (0..1000).map(|i| format!("more line {i}")).collect();
        s.append_lines(more, 1);

        let all = s.all_lines.lock();
        let mut seen = HashSet::new();
        for l in all.iter() {
            let off = l.file_offset;
            assert!(
                off.unsigned_abs() < (1u64 << 53),
                "offset {off} 超出 JS 安全整数范围"
            );
            assert!(seen.insert(off), "file_offset {off} 重复！");
        }
        assert_eq!(seen.len(), 9000);
    }

    /// 「跳转到行」：窗口加载、目标定位、与历史按需加载的衔接。
    #[test]
    fn jump_to_line_loads_window_and_keeps_history_loading() {
        use std::io::Write;

        // 10 万行，行号 = index + 1。
        let mut f = tempfile::NamedTempFile::new().unwrap();
        for i in 0..100_000usize {
            writeln!(f, "line-{i:06}").unwrap();
        }
        f.flush().unwrap();
        let path = f.path().to_path_buf();

        let s = TabSession::new();
        *s.file_path.lock() = Some(path.clone());
        let mut reader = TailReader::new(path.clone(), encoding::utf8());
        let _ = reader.init_tail(10).unwrap();
        *s.index.lock() = reader.index.clone();
        *s.reader.lock() = Some(reader);

        // 中部跳转：总行数 - 窗口起点 = 51_500 > 50_000 → 不延伸 EOF，窗口 3000 行。
        let payload = s.jump_to_line(50_000).unwrap();
        assert_eq!(payload.total_lines, 100_000);
        assert_eq!(payload.lines.len(), 3000);
        assert_eq!(payload.first_line_no, 48_500); // start_line=48_499（0-based）→ 1-based 48_500
        assert_eq!(payload.target_index, 1500); // 目标 0-based 49_999 - 48_499
        assert!(payload.target_visible);
        assert!(payload.has_more);
        assert_eq!(payload.lines[1500].text, "line-049999");
        // 真实文件行号：窗口首行 48_500，目标行 50_000。
        assert_eq!(payload.lines[0].file_line, 48_500);
        assert_eq!(payload.lines[1500].file_line, 50_000);
        assert_eq!(payload.lines[2999].file_line, 51_499);
        assert_eq!(s.all_lines.lock().len(), 3000);

        // 向上滚动继续加载更早历史：应无缝衔接窗口起点之前的内容。
        let (hist, more, hist_first) = {
            let mut rd = s.reader.lock();
            rd.as_mut().unwrap().load_history(2000).unwrap()
        };
        assert!(more);
        assert!(!hist.is_empty());
        let hist_len = hist.len();
        let matched = s.prepend_history(hist, hist_first);
        assert_eq!(matched.len(), hist_len);
        assert_eq!(s.all_lines.lock().len(), 3000 + hist_len);
        // 边界行补全规则下：衔接后视图第一行是 read_start 后的首个完整行，
        // 末行是窗口第一行的前一行（完整保留，不再丢行）。
        // （行 = 11 字符 + '\n' = 12 字节；read_start = 48_499×12 - 512_000 = 69_988，
        //   落在 0-based 行 5_832 内，首个完整行 = 5_833；history_start 恰在
        //   0-based 行 48_499 的行首，缓冲以 \n 结尾，末行 = 0-based 48_498。）
        let first_line_no = s.all_lines.lock()[0].text.clone();
        let last_hist = s.all_lines.lock()[hist_len - 1].text.clone();
        assert_eq!(first_line_no, "line-005833");
        assert_eq!(last_hist, "line-048498");
        // 文件行号连续：历史首行 5_834，末行 48_499，窗口首行 48_500（无缝衔接）。
        assert_eq!(s.all_lines.lock()[0].file_line, 5_834);
        assert_eq!(s.all_lines.lock()[hist_len - 1].file_line, 48_499);
        assert_eq!(s.all_lines.lock()[hist_len].file_line, 48_500);
        assert_eq!(hist_first, 5_834);

        // 尾部跳转：距 EOF 近 → 窗口延伸到文件尾（无下方断层）。
        let tail_payload = s.jump_to_line(99_000).unwrap();
        assert_eq!(tail_payload.first_line_no, 97_500); // start_line=97_499
        assert_eq!(tail_payload.lines.len(), 2_501);
        assert_eq!(tail_payload.target_index, 1500);
        assert_eq!(tail_payload.lines[1500].file_line, 99_000);

        // 过滤兼容：仅命中目标行时，视图只含该行且定位准确。
        let spec = FilterSpec {
            keywords: vec!["line-049999".to_string()],
            regex: None,
            case_sensitive: false,
        };
        s.apply_filter(spec);
        let filtered = s.jump_to_line(50_000).unwrap();
        assert_eq!(filtered.lines.len(), 1);
        assert!(filtered.target_visible);
        assert_eq!(filtered.target_index, 0);
        assert_eq!(filtered.lines[0].text, "line-049999");
        assert_eq!(filtered.lines[0].file_line, 50_000);

        // 越界报错；line_no=0 表示最后一行（置底）。
        assert!(s.jump_to_line(100_001).is_err());
        s.apply_filter(FilterSpec::default()); // 清除过滤后置底
        let bottom = s.jump_to_line(0).unwrap();
        assert_eq!(bottom.lines.len(), 1_501); // target=99_999 → start=98_499
        assert_eq!(bottom.first_line_no, 98_500);
        assert_eq!(bottom.target_index, 1_500);
        assert_eq!(bottom.lines.last().unwrap().file_line, 100_000);
        // 空文件报错。
        let empty = TabSession::new();
        *empty.file_path.lock() = Some(PathBuf::from("不存在的文件"));
        assert!(empty.jump_to_line(1).is_err());
    }

    /// get_range：稀疏视图的按需区间读取（头部/中段/尾部，双向均可，与跳转兼容）。
    #[test]
    fn get_range_reads_arbitrary_line_ranges() {
        use std::io::Write;

        let mut f = tempfile::NamedTempFile::new().unwrap();
        for i in 0..50_000usize {
            writeln!(f, "R{i:05}").unwrap();
        }
        f.flush().unwrap();
        let path = f.path().to_path_buf();

        let s = TabSession::new();
        *s.file_path.lock() = Some(path.clone());
        let mut reader = TailReader::new(path.clone(), encoding::utf8());
        let _ = reader.init_tail(100).unwrap();
        *s.index.lock() = reader.index.clone();
        *s.reader.lock() = Some(reader);

        // 中段读取（稀疏滚动的典型场景）。
        let mid = s.get_range(20_001, 10_000).unwrap();
        assert_eq!(mid.len(), 10_000);
        assert_eq!(mid[0].file_line, 20_001);
        assert_eq!(mid[0].text, "R20000");
        assert_eq!(mid.last().unwrap().file_line, 30_000);
        assert_eq!(mid.last().unwrap().text, "R29999");

        // 头部读取。
        let head = s.get_range(1, 3).unwrap();
        assert_eq!(head.len(), 3);
        assert_eq!(head[0].text, "R00000");
        assert_eq!(head[2].file_line, 3);

        // 尾部越界截断（不越过 EOF）。
        let tail = s.get_range(49_998, 10).unwrap();
        assert_eq!(tail.len(), 3);
        assert_eq!(tail.last().unwrap().file_line, 50_000);

        // 空范围 / 越界起点 → 空。
        assert!(s.get_range(50_001, 10).unwrap().is_empty());
        assert!(s.get_range(100, 0).unwrap().is_empty());
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
        s.append_lines(all, 1);

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

    /// 性能探针：B4 行数上限——持续追加 30 万行的耗时与最终内存占用。
    #[test]
    fn perf_probe_bounded_lines_300k() {
        use std::time::Instant;

        let s = TabSession::new();
        let mut total_appended = 0usize;
        let t = Instant::now();
        for batch in 0..300 {
            let mut lines: Vec<String> = Vec::with_capacity(1000);
            for j in 0..1000 {
                lines.push(format!(
                    "2026-01-01 12:00:00.000 [INFO] [module{}] message id={} value={}",
                    (batch * 1000 + j) % 20,
                    batch * 1000 + j,
                    (batch * 1000 + j) * 7
                ));
            }
            total_appended += lines.len();
            s.append_lines(lines, 1);
        }
        let el = t.elapsed();

        let kept = s.all_lines.lock().len();
        let kept_bytes: usize = s.all_lines.lock().iter().map(|l| l.text.capacity()).sum();
        eprintln!(
            "[perf] bounded append {} lines: {:?}, kept={} (cap {}), kept_text_capacity≈{}MB",
            total_appended,
            el,
            kept,
            MAX_LINES_PER_TAB,
            kept_bytes / (1024 * 1024)
        );
        // 最终行数应落在 [TRIM_TO_LINES, MAX_LINES_PER_TAB] 区间。
        assert!(kept >= TRIM_TO_LINES && kept <= MAX_LINES_PER_TAB);
    }

    /// 对比探针：无上限裸 Vec 追加 30 万行（与有界版对比裁剪开销）。
    #[test]
    fn perf_probe_unbounded_vec_300k() {
        use std::time::Instant;

        let mut v: Vec<String> = Vec::with_capacity(300_000);
        let t = Instant::now();
        for i in 0..300_000 {
            v.push(format!("2026-01-01 12:00:00.000 [INFO] [module{}] message id={}", i % 20, i));
        }
        eprintln!(
            "[perf] unbounded Vec push 300k: {:?}, capacity≈{}MB",
            t.elapsed(),
            v.capacity() * std::mem::size_of::<String>() / (1024 * 1024)
        );
    }

    /// 临时调试：针对真实日志文件验证 jump_to_line 的窗口内容
    /// （用环境变量 LV_DEBUG_FILE 指定路径，仅在本地运行）。
    #[test]
    fn debug_real_file_jump() {
        let path = match std::env::var("LV_DEBUG_FILE") {
            Ok(p) => p,
            Err(_) => return, // 未指定则跳过
        };
        let line_no: u64 = std::env::var("LV_DEBUG_LINE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(19_000);
        let s = TabSession::new();
        *s.file_path.lock() = Some(PathBuf::from(&path));
        let mut reader = TailReader::new(PathBuf::from(&path), encoding::utf8());
        let _ = reader.init_tail(10).unwrap();
        *s.index.lock() = reader.index.clone();
        *s.reader.lock() = Some(reader);
        let payload = s.jump_to_line(line_no).unwrap();
        eprintln!(
            "[debug] total={} window={} first_line_no={} target_index={}",
            payload.total_lines,
            payload.lines.len(),
            payload.first_line_no,
            payload.target_index
        );
        let target_text = &payload.lines[payload.target_index].text;
        eprintln!("[debug] target text: {}", &target_text[..target_text.len().min(120)]);
        // 与文件全文第 line_no 行对照（按 \n 切行）
        let raw = std::fs::read(&path).unwrap();
        let all_text = String::from_utf8_lossy(&raw);
        let all: Vec<&str> = all_text.split('\n').collect();
        let expect = all[(line_no - 1) as usize].trim_end_matches('\r');
        eprintln!("[debug] expect: {}", &expect[..expect.len().min(120)]);
        assert_eq!(target_text.as_str(), expect, "跳转窗口目标行与文件第 {line_no} 行不一致");
    }
}
