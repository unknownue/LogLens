//! 增量 tail-follow：按字节偏移增量读取日志文件尾部，处理换行边界与文件轮转。

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

use tracing::instrument;

use crate::index::SharedIndex;

// Windows 下需要 OpenOptionsExt 以使用 .share_mode()（FILE_SHARE_* 共享打开）。
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;

/// 上次读取到的字节偏移与「未完整行」的残留缓冲。
pub struct TailReader {
    path: PathBuf,
    file: Option<File>,
    /// 已消费到的文件字节偏移。
    offset: u64,
    /// 上一次读取时末尾残留的不完整行（尚未读到换行符的部分）。
    pending: Vec<u8>,
    /// 文件当前大小（用于检测 truncate / 轮转）。
    last_size: u64,
    /// 已加载内容的最早字节偏移（历史按需加载的游标）。
    history_start: u64,
    /// 是否首次打开（首次应从尾部加载而非从头）。
    first_open: bool,
    /// 下一个 poll 追加行的文件行号（1-based，随读取推进）。
    line_no: u64,
    /// history_start 偏移处那一行的文件行号（懒计算；None 表示未初始化/未知）。
    history_line_no: Option<u64>,
    /// 行索引（与 TabSession 共享）：行号 ↔ 字节偏移 O(采样间隔) 定位。
    pub index: SharedIndex,
    /// 文件头部签名（前 HEAD_SIG_LEN 字节）：检测「整体重写」。
    /// 外部完全重写文件且新尺寸 ≥ 旧偏移时，仅靠 size 检测不到
    /// （等长重写甚至完全无事件），用内容签名识别。
    head_sig: Vec<u8>,
}

/// 头部签名长度：外部重写后前 1KB 与旧内容完全一致的概率可忽略。
const HEAD_SIG_LEN: usize = 1024;

#[derive(Debug, Clone)]
pub enum TailEvent {
    /// 一批新行（已按行切分，完整行）+ 首行的文件行号。
    Lines { lines: Vec<String>, first_line_no: u64 },
    /// 文件被截断/轮转，视图需要清空重建。
    Reset,
}

impl TailReader {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            file: None,
            offset: 0,
            pending: Vec::new(),
            last_size: 0,
            history_start: 0,
            first_open: true,
            line_no: 1,
            history_line_no: None,
            index: std::sync::Arc::new(parking_lot::Mutex::new(crate::index::LineIndex::new())),
            head_sig: Vec::new(),
        }
    }

    /// 捕获文件头部签名（用独立共享句柄，不扰动 self.file 的游标）。
    fn capture_head_sig(&mut self) -> std::io::Result<()> {
        let mut f = open_shared_file(&self.path)?;
        let size = f.metadata()?.len();
        let want = (size as usize).min(HEAD_SIG_LEN);
        let mut buf = vec![0u8; want];
        f.read_exact(&mut buf)?;
        self.head_sig = buf;
        Ok(())
    }

    /// 文件头部是否已与记录不一致（整体重写检测）。
    fn head_changed(&self) -> std::io::Result<bool> {
        if self.head_sig.is_empty() {
            return Ok(false);
        }
        let mut f = open_shared_file(&self.path)?;
        let size = f.metadata()?.len();
        let want = (size as usize).min(self.head_sig.len());
        if want == 0 {
            return Ok(false);
        }
        let mut buf = vec![0u8; want];
        f.read_exact(&mut buf)?;
        Ok(buf != self.head_sig[..want])
    }

    /// 打开文件（以共享读写删除模式打开，容忍写入进程独占部分权限）。
    fn open_shared(&mut self) -> std::io::Result<()> {
        let f = open_shared_file(&self.path)?;
        self.file = Some(f);
        Ok(())
    }

    /// 把历史加载游标移动到指定字节偏移（「跳转到行」加载窗口后使用）。
    /// `line_no` 为该偏移处那一行的文件行号。
    pub fn set_history_start(&mut self, offset: u64, line_no: u64) {
        self.history_start = offset;
        self.history_line_no = Some(line_no);
    }

    /// 统计 [0, end) 字节区间内的完整行数（按 \n 计数）。
    /// 已由行索引取代：`LineIndex::seed_range` 在计数的同时把采样写入索引，
    /// 之后定位/统计为 O(1)，不再保留此处每次 O(文件大小) 的重复全扫。
    fn count_newlines_before(&self, end: u64) -> std::io::Result<u64> {
        let mut idx = self.index.lock();
        idx.seed_range(&self.path, end)
    }

    /// 初始化：定位到文件末尾（首屏显示最新日志），返回现有尾部若干行
    /// 与首行的文件行号（1-based）。
    ///
    /// 并发写入防护：外部正在重写/追加时，初始化期间 size 可能变化，
    /// 导致 offset/行号/索引对不上同一份内容（实测：offset 取到最终 size、
    /// 实际只读到中间态 → 剩余内容永远读不到）。因此：
    /// - offset 取「实际读到的终点」（start + buf.len()）而非 size 快照；
    /// - 结束后重检 size：若已变化则整体重试（最多 3 次），保证一致性。
    #[instrument(skip(self), fields(tail_lines))]
    pub fn init_tail(&mut self, tail_lines: u64) -> std::io::Result<(Vec<String>, u64)> {
        let mut last: Option<(Vec<String>, u64)> = None;
        for _attempt in 0..3 {
            self.index.lock().reset();
            self.open_shared()?;
            let size = self.file.as_ref().unwrap().metadata()?.len();
            self.last_size = size;
            // 捕获头部签名（整体重写检测）；失败不致命（退化为仅 size 检测）。
            let _ = self.capture_head_sig();

            // 从尾部向前读取 tail_lines 行（近似：从末尾回溯最多 tail_lines * 256 字节再切行）。
            let mut file = self.file.take().unwrap();
            let approx = (tail_lines.saturating_mul(256)).max(8192).min(size);
            let start = size - approx;

            // start 是否恰在行首：是则缓冲首行是完整行、直接保留；
            // 否则首行是从行中间截断的残片，需丢弃（该行由 load_history 补全）。
            let starts_at_line_start = if start == 0 {
                true
            } else {
                let mut prev = [0u8; 1];
                file.seek(SeekFrom::Start(start - 1))?;
                file.read_exact(&mut prev)?;
                prev[0] == b'\n'
            };

            file.seek(SeekFrom::Start(start))?;
            let mut buf = Vec::with_capacity(approx as usize);
            file.read_to_end(&mut buf)?;

            // 关键：offset 取实际读到的终点（而非 size 快照），并发写入时不会越过未读内容。
            self.offset = start + buf.len() as u64;
            self.history_start = start; // 历史加载游标 = 尾部加载起点
            self.first_open = false;
            self.file = Some(file);

            // 统计尾部缓冲里的完整行数（含首行丢弃前的总数）。
            let n_in_buf = buf.iter().filter(|&&b| b == b'\n').count() as u64;
            // start 之前的完整行数（一次前缀扫描，仅首屏一次）。
            let prefix_complete = if start > 0 {
                self.count_newlines_before(start)?
            } else {
                0
            };
            // 保留行的首行编号：start 落在行中间时该行（prefix+1）作为残片被丢弃，
            // 首行编号为 prefix+2；start 恰在行首时该行完整保留，首行编号为 prefix+1。
            let first = if start == 0 {
                1
            } else if starts_at_line_start {
                prefix_complete + 1
            } else {
                prefix_complete + 2
            };
            // 下一个追加行的编号 = 文件内完整行总数 + 1。
            self.line_no = prefix_complete + n_in_buf + 1;
            self.history_line_no = Some(first);

            let (mut lines, leftover) = split_with_pending(&buf);
            // 首行残片（start 落在行中间时）丢弃。
            if !starts_at_line_start && !lines.is_empty() {
                lines.remove(0);
            }
            // 末尾未换行的残片保存为 pending：下一次 poll 补齐换行后作为完整行发出，
            // 且 total_lines 可将其计为一行。
            self.pending = leftover;
            last = Some((lines, first));

            // 稳定性重检：初始化期间文件未再变化 → 结果一致，返回；
            // 否则整体重试（索引已随本循环头部 reset 重建）。
            let size_now = self.file.as_ref().unwrap().metadata()?.len();
            if size_now == size {
                return Ok(last.unwrap());
            }
            eprintln!("[tail] init_tail 期间文件变化（{size} -> {size_now}），重试");
        }
        // 写入过于活跃、3 次均不稳定：返回最后一次结果，后续由 poll 追加补齐。
        Ok(last.unwrap_or_default())
    }

    /// 文件当前总行数（实时）：已读完整行数 +（末尾尚有未换行残片时 +1）。
    /// 随 poll 推进实时更新；轮转/重开后从 0 重新计。
    pub fn total_lines(&self) -> u64 {
        self.line_no.saturating_sub(1) + if self.pending.is_empty() { 0 } else { 1 }
    }

    /// 向前读取一段更早的历史行（按需加载）。
    /// 返回 (完整行列表, 是否还有更早的历史, 首行文件行号)。
    ///
    /// 读窗口为 [read_start, history_start)：read_start 落在行中间时其残片丢弃
    /// （该行会在下一次翻页时作为边界行被补全）；history_start 落在行中间时，
    /// 继续向前读到该行结尾的换行，把这条「边界行」补全后并入本批。否则每次
    /// 翻页都会在批次边界永久丢行、且行号编号逐批漂移（表现为滚动到顶后
    /// 首行行号不是 1）。
    #[instrument(skip(self), fields(rows))]
    pub fn load_history(&mut self, rows: u64) -> std::io::Result<(Vec<String>, bool, u64)> {
        if self.history_start == 0 {
            return Ok((Vec::new(), false, 0)); // 已到文件头
        }
        // history_start 处那一行的行号：懒初始化（轮转后新文件首次加载历史时计算）。
        let hist_line_no = match self.history_line_no {
            Some(n) => n,
            None => {
                let n = self.count_newlines_before(self.history_start)? + 1;
                self.history_line_no = Some(n);
                n
            }
        };

        let file = match self.file.as_mut() {
            Some(f) => f,
            None => return Ok((Vec::new(), false, 0)),
        };

        let approx = (rows.saturating_mul(256)).max(8192);
        let read_start = self.history_start.saturating_sub(approx);
        let read_len = self.history_start - read_start;

        // read_start 是否恰在行首：决定缓冲首行是完整行还是残片。
        let starts_at_line_start = if read_start == 0 {
            true
        } else {
            let mut prev = [0u8; 1];
            file.seek(SeekFrom::Start(read_start - 1))?;
            file.read_exact(&mut prev)?;
            prev[0] == b'\n'
        };

        file.seek(SeekFrom::Start(read_start))?;
        let mut buf = vec![0u8; read_len as usize];
        file.read_exact(&mut buf)?;

        // 补全末尾边界行：history_start 落在行中间时（缓冲不以 \n 结尾），
        // 从 history_start 继续向前读到下一个换行，把该行补全并入缓冲。
        // 超长行（>1MB）或文件未写完（EOF 仍无换行）时放弃补全，该行按缺失处理。
        let mut boundary_included = buf.ends_with(b"\n");
        if !boundary_included {
            const MAX_SUFFIX: usize = 1 << 20;
            let mut suffix: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 8192];
            let completed = loop {
                let n = file.read(&mut chunk)?;
                if n == 0 {
                    break false; // EOF 仍无换行：末行尚未写完，无法补全
                }
                if let Some(pos) = chunk[..n].iter().position(|&b| b == b'\n') {
                    suffix.extend_from_slice(&chunk[..=pos]);
                    break true;
                }
                suffix.extend_from_slice(&chunk[..n]);
                if suffix.len() >= MAX_SUFFIX {
                    break false; // 超长行：放弃补全
                }
            };
            if completed {
                buf.extend_from_slice(&suffix);
                boundary_included = true;
            }
        }

        let mut lines = split_lines(&buf);
        // 首行残片（read_start 落在行中间时）丢弃；该行由下一次翻页补全。
        if !starts_at_line_start && !lines.is_empty() {
            lines.remove(0);
        }

        let n_kept = lines.len() as u64;
        // 保留末行：边界行补全成功时为 hist_line_no-1，否则为它的前一行。
        let last_kept = hist_line_no.saturating_sub(if boundary_included { 1 } else { 2 });
        let first = if n_kept == 0 {
            hist_line_no
        } else {
            last_kept.saturating_sub(n_kept - 1)
        };

        self.history_start = read_start;
        self.history_line_no = Some(first);
        Ok((lines, read_start > 0, first))
    }

    /// 读取自上次 offset 以来的新内容，返回新完整行；检测到截断返回 Reset。
    #[instrument(skip(self))]
    pub fn poll(&mut self) -> std::io::Result<Vec<TailEvent>> {
        if self.file.is_none() {
            // 文件可能被轮转删除后尚未重建，尝试重开。
            if self.open_shared().is_err() {
                return Ok(Vec::new());
            }
        }

        let size = match self.file.as_ref().unwrap().metadata() {
            Ok(m) => m.len(),
            Err(_) => {
                // 文件句柄失效（被删除），标记重开并返回 Reset。
                self.file = None;
                return Ok(vec![TailEvent::Reset]);
            }
        };

        // 截断/完全重写检测：
        // - 文件变小：截断（原有路径）；
        // - 尺寸未变小但头部签名变化：外部整体重写（等长/变长重写时仅靠 size 检测不到）。
        if size < self.offset || self.head_changed().unwrap_or(false) {
            // 按新内容重新初始化（等效重新打开，保留会话）：行号/索引/历史全部重建，
            // 首屏直接显示新文件尾部，前端收到 reset 后整体替换。
            self.index.lock().reset();
            match self.init_tail(1000) {
                Ok((lines, first)) => {
                    return Ok(vec![
                        TailEvent::Reset,
                        TailEvent::Lines { lines, first_line_no: first },
                    ]);
                }
                Err(e) => {
                    eprintln!("[tail] 重写后重新初始化失败: {e}");
                    self.file = None;
                    return Ok(vec![TailEvent::Reset]);
                }
            }
        }

        if size <= self.offset {
            // 无新数据。
            return Ok(Vec::new());
        }

        let file = self.file.as_mut().unwrap();
        file.seek(SeekFrom::Start(self.offset))?;
        let mut buf = vec![0u8; (size - self.offset) as usize];
        file.read_exact(&mut buf)?;
        self.offset = size;
        self.last_size = size;

        // 拼接残留 + 新数据，再按行切分。
        let mut combined = std::mem::take(&mut self.pending);
        combined.extend_from_slice(&buf);

        let (complete, leftover) = split_with_pending(&combined);
        self.pending = leftover;

        if complete.is_empty() {
            return Ok(Vec::new());
        }
        let first_line_no = self.line_no;
        self.line_no += complete.len() as u64;
        Ok(vec![TailEvent::Lines {
            lines: complete,
            first_line_no,
        }])
    }

    /// 强制重开（轮转后调用）。
    pub fn reopen(&mut self) -> std::io::Result<()> {
        self.file = None;
        self.offset = 0;
        self.pending.clear();
        self.open_shared()?;
        let size = self.file.as_ref().unwrap().metadata()?.len();
        self.offset = size;
        self.last_size = size;
        // 轮转后是新文件：历史从新文件头开始（可加载新文件更早内容），
        // 行号计数重置；历史行号懒初始化（首次 load_history 时按新文件重算）。
        self.history_start = size;
        self.line_no = 1;
        self.history_line_no = None;
        // 行索引失效重建（generation+1，旧后台扫描任务退出）。
        self.index.lock().reset();
        // 捕获新文件头部签名（重写检测）。
        let _ = self.capture_head_sig();
        Ok(())
    }
}

/// 把 buffer 切成完整行（Vec<String>），返回剩余的「未以换行结尾」的残片。
fn split_with_pending(buf: &[u8]) -> (Vec<String>, Vec<u8>) {
    let mut lines = Vec::new();
    let mut start = 0usize;
    for (i, &b) in buf.iter().enumerate() {
        if b == b'\n' {
            let mut line = &buf[start..i];
            // 去掉 \r
            if line.last() == Some(&b'\r') {
                line = &line[..line.len() - 1];
            }
            lines.push(String::from_utf8_lossy(line).into_owned());
            start = i + 1;
        }
    }
    let leftover = buf[start..].to_vec();
    (lines, leftover)
}

fn split_lines(buf: &[u8]) -> Vec<String> {
    split_with_pending(buf).0
}

/// 把 buffer 切成完整行；与 split_with_pending 的区别：
/// 结尾未换行的残片也作为一行返回（用于「跳转到行」的窗口读取，
/// 窗口终点是文件 EOF 且末行无换行时不能丢）。
pub(crate) fn split_lines_inclusive(buf: &[u8]) -> Vec<String> {
    let (mut lines, leftover) = split_with_pending(buf);
    if !leftover.is_empty() {
        lines.push(String::from_utf8_lossy(&leftover).into_owned());
    }
    lines
}

/// 以共享模式打开文件（独立句柄，用于行号定位/窗口读取，不影响 TailReader 游标）。
pub fn open_shared_file(path: &std::path::Path) -> std::io::Result<File> {
    let mut opts = OpenOptions::new();
    opts.read(true).write(false);
    #[cfg(windows)]
    opts.share_mode(0x7); // FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
    opts.open(path)
}

/// 统计文件总行数：换行符数，末尾无换行且非空时 +1。
/// 已被行索引（`LineIndex::total_lines`）取代；保留作为测试对照的全扫参考实现。
#[allow(dead_code)]
pub fn count_lines(path: &std::path::Path) -> std::io::Result<u64> {
    let mut file = open_shared_file(path)?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut seen = 0u64;
    let mut last_byte = b'\n';
    let mut total_bytes = 0u64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        seen += buf[..n].iter().filter(|&&b| b == b'\n').count() as u64;
        last_byte = buf[n - 1];
        total_bytes += n as u64;
    }
    if total_bytes > 0 && last_byte != b'\n' {
        seen += 1;
    }
    Ok(seen)
}

/// 定位 0-based 行区间 [start_line, end_line) 的字节偏移。
/// 调用方保证 0 ≤ start_line ≤ end_line ≤ count_lines(path)。
/// 末尾无换行的最后一行按一行计；end_line == 总行数时 end 偏移为文件大小。
/// 扫描在找到两个偏移后提前终止（end_line 通常离 start_line 只有几千行）。
/// 已被行索引（`LineIndex::locate_range`）取代；保留作为测试对照的全扫参考实现。
#[allow(dead_code)]
pub fn line_range_offsets(
    path: &std::path::Path,
    start_line: u64,
    end_line: u64,
) -> std::io::Result<(u64, u64)> {
    if end_line == 0 {
        return Ok((0, 0));
    }
    let mut file = open_shared_file(path)?;
    let size = file.metadata()?.len();
    let mut buf = vec![0u8; 64 * 1024];
    let mut pos = 0u64; // 已扫描字节数
    let mut seen = 0u64; // 已见完整行数（以 \n 结尾）
    let mut start_off = if start_line == 0 { Some(0u64) } else { None };
    let mut end_off: Option<u64> = None;
    let mut last_byte = b'\n';
    let mut last_line_start = 0u64;
    'scan: loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        last_byte = buf[n - 1];
        let mut line_start = pos;
        for (i, &b) in buf[..n].iter().enumerate() {
            if b == b'\n' {
                if start_off.is_none() && seen == start_line {
                    start_off = Some(line_start);
                }
                seen += 1;
                line_start = pos + i as u64 + 1;
                if end_off.is_none() && seen == end_line {
                    end_off = Some(line_start);
                }
            }
        }
        last_line_start = line_start;
        pos += n as u64;
        if start_off.is_some() && end_off.is_some() {
            break 'scan;
        }
    }
    let start = match start_off {
        Some(o) => o,
        // 仅剩一种情况：start_line 指向末尾未换行的最后一行。
        None if last_byte != b'\n' && seen == start_line => last_line_start,
        None => size,
    };
    let end = end_off.unwrap_or(size); // end_line == 总行数（含未换行末行）→ EOF
    Ok((start, end))
}

/// 行数据模型：传给前端的一行。
#[derive(Debug, Clone, serde::Serialize)]
pub struct LogLine {
    /// 稳定行标识（单调分配的整数偏移，用于前端 key 与「跳转到该行」定位）。
    /// 注意必须是 i64：历史行用负数递减分配；若转成 u64（≈2^64）经 JSON 传给
    /// JS 会丢失精度（超出 Number.MAX_SAFE_INTEGER），相邻行 file_offset 碰撞，
    /// 导致虚拟滚动的 key 缓存错乱、相邻行文字重叠。
    pub file_offset: i64,
    /// 该行在文件中的真实行号（1-based）。供前端行号列显示；
    /// 跳转窗口、历史加载、实时追加均携带正确编号。
    pub file_line: u64,
    /// 该行文本。
    pub text: String,
}

impl LogLine {
    pub fn new(file_offset: i64, file_line: u64, text: String) -> Self {
        Self {
            file_offset,
            file_line,
            text,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 写一个临时文件并返回 TailReader。
    fn make_reader(content: &str) -> (TailReader, tempfile::NamedTempFile) {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(content.as_bytes()).unwrap();
        f.flush().unwrap();
        let path = f.path().to_path_buf();
        let reader = TailReader::new(path);
        (reader, f)
    }

    #[test]
    fn splitting_handles_crlf_and_partial_lines() {
        let (complete, leftover) = split_with_pending(b"line1\r\nline2\npartial");
        assert_eq!(complete, vec!["line1".to_string(), "line2".to_string()]);
        assert_eq!(leftover, b"partial");
    }

    #[test]
    fn count_lines_handles_trailing_newline_variants() {
        use std::io::Write;
        let cases: Vec<(&str, u64)> = vec![
            ("", 0),
            ("a", 1),
            ("a\n", 1),
            ("a\nb", 2),
            ("a\nb\n", 2),
            ("\n\n", 2),
            ("a\n\nb", 3),
        ];
        for (content, expect) in cases {
            let mut f = tempfile::NamedTempFile::new().unwrap();
            f.write_all(content.as_bytes()).unwrap();
            f.flush().unwrap();
            assert_eq!(count_lines(f.path()).unwrap(), expect, "content={content:?}");
        }
    }

    #[test]
    fn line_range_offsets_locate_windows() {
        use std::io::Write;
        // 5 行：行长不固定，含空行与末尾无换行。
        let content = "aaa\nbb\nccccc\n\nddd";
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(content.as_bytes()).unwrap();
        f.flush().unwrap();
        let p = f.path();

        let (s, e) = line_range_offsets(p, 0, 2).unwrap();
        assert_eq!(&content[s as usize..e as usize], "aaa\nbb\n");
        // 含空行与未换行末行的窗口。
        let (s, e) = line_range_offsets(p, 3, 5).unwrap();
        assert_eq!(&content[s as usize..e as usize], "\nddd");
        // 全文件。
        let (s, e) = line_range_offsets(p, 0, 5).unwrap();
        assert_eq!((s, e), (0, content.len() as u64));
        // 末行起点。
        let (s, _e) = line_range_offsets(p, 4, 5).unwrap();
        assert_eq!(&content[s as usize..], "ddd");
    }

    #[test]
    fn poll_detects_truncation() {
        let (mut reader, mut f) = make_reader("aaa\nbbb\n");
        let evts = reader.poll().unwrap();
        // 首次 poll 从 offset 0 读到全部 2 行。
        let lines: Vec<String> = evts
            .into_iter()
            .filter_map(|e| match e {
                TailEvent::Lines { lines, .. } => Some(lines.join(",")),
                _ => None,
            })
            .collect();
        assert_eq!(lines, vec!["aaa,bbb"]);

        // 截断文件，重新写入更短内容。
        use std::io::Seek;
        let fh = f.as_file_mut();
        fh.seek(std::io::SeekFrom::Start(0)).unwrap();
        fh.set_len(0).unwrap();
        fh.write_all(b"x\n").unwrap();
        fh.flush().unwrap();

        let evts = reader.poll().unwrap();
        assert!(evts.iter().any(|e| matches!(e, TailEvent::Reset)));
    }

    /// 整体重写检测：外部把文件完全重写为「等长或更长」的新内容时，
    /// 仅靠 size 检测不到（等长时 size==offset 连追加事件都没有），
    /// 头部签名识别后应 Reset 并按新内容重新初始化，行号从头计。
    #[test]
    fn poll_detects_full_rewrite_same_or_larger_size() {
        use std::io::Write;

        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(b"old-a\nold-b\nold-c\n").unwrap();
        f.flush().unwrap();
        let path = f.path().to_path_buf();

        let mut reader = TailReader::new(path.clone());
        let (initial, first) = reader.init_tail(1000).unwrap();
        assert_eq!(initial, vec!["old-a".to_string(), "old-b".to_string(), "old-c".to_string()]);
        assert_eq!(first, 1);
        let old_offset = reader.offset;

        // 场景 1：等长完全重写（size == offset，旧逻辑连事件都没有）。
        let new1 = "NEW-1\nNEW-2\nNEW-3\n";
        assert_eq!(new1.len() as u64, old_offset);
        {
            let fh = f.as_file_mut();
            fh.seek(std::io::SeekFrom::Start(0)).unwrap();
            fh.set_len(0).unwrap();
            fh.write_all(new1.as_bytes()).unwrap();
            fh.flush().unwrap();
        }
        let evts = reader.poll().unwrap();
        assert!(
            evts.iter().any(|e| matches!(e, TailEvent::Reset)),
            "等长重写应触发 Reset"
        );
        let lines: Vec<String> = evts
            .iter()
            .filter_map(|e| match e {
                TailEvent::Lines { lines, .. } => Some(lines.join("|")),
                _ => None,
            })
            .collect();
        assert_eq!(lines, vec!["NEW-1|NEW-2|NEW-3"]);
        let firsts: Vec<u64> = evts
            .iter()
            .filter_map(|e| match e {
                TailEvent::Lines { first_line_no, .. } => Some(*first_line_no),
                _ => None,
            })
            .collect();
        assert_eq!(firsts, vec![1], "行号应从新文件重新计");
        assert_eq!(reader.total_lines(), 3);

        // 场景 2：变长完全重写（新内容比旧 offset 更长，旧逻辑会从中间读起）。
        let new2 = "REWRITTEN-ALPHA\nREWRITTEN-BETA\nREWRITTEN-GAMMA\nREWRITTEN-DELTA\nREWRITTEN-EPSILON\n";
        assert!(new2.len() as u64 > reader.offset);
        {
            let fh = f.as_file_mut();
            fh.seek(std::io::SeekFrom::Start(0)).unwrap();
            fh.set_len(0).unwrap();
            fh.write_all(new2.as_bytes()).unwrap();
            fh.flush().unwrap();
        }
        let evts = reader.poll().unwrap();
        assert!(evts.iter().any(|e| matches!(e, TailEvent::Reset)));
        let lines: Vec<String> = evts
            .iter()
            .filter_map(|e| match e {
                TailEvent::Lines { lines, .. } => Some(lines.join("|")),
                _ => None,
            })
            .collect();
        assert_eq!(lines, vec![
            "REWRITTEN-ALPHA|REWRITTEN-BETA|REWRITTEN-GAMMA|REWRITTEN-DELTA|REWRITTEN-EPSILON"
        ]);
        assert_eq!(reader.total_lines(), 5);

        // 场景 3：重写后继续追加，行号续编。
        {
            let mut appender = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
            appender.write_all(b"REWRITTEN-ZETA\n").unwrap();
            appender.flush().unwrap();
        }
        let evts = reader.poll().unwrap();
        let mut all = Vec::new();
        let mut fno = 0;
        for e in evts {
            if let TailEvent::Lines { lines, first_line_no } = e {
                all.extend(lines);
                fno = first_line_no;
            }
        }
        assert_eq!(all, vec!["REWRITTEN-ZETA".to_string()]);
        assert_eq!(fno, 6, "追加行应从第 6 行续编");
    }

    /// 普通追加不应误触发重写检测。
    #[test]
    fn poll_append_does_not_trigger_rewrite_reset() {
        use std::io::Write;
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(b"a\nb\n").unwrap();
        f.flush().unwrap();
        let path = f.path().to_path_buf();

        let mut reader = TailReader::new(path.clone());
        let _ = reader.init_tail(1000).unwrap();

        {
            let mut appender = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
            appender.write_all(b"c\nd\n").unwrap();
            appender.flush().unwrap();
        }
        let evts = reader.poll().unwrap();
        assert!(
            !evts.iter().any(|e| matches!(e, TailEvent::Reset)),
            "普通追加不应触发 Reset"
        );
    }

    /// 复现真实时序：外部重写是「truncate + 分次写入」，poll 可能观察到写了一半的状态。
    /// 中途快照触发重置后，剩余字节应以追加形式读回，最终总行数与内容完整。
    #[test]
    fn poll_rewrite_with_partial_write_observation() {
        use std::io::Write;

        // 初始 10 行（定宽 10 字节/行 = 100 字节）。
        let mut f = tempfile::NamedTempFile::new().unwrap();
        for i in 0..10usize {
            writeln!(f, "old-{i:05}").unwrap();
        }
        f.flush().unwrap();
        let path = f.path().to_path_buf();

        let mut reader = TailReader::new(path.clone());
        let _ = reader.init_tail(1000).unwrap();
        assert_eq!(reader.total_lines(), 10);

        // 外部重写：截断后先写前 60 行（600 字节）—— poll 恰在此时观察。
        {
            let fh = f.as_file_mut();
            fh.seek(std::io::SeekFrom::Start(0)).unwrap();
            fh.set_len(0).unwrap();
            let head: String = (0..60usize).map(|i| format!("new-{i:05}\n")).collect();
            fh.write_all(head.as_bytes()).unwrap();
            fh.flush().unwrap();
        }
        let evts = reader.poll().unwrap();
        assert!(evts.iter().any(|e| matches!(e, TailEvent::Reset)), "重写应触发 Reset");
        assert_eq!(reader.total_lines(), 60, "中途快照：应看到 60 行");

        // 剩余 40 行随后写入（追加）。
        {
            let mut appender = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
            let tail: String = (60..100usize).map(|i| format!("new-{i:05}\n")).collect();
            appender.write_all(tail.as_bytes()).unwrap();
            appender.flush().unwrap();
        }
        let mut all = Vec::new();
        let mut fno = 0;
        loop {
            let evts = reader.poll().unwrap();
            let mut got = false;
            for e in evts {
                if let TailEvent::Lines { lines, first_line_no } = e {
                    all.extend(lines);
                    fno = first_line_no;
                    got = true;
                }
            }
            if !got {
                break;
            }
        }
        assert_eq!(all.len(), 40, "剩余 40 行应以追加读回，实际 {}", all.len());
        assert_eq!(fno, 61, "追加首行行号应为 61");
        assert_eq!(all[0], "new-00060");
        assert_eq!(all[39], "new-00099");
        assert_eq!(reader.total_lines(), 100);
    }

    #[test]
    fn poll_appends_only_new_bytes() {
        let (mut reader, mut f) = make_reader("first\n");
        let _ = reader.poll().unwrap();

        // 追加两行。
        use std::io::Seek;
        let fh = f.as_file_mut();
        fh.seek(std::io::SeekFrom::End(0)).unwrap();
        fh.write_all(b"second\nthird\n").unwrap();
        fh.flush().unwrap();

        let evts = reader.poll().unwrap();
        let mut all = Vec::new();
        for e in evts {
            if let TailEvent::Lines { lines, .. } = e {
                all.extend(lines);
            }
        }
        // 只应返回新增的 second/third，而非 first。
        assert_eq!(all, vec!["second".to_string(), "third".to_string()]);
    }

    /// 模拟真实场景：init_tail 后用「另一个独立句柄」追加（类似另一个进程写日志），
    /// 验证 poll 能否通过 metadata().len() 看到新大小并读回增量。
    #[test]
    fn poll_after_init_tail_sees_external_append() {
        use std::io::Write;

        // 先写初始内容（用第一个句柄，写完关闭）。
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(b"line1\nline2\nline3\n").unwrap();
        f.flush().unwrap();
        let path = f.path().to_path_buf();

        // TailReader 独立打开 + init_tail（模拟应用启动）。
        let mut reader = TailReader::new(path.clone());
        let (initial, first_no) = reader.init_tail(1000).unwrap();
        assert_eq!(initial, vec!["line1".to_string(), "line2".to_string(), "line3".to_string()]);
        assert_eq!(first_no, 1, "文件头开始，首行编号应为 1");

        // 模拟另一个进程：用 append 模式打开独立句柄追加。
        {
            let mut appender = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
            appender.write_all(b"line4\nline5\n").unwrap();
            appender.flush().unwrap();
            // appender drop 关闭
        }

        // poll 应能看到新大小并读回 line4/line5，且行号从 4 续编。
        let evts = reader.poll().unwrap();
        let mut all = Vec::new();
        let mut first_line_no = 0;
        for e in evts {
            if let TailEvent::Lines { lines, first_line_no: f } = e {
                all.extend(lines);
                first_line_no = f;
            }
        }
        assert_eq!(all, vec!["line4".to_string(), "line5".to_string()]);
        assert_eq!(first_line_no, 4, "追加批次首行应为文件第 4 行");
    }

    /// 历史按需加载：init_tail 后向前加载更早的行。
    #[test]
    fn load_history_reads_earlier_lines() {
        use std::io::Write;

        // 2000 行日志（每行 ~50 字节，约 100KB，远超 init_tail 的 8KB 下限）。
        let mut content = String::new();
        for i in 0..2000 {
            content.push_str(&format!("history-line-{:04} with some payload text\n", i));
        }
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(content.as_bytes()).unwrap();
        f.flush().unwrap();
        let path = f.path().to_path_buf();

        let mut reader = TailReader::new(path.clone());
        // init_tail 只读尾部一段（约 8KB+）。
        let (initial, _first) = reader.init_tail(10).unwrap();
        assert!(initial.len() < 2000, "只应加载尾部一部分，实际 {}", initial.len());
        assert!(initial.len() >= 10);
        // 尾部加载应从倒数第 N 行开始，不是文件头。
        assert!(!initial[0].starts_with("history-line-0000"));

        // 向前加载一段历史。
        let (hist, has_more, first_no) = reader.load_history(10).unwrap();
        assert!(!hist.is_empty());
        assert!(has_more, "应还有更早的历史");
        // 历史首行编号 + 批长应等于初始尾部首行编号（边界行被补全，无缝衔接）。
        assert_eq!(first_no + hist.len() as u64, _first);

        // 持续向前加载直到文件头。
        let mut total = initial.len() + hist.len();
        let mut guard = 0;
        loop {
            let (h, more, _f) = reader.load_history(10).unwrap();
            total += h.len();
            if !more {
                break;
            }
            guard += 1;
            assert!(guard < 500, "加载次数过多: {}", guard);
        }
        // 边界行补全后不丢行：历史 + 初始尾部应等于文件全部 2000 行。
        assert_eq!(total, 2000, "历史总行数 {} 应恰好为 2000（不允许丢行）", total);
    }

    /// 回归测试：历史翻页不得丢行、行号不得漂移（滚动到顶后首行必须是第 1 行）。
    /// 复现路径：~5MB 日志连续向前翻页，滚动到顶后最上一行显示第 9 行——
    /// load_history 曾无条件 pop 掉缓冲区最后一条完整行，行号逐批 +1 漂移。
    #[test]
    fn load_history_no_line_loss_or_numbering_drift() {
        use std::io::Write;

        // 2 万行 × 251 字节 ≈ 5MB：10 个 512KB 翻页窗口；行长 251 不与
        // 512KB 窗口整除，确保 init 起点与每个翻页窗口都落在行中间（边界补全路径）。
        let mut f = tempfile::NamedTempFile::new().unwrap();
        for i in 0..20_000usize {
            writeln!(f, "{i:05} {:->244}", "").unwrap();
        }
        f.flush().unwrap();
        let path = f.path().to_path_buf();

        let mut reader = TailReader::new(path.clone());
        let (initial, first_initial) = reader.init_tail(1000).unwrap();
        assert!(!initial.is_empty());

        // 逐批加载直到文件头，校验批间行号连续无缝。
        let mut segments: Vec<(u64, Vec<String>)> = Vec::new();
        let mut expected_next = first_initial; // 下一批应衔接的行号（当前视图首行）
        loop {
            let (h, more, first_no) = reader.load_history(2000).unwrap();
            if !h.is_empty() {
                assert_eq!(
                    first_no + h.len() as u64,
                    expected_next,
                    "批间行号必须无缝衔接"
                );
                segments.push((first_no, h));
                expected_next = first_no;
            }
            if !more {
                break;
            }
        }
        // 滚动到顶：最上一行必须是文件第 1 行，且编号为 1。
        let (top_first, top_lines) = segments.last().expect("应加载到文件头");
        assert_eq!(*top_first, 1, "首行行号必须是 1，实测 {top_first}");
        assert!(top_lines[0].starts_with("00000 "), "首行内容应为文件第一行");
        // 不丢行：初始尾部 + 全部历史 = 文件总行数。
        let history_total: usize = segments.iter().map(|(_, l)| l.len()).sum();
        assert_eq!(initial.len() + history_total, 20_000, "不允许丢行");
    }

    /// 临时调试：针对真实日志文件验证历史翻页到顶（用环境变量 LV_DEBUG_FILE
    /// 指定路径，仅在本地运行）。校验：批间行号无缝衔接、首行为第 1 行、不丢行。
    #[test]
    fn debug_real_file_history_to_top() {
        let path = match std::env::var("LV_DEBUG_FILE") {
            Ok(p) => p,
            Err(_) => return, // 未指定则跳过
        };
        let path = PathBuf::from(&path);

        let mut reader = TailReader::new(path.clone());
        let (initial, first_initial) = reader.init_tail(1000).unwrap();

        let newline_count =
            std::fs::read(&path).unwrap().iter().filter(|&&b| b == b'\n').count() as u64;

        let mut history_total = 0u64;
        let mut expected_next = first_initial;
        let mut batches = 0usize;
        loop {
            let (h, more, first_no) = reader.load_history(2000).unwrap();
            if !h.is_empty() {
                assert_eq!(first_no + h.len() as u64, expected_next, "批间行号必须无缝衔接");
                expected_next = first_no;
                history_total += h.len() as u64;
            }
            batches += 1;
            if !more {
                break;
            }
            assert!(batches < 10_000, "加载次数过多: {}", batches);
        }
        assert_eq!(expected_next, 1, "滚动到顶后首行必须是第 1 行，实测 {expected_next}");
        assert_eq!(initial.len() as u64 + history_total, newline_count, "不允许丢行");
        eprintln!(
            "[debug] history to top: {batches} batches, {history_total} + {} = {} lines (file complete lines {newline_count})",
            initial.len(),
            history_total + initial.len() as u64
        );
    }

    /// 性能探针：B6 历史加载——20 万行大文件向前翻页加载的耗时。
    #[test]
    fn perf_probe_load_history_200k() {
        use std::io::Write;
        use std::time::Instant;

        // 写 20 万行（~10MB）临时文件。
        let mut f = tempfile::NamedTempFile::new().unwrap();
        {
            let mut buf = String::with_capacity(64);
            for i in 0..200_000 {
                buf.clear();
                buf.push_str(&format!("history-line-{:06} with some payload text\n", i));
                f.write_all(buf.as_bytes()).unwrap();
            }
            f.flush().unwrap();
        }
        let path = f.path().to_path_buf();

        let mut reader = TailReader::new(path.clone());
        let (initial, _first) = reader.init_tail(1000).unwrap();
        eprintln!("[perf] init_tail 200k file: {} lines loaded", initial.len());

        // 逐段加载全部历史，测耗时。
        let t = Instant::now();
        let mut total = initial.len();
        let mut batches = 0usize;
        loop {
            let (h, more, _f) = reader.load_history(2000).unwrap();
            total += h.len();
            batches += 1;
            if !more {
                break;
            }
        }
        eprintln!(
            "[perf] load_history 200k file: {} batches, {} total lines in {:?} (avg {:?}/batch)",
            batches,
            total,
            t.elapsed(),
            t.elapsed() / batches as u32
        );
        assert!(total >= 190_000, "total={}", total);
    }
}
