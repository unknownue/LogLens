//! 行索引：把「行号 ↔ 字节偏移」的定位从 O(文件大小) 全扫降为 O(采样间隔)。
//!
//! 设计：
//! - **采样**：每 [`SAMPLE_EVERY`] 行记录一个行首字节偏移（8 字节 / 64 行），
//!   精确定位 = 二分到最近采样点 + 局部扫描 ≤ 64 行。
//! - **增量**：任何读取路径（播种、定位、统计）都会把扫描到的换行采样进索引，
//!   覆盖区间单调前进（`covered_bytes` 保证同一区域不重复扫描）。
//! - **后台预热**：打开文件后由后台任务把索引扫到 EOF；之后定位/统计为 O(1)。
//!   文件继续增长时，超出部分的首次访问会按需补扫（tail 增量通常只有几十 KB）。
//! - **代际**：文件轮转/截断时 `reset()`（generation+1），旧后台扫描任务据此退出。
//!
//! 线程模型：`LineIndex` 被 `Mutex` 包裹（随 TailReader 共用同一把锁），
//! 所有方法自带 `&mut self`，保证单写者。

use std::io::{Read, Seek, SeekFrom};

use crate::encoding::LineTerm;
use crate::tail::open_shared_file;

/// 采样间隔：每 64 行记录一个行首字节偏移。
pub const SAMPLE_EVERY: u64 = 64;
/// 单次扫描步进的字节数（后台预热任务按此分块，避免长时间占锁）。
pub const SCAN_CHUNK_BYTES: u64 = 8 * 1024 * 1024;

/// 线程间共享的行索引（TailReader 与 TabSession 持有同一实例）。
pub type SharedIndex = std::sync::Arc<parking_lot::Mutex<LineIndex>>;

/// 行索引。
pub struct LineIndex {
    /// samples[i] = 文件第 `i * SAMPLE_EVERY + 1` 行（1-based）行首的字节偏移。
    /// 恒有 samples[0] == 0（第 1 行从字节 0 开始；空文件无意义但不影响使用）。
    samples: Vec<u64>,
    /// 已连续扫描覆盖的字节区间 [0, covered_bytes)。
    covered_bytes: u64,
    /// covered_bytes 之前出现的换行数（= 完整行数）。
    lines_upto: u64,
    /// 已扫到 EOF 且文件不以 '\n' 结尾（末尾残行计 1 行）。
    eof_no_newline: bool,
    /// 代际：reset() 时 +1；后台扫描任务持有起始代际，发现变化即退出。
    pub generation: u64,
    /// 换行符的字节形态（见 [`crate::encoding`]）。
    ///
    /// 索引统计的「行」必须与读取路径切出来的「行」是同一个东西，因此两处要用
    /// 同一份换行符定义：UTF-16 的换行是 2 字节（`0A 00` / `00 0A`），按裸
    /// `0x0A` 计数会在偏移上错位一格，定位出来的行首全是半个字符。
    /// 它是**只读**的：换编码时连 reader 带索引整体重建（见 `AppState::replace_session`），
    /// 没有「就地改换行形态」这条路径。
    term: LineTerm,
}

impl LineIndex {
    pub fn new() -> Self {
        Self::with_term(LineTerm::Lf)
    }

    /// 按指定换行符形态建索引（UTF-8/GBK 等用 [`LineTerm::Lf`]）。
    pub fn with_term(term: LineTerm) -> Self {
        Self {
            samples: vec![0],
            covered_bytes: 0,
            lines_upto: 0,
            eof_no_newline: false,
            generation: 0,
            term,
        }
    }

    /// 清空索引（文件轮转/截断后调用）；代际 +1。
    pub fn reset(&mut self) {
        self.samples.clear();
        self.samples.push(0);
        self.covered_bytes = 0;
        self.lines_upto = 0;
        self.eof_no_newline = false;
        self.generation += 1;
    }

    /// 已覆盖的字节数（用于测试/观测）。
    #[cfg(test)]
    pub fn covered_bytes(&self) -> u64 {
        self.covered_bytes
    }

    /// 扫描一段新字节，把换行采样追加进索引。
    /// `start` 必须是 `covered_bytes`（连续推进）；`file_size` 用于判断是否到达 EOF。
    ///
    /// 只**提交**换行符宽度的整数倍：调用方已经把要读的长度对齐过了，但实际读到的
    /// 字节数是另一回事 —— 短读（文件在 `metadata()` 与 `read()` 之间被截断/轮转、
    /// 非本地盘……）完全可能返回奇数长度。一旦把奇数提交进 `covered_bytes`，之后
    /// 每个块的起点奇偶就整体翻转，横跨边界的换行符两边都不认（见
    /// [`LineTerm::align_chunk`]）。把不变量钉在**状态**上，而不是每个调用点上。
    /// 未提交的尾巴下次会从同一个对齐偏移重读，既不丢也不重。
    fn scan_chunk(&mut self, buf: &[u8], start: u64, file_size: u64) {
        debug_assert_eq!(start, self.covered_bytes);
        let term = self.term;
        let committed = term.align_chunk(buf.len());
        let buf = &buf[..committed];
        let mut from = 0usize;
        while let Some(pos) = term.find(buf, start, from) {
            self.lines_upto += 1;
            if self.lines_upto % SAMPLE_EVERY == 0 {
                self.samples.push(start + pos as u64 + term.len() as u64);
            }
            from = pos + term.len();
        }
        let end = start + committed as u64;
        self.covered_bytes = end;
        if end >= file_size {
            self.eof_no_newline = !buf.is_empty() && !term.ends_with(buf, start);
        }
    }

    /// 把索引覆盖推进到至少 `target` 字节（超出文件大小则扫到 EOF）。
    /// 返回本次实际推进的字节数（0 表示已经覆盖/已到 EOF）。
    fn ensure_upto(&mut self, path: &std::path::Path, target: u64) -> std::io::Result<u64> {
        let mut file = open_shared_file(path)?;
        let size = file.metadata()?.len();
        // 文件变小（截断）而索引未及重置：清空重建。
        if size < self.covered_bytes {
            self.reset();
        }
        let target = target.min(size);
        if self.covered_bytes >= target {
            return Ok(0);
        }
        let mut scanned = 0u64;
        let mut buf = vec![0u8; 64 * 1024];
        while self.covered_bytes < target {
            // 块长对齐到换行符宽度：见 LineTerm::align_chunk（奇数块会让后续所有块的
            // 起点奇偶翻转，横跨边界的换行符两边都不认；不足一个换行符宽度的尾巴
            // 会被整成 0，此时就地停下，留给下一批字节）。
            let want = self.term.align_chunk(
                ((target - self.covered_bytes).min(buf.len() as u64)) as usize,
            );
            if want == 0 {
                // 还差不足一个换行符宽度的尾巴。它只可能出现在文件末尾，且不可能
                // 是完整换行符（换行符只从对齐偏移开始）—— 与读到 EOF 同义：末行
                // 没有换行结尾。停在尾巴之前，等字节到齐再扫（这正是「写了一半的
                // 日志」那种场景：UTF-16 文件当前大小是奇数时，最后一个字节就是
                // 半个换行符；若此刻把它算进 covered_bytes，之后文件增长时那个
                // 换行符就永远找不回来了）。
                self.eof_no_newline = true;
                break;
            }
            file.seek(SeekFrom::Start(self.covered_bytes))?;
            let n = file.read(&mut buf[..want])?;
            if n == 0 {
                break; // EOF
            }
            let start = self.covered_bytes;
            self.scan_chunk(&buf[..n], start, size);
            scanned += n as u64;
        }
        Ok(scanned)
    }

    /// 后台预热：扫描至多 `budget_bytes`；返回 true 表示已到 EOF（可退出）。
    pub fn scan_step(&mut self, path: &std::path::Path, budget_bytes: u64) -> std::io::Result<bool> {
        let mut file = open_shared_file(path)?;
        let size = file.metadata()?.len();
        if size < self.covered_bytes {
            self.reset();
        }
        if self.covered_bytes >= size {
            return Ok(true);
        }
        let want = self
            .term
            .align_chunk(((size - self.covered_bytes).min(budget_bytes)) as usize);
        if want == 0 {
            // 结果同上：只剩不足一个换行符宽度的尾巴，扫不动了。**必须在这里返回
            // true**，否则预热任务会因为「covered 到不了 size」而永远转下去。
            self.eof_no_newline = true;
            return Ok(true);
        }
        file.seek(SeekFrom::Start(self.covered_bytes))?;
        let mut buf = vec![0u8; want];
        let n = file.read(&mut buf)?;
        let start = self.covered_bytes;
        self.scan_chunk(&buf[..n], start, size);
        Ok(self.covered_bytes >= size)
    }

    /// 播种：打开文件时同步把 [0, end) 扫入索引（替换旧的全前缀扫描）。
    /// 返回 end 之前的完整行数（换行数）。
    pub fn seed_range(&mut self, path: &std::path::Path, end: u64) -> std::io::Result<u64> {
        if self.covered_bytes > end {
            // 已覆盖：精确行数需要局部扫描（正常流程不会走到，保持正确性）。
            return self.line_no_at_offset(path, end);
        }
        self.ensure_upto(path, end)?;
        // covered_bytes 可能超过 end（越过 EOF 时不会；end ≤ 文件大小的场景返回 end 前换行数）。
        // 这里 end 之前均已扫描：用「最后一处采样 + 局部扫描」取精确值。
        self.line_no_at_offset(path, end)
    }

    /// 字节偏移 `X` 之前的完整行数（X 处那行的行号 = 返回值 + 1）。
    /// 需先 ensure 覆盖到 X；内部会按需补扫。
    pub fn line_no_at_offset(&mut self, path: &std::path::Path, x: u64) -> std::io::Result<u64> {
        self.ensure_upto(path, x)?;
        if x == 0 {
            return Ok(0);
        }
        // 二分到最大的采样点 ≤ x。
        let k = self.samples.partition_point(|&s| s <= x);
        let k = k.saturating_sub(1);
        let base = self.samples[k];
        if base == x {
            return Ok(k as u64 * SAMPLE_EVERY);
        }
        // 扫描 [base, x) 内的换行数（最多 SAMPLE_EVERY 行 + 一条未完结长行）。
        let mut file = open_shared_file(path)?;
        file.seek(SeekFrom::Start(base))?;
        let mut buf = vec![0u8; (x - base).min(1 << 20) as usize];
        let mut read_total = 0u64;
        let mut count = 0u64;
        while read_total < x - base {
            let want = self
                .term
                .align_chunk(((x - base - read_total).min(buf.len() as u64)) as usize);
            let n = file.read(&mut buf[..want])?;
            if n == 0 {
                break;
            }
            // 绝对偏移 = base + 已读字节数（UTF-16 的换行对齐判定要用到）。
            count += self.term.count(&buf[..n], base + read_total);
            read_total += n as u64;
        }
        Ok(k as u64 * SAMPLE_EVERY + count)
    }

    /// 文件当前总行数（实时：扫到 EOF 后返回精确值）。
    pub fn total_lines(&mut self, path: &std::path::Path) -> std::io::Result<u64> {
        self.ensure_upto(path, u64::MAX)?;
        Ok(self.lines_upto + if self.eof_no_newline { 1 } else { 0 })
    }

    /// 定位第 `line` 行（1-based）行首的字节偏移。line == 1 → 0。
    /// 越界（line > 总行数）时返回 None。
    pub fn locate_line(&mut self, path: &std::path::Path, line: u64) -> std::io::Result<Option<u64>> {
        if line <= 1 {
            return Ok(Some(0));
        }
        let total = self.total_lines(path)?;
        if line > total {
            return Ok(None);
        }
        let j = ((line - 1) / SAMPLE_EVERY) as usize;
        let base = self.samples[j];
        let r = (line - 1) - j as u64 * SAMPLE_EVERY; // 从 base 起还要跨过的换行数
        if r == 0 {
            return Ok(Some(base));
        }
        // 从 base 向后数 r 个换行；行首 = 第 r 个换行之后的字节。
        let term = self.term;
        let mut file = open_shared_file(path)?;
        file.seek(SeekFrom::Start(base))?;
        let mut buf = vec![0u8; 64 * 1024];
        let mut seen = 0u64;
        let mut pos = base;
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                break; // 理论不可达：line ≤ total 保证换行存在
            }
            let mut from = 0usize;
            while let Some(p) = term.find(&buf[..n], pos, from) {
                seen += 1;
                if seen == r {
                    return Ok(Some(pos + p as u64 + term.len() as u64));
                }
                from = p + term.len();
            }
            pos += n as u64;
        }
        Ok(None)
    }

    /// 定位 0-based 行区间 [start_line, end_line) 的字节偏移（与旧
    /// `line_range_offsets` 语义一致：end_line == 总行数 → end = 文件大小）。
    pub fn locate_range(
        &mut self,
        path: &std::path::Path,
        start_line: u64,
        end_line: u64,
    ) -> std::io::Result<(u64, u64)> {
        if end_line == 0 {
            return Ok((0, 0));
        }
        let total = self.total_lines(path)?;
        let start = if start_line == 0 {
            0
        } else {
            match self.locate_line(path, start_line + 1)? {
                Some(o) => o,
                None => {
                    let f = open_shared_file(path)?;
                    let sz = f.metadata()?.len();
                    return Ok((sz, sz)); // 区间起点超出文件 → 空区间
                }
            }
        };
        let end = if end_line >= total {
            open_shared_file(path)?.metadata()?.len()
        } else {
            match self.locate_line(path, end_line + 1)? {
                Some(o) => o,
                None => open_shared_file(path)?.metadata()?.len(),
            }
        };
        Ok((start, end))
    }

    /// 平均行长（字节/行，估算用）：索引覆盖区内字节数 ÷ 完整行数。
    /// 未覆盖任何行时为 None。用于前端滚动条占位高度的比例估算。
    pub fn avg_line_len(&self) -> Option<f64> {
        if self.lines_upto == 0 {
            None
        } else {
            Some(self.covered_bytes as f64 / self.lines_upto as f64)
        }
    }

    /// 每个稀疏块（`block_lines` 行/块）的平均行长（字节/行）。
    ///
    /// 由 64 行粒度的采样偏移纯算术推算（无 IO）：把每个采样区间的字节按行数
    /// 摊入其覆盖的块。日志的区域密度差异大（堆栈/JSON 段 vs 短状态行），
    /// 全局平均会让「块加载后总高突变 → 滚动条跳变」；按块估算后总高贴近
    /// 真实值，拖动滚动条的幅度与实际进度保持一致。
    /// 索引未覆盖到任何行的块返回 None（前端回退全局平均）。
    pub fn block_avg_lens(&self, block_lines: u64, total_lines: u64) -> Vec<Option<f64>> {
        let block_lines = block_lines.max(1);
        let n_blocks = (((total_lines + block_lines - 1) / block_lines).max(1)) as usize;
        let mut byte_sum = vec![0f64; n_blocks];
        let mut line_sum = vec![0f64; n_blocks];

        // 把「0-based 行区间 [line0, line0+lines) 共 bytes 字节」按行数摊入各块。
        fn distribute(
            line0: u64,
            lines: u64,
            bytes: f64,
            block_lines: u64,
            n_blocks: usize,
            byte_sum: &mut [f64],
            line_sum: &mut [f64],
        ) {
            if lines == 0 || bytes <= 0.0 {
                return;
            }
            let per_line = bytes / lines as f64;
            let mut pos = line0;
            let end = line0 + lines;
            while pos < end {
                let b = (pos / block_lines) as usize;
                if b >= n_blocks {
                    break;
                }
                let take = (block_lines - (pos % block_lines)).min(end - pos);
                byte_sum[b] += per_line * take as f64;
                line_sum[b] += take as f64;
                pos += take;
            }
        }

        // 完整采样区间 i：0-based 行 [i*64, (i+1)*64)，字节 [samples[i], samples[i+1])。
        for i in 0..self.samples.len().saturating_sub(1) {
            let line0 = i as u64 * SAMPLE_EVERY;
            let bytes = (self.samples[i + 1] - self.samples[i]) as f64;
            distribute(
                line0,
                SAMPLE_EVERY,
                bytes,
                block_lines,
                n_blocks,
                &mut byte_sum,
                &mut line_sum,
            );
        }
        // 末尾部分区间：最后一个采样点 → covered_bytes，行 [last*64, lines_upto)。
        let last = self.samples.len() - 1;
        let tail_line0 = last as u64 * SAMPLE_EVERY;
        let tail_lines = self.lines_upto.saturating_sub(tail_line0);
        if tail_lines > 0 {
            let tail_bytes = self.covered_bytes.saturating_sub(self.samples[last]) as f64;
            distribute(
                tail_line0,
                tail_lines,
                tail_bytes,
                block_lines,
                n_blocks,
                &mut byte_sum,
                &mut line_sum,
            );
        }

        byte_sum
            .iter()
            .zip(line_sum.iter())
            .map(|(&b, &l)| if l > 0.0 { Some(b / l) } else { None })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn file_with(content: &str) -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(content.as_bytes()).unwrap();
        f.flush().unwrap();
        f
    }

    #[test]
    fn total_lines_matches_trailing_newline_variants() {
        let cases = [("", 0u64), ("a", 1), ("a\n", 1), ("a\nb", 2), ("a\nb\n", 2), ("a\r\nb\r\n", 2)];
        for (content, expect) in cases {
            let f = file_with(content);
            let mut idx = LineIndex::new();
            assert_eq!(idx.total_lines(f.path()).unwrap(), expect, "content={content:?}");
        }
    }

    #[test]
    fn locate_line_is_exact_across_sample_boundaries() {
        // 10_000 行，每行 "line-{i:06}\n" = 12 字节，行首偏移 = i*12。
        let mut f = tempfile::NamedTempFile::new().unwrap();
        for i in 0..10_000usize {
            writeln!(f, "line-{i:06}").unwrap();
        }
        f.flush().unwrap();
        let path = f.path().to_path_buf();

        let mut idx = LineIndex::new();
        for line in [1u64, 2, 63, 64, 65, 127, 128, 129, 5000, 9999, 10_000] {
            let off = idx.locate_line(&path, line).unwrap().expect("line in range");
            assert_eq!(off, (line - 1) * 12, "line {line}");
        }
        // 越界返回 None。
        assert!(idx.locate_line(&path, 10_001).unwrap().is_none());
    }

    #[test]
    fn locate_line_with_trailing_line_without_newline() {
        // 3 行，末行无换行；行首 = 0 / 4 / 8。
        let f = file_with("aaa\nbbb\nccc");
        let mut idx = LineIndex::new();
        assert_eq!(idx.total_lines(f.path()).unwrap(), 3);
        assert_eq!(idx.locate_line(f.path(), 1).unwrap(), Some(0));
        assert_eq!(idx.locate_line(f.path(), 3).unwrap(), Some(8));
        assert_eq!(idx.locate_line(f.path(), 4).unwrap(), None);
    }

    // ==================== UTF-16（2 字节换行） ====================
    //
    // 这一组的价值在于：索引里的换行计数、采样偏移、行首定位三处代码都要按
    // **2 字节对齐**匹配 `0A 00`，任何一处退回「数裸 0x0A」都会让行首落在半个
    // 字符上（读出乱码或 U+FFFD），而 offset 看上去还对得上 —— 属于最难自查的
    // 那类 bug，必须有测试钉住。

    /// 造一个 UTF-16LE 文件：每行 `行-{i:03}\r\n`（CRLF 也一起覆盖）。
    fn utf16le_lines_file(count: usize, le: bool) -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        let mut bytes: Vec<u8> = Vec::new();
        for i in 0..count {
            for unit in format!("行-{i:05}\r\n").encode_utf16() {
                let pair = if le {
                    unit.to_le_bytes()
                } else {
                    unit.to_be_bytes()
                };
                bytes.extend_from_slice(&pair);
            }
        }
        f.write_all(&bytes).unwrap();
        f.flush().unwrap();
        f
    }

    /// 一行（`行-{i:05}\r\n`）在 UTF-16 下的字节数：码元数 × 2。
    /// 由内容本身算出来，避免测试里写死一个会随格式漂移的魔数。
    fn utf16_line_bytes() -> u64 {
        utf16_line_units() * 2
    }

    fn utf16_line_units() -> u64 {
        "行-00000\r\n".encode_utf16().count() as u64
    }

    #[test]
    fn utf16_total_lines_and_locate_are_aligned() {
        let line_bytes = utf16_line_bytes();
        let f = utf16le_lines_file(200, true);
        let path = f.path().to_path_buf();

        let mut idx = LineIndex::with_term(LineTerm::Lf16Le);
        assert_eq!(idx.total_lines(&path).unwrap(), 200);
        // 跨越采样点（64 行）与端点都要覆盖：行首必须是 2 字节对齐的整行起点。
        for line in [1u64, 2, 63, 64, 65, 128, 199, 200] {
            let off = idx
                .locate_line(&path, line)
                .unwrap()
                .unwrap_or_else(|| panic!("line {line} 应在范围内"));
            assert_eq!(off, (line - 1) * line_bytes, "line {line}");
            assert_eq!(off % 2, 0, "line {line} 的行首必须 2 字节对齐");
        }
        assert!(idx.locate_line(&path, 201).unwrap().is_none());

        // 区间定位与逐行定位自洽（行区间读取走的是 locate_range）。
        let (start, end) = idx.locate_range(&path, 9, 12).unwrap();
        assert_eq!((start, end), (9 * line_bytes, 12 * line_bytes));
    }

    /// 同样的内容用大端序写：换行形态必须跟着换成 `00 0A`，行号才对得上。
    #[test]
    fn utf16be_total_lines_and_locate_are_aligned() {
        let f = utf16le_lines_file(200, false);
        let path = f.path().to_path_buf();

        let mut idx = LineIndex::with_term(LineTerm::Lf16Be);
        assert_eq!(idx.total_lines(&path).unwrap(), 200);
        assert_eq!(
            idx.locate_line(&path, 65).unwrap(),
            Some(64 * utf16_line_bytes())
        );
    }

    /// 用错换行形态（把 UTF-16LE 当 LF 扫）会数出错误的行数 —— 这条断言说明
    /// 「索引的 term 必须与读取路径一致」不是可选项。
    #[test]
    fn utf16_file_under_lf_term_counts_wrong() {
        let f = utf16le_lines_file(200, true);
        let path = f.path().to_path_buf();

        let mut lf_idx = LineIndex::new();
        let wrong = lf_idx.total_lines(&path).unwrap();
        assert_ne!(wrong, 200, "按裸 0x0A 扫 UTF-16 必然数错（实测 {wrong}）");
    }

    /// 末行无换行的 UTF-16 文件：末行计 1 行（`eof_no_newline` 也要按 2 字节判定）。
    #[test]
    fn utf16_trailing_line_without_terminator() {
        let mut bytes: Vec<u8> = Vec::new();
        for unit in "aa\nbb".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(&bytes).unwrap();
        f.flush().unwrap();

        let mut idx = LineIndex::with_term(LineTerm::Lf16Le);
        assert_eq!(idx.total_lines(f.path()).unwrap(), 2);
        assert_eq!(idx.locate_line(f.path(), 2).unwrap(), Some(6)); // "aa\n" = 3 码元 = 6 字节
    }

    /// 只写完换行符的前一字节（写入进程正写到一半）：不能把它当成一个换行，
    /// 否则会把半行拆出来、行号提前 +1。
    #[test]
    fn utf16_partial_terminator_at_eof_is_not_a_line_break() {
        let mut bytes: Vec<u8> = Vec::new();
        for unit in "aa".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        bytes.push(0x0A); // 换行符只写进来一半
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(&bytes).unwrap();
        f.flush().unwrap();

        let mut idx = LineIndex::with_term(LineTerm::Lf16Le);
        assert_eq!(idx.total_lines(f.path()).unwrap(), 1, "半截换行不算换行");
    }

    /// 块长必须对齐到换行符宽度（`LineTerm::align_chunk` 的存在理由）。
    ///
    /// 每行 `"a\n"` 在 UTF-16LE 下是 4 字节，换行符落在偏移 2、6、10…。
    /// 用 3 字节的预算扫描时，第一块的边界正好是 `2 + 1` —— 横跨边界的那个换行符
    /// 前一块凑不满 2 字节、后一块的绝对偏移是奇数，两边都不认：行数少 1，
    /// 之后每个采样偏移都错一行。对齐之后（4 字节对齐成 2）就不会再出现。
    #[test]
    fn utf16_scan_step_with_an_odd_budget_still_counts_every_line() {
        let mut bytes: Vec<u8> = Vec::new();
        for _ in 0..200 {
            for unit in "a\n".encode_utf16() {
                bytes.extend_from_slice(&unit.to_le_bytes());
            }
        }
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(&bytes).unwrap();
        f.flush().unwrap();
        let path = f.path().to_path_buf();

        let mut idx = LineIndex::with_term(LineTerm::Lf16Le);
        let mut steps = 0;
        while !idx.scan_step(&path, 3).unwrap() {
            steps += 1;
            assert!(steps < 10_000, "扫描没有推进（budget 被对齐成了 0？）");
        }
        assert_eq!(idx.total_lines(&path).unwrap(), 200);
    }

    /// 同一份文件改用一次性扫完（`total_lines` 走 `ensure_upto`）：结论必须一致。
    #[test]
    fn utf16_odd_budget_matches_single_pass_count() {
        let mut bytes: Vec<u8> = Vec::new();
        for _ in 0..200 {
            for unit in "a\n".encode_utf16() {
                bytes.extend_from_slice(&unit.to_le_bytes());
            }
        }
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(&bytes).unwrap();
        f.flush().unwrap();
        let path = f.path().to_path_buf();

        let mut incremental = LineIndex::with_term(LineTerm::Lf16Le);
        let mut steps = 0;
        while !incremental.scan_step(&path, 7).unwrap() {
            steps += 1;
            assert!(steps < 10_000);
        }
        let mut single = LineIndex::with_term(LineTerm::Lf16Le);
        assert_eq!(
            incremental.total_lines(&path).unwrap(),
            single.total_lines(&path).unwrap()
        );
        assert_eq!(incremental.locate_line(&path, 200).unwrap(), single.locate_line(&path, 200).unwrap());
    }

    /// **写了一半的 UTF-16 日志随后增长**：横跨「已扫描边界」的那个换行符不能丢。
    ///
    /// 场景来自真实用法：日志由别的进程边写边刷，索引的预热任务可能正好在文件大小
    /// 是奇数（换行符只写进来一半）时扫完。若那时把 `covered_bytes` 推到那个奇数
    /// 偏移上，等文件增长后，这个换行符前一块凑不满 2 字节、后一块的绝对偏移又是
    /// 奇数 —— 两边都不认，那一行永久丢失，之后每个采样偏移都错一行。
    /// 「停在不足一个换行符宽度的尾巴之前」正是为了它。
    #[test]
    fn utf16_odd_size_file_then_growth_keeps_every_line() {
        // 先写 "aa" + 换行符的前一字节：文件大小 5（奇数）。
        let mut bytes: Vec<u8> = Vec::new();
        for unit in "aa".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        bytes.push(0x0A); // 换行符只写进来一半

        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(&bytes).unwrap();
        f.flush().unwrap();
        let path = f.path().to_path_buf();

        let mut idx = LineIndex::with_term(LineTerm::Lf16Le);
        // 预热扫到它以为的 EOF。
        let mut steps = 0;
        while !idx.scan_step(&path, 64).unwrap() {
            steps += 1;
            assert!(steps < 1000, "扫描没有推进");
        }
        assert_eq!(idx.total_lines(&path).unwrap(), 1, "半截换行时只有一条未完结的行");

        // 写入进程补上换行符的后一字节，再写一行。
        let mut more: Vec<u8> = vec![0x00];
        for unit in "bb\n".encode_utf16() {
            more.extend_from_slice(&unit.to_le_bytes());
        }
        f.write_all(&more).unwrap();
        f.flush().unwrap();

        assert_eq!(idx.total_lines(&path).unwrap(), 2, "增长后必须看到两行");
        assert_eq!(
            idx.locate_line(&path, 2).unwrap(),
            Some(6),
            "第 2 行应从字节 6 起（\"aa\" + 2 字节换行）"
        );
    }

    #[test]
    fn locate_range_matches_full_scan_semantics() {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        for i in 0..5000usize {
            writeln!(f, "L{i:05}").unwrap();
        }
        f.flush().unwrap();
        let path = f.path().to_path_buf();
        let size = path.metadata().unwrap().len();

        let mut idx = LineIndex::new();
        // 与 tail::line_range_offsets 的全扫结果对照。
        for (s, e) in [(0u64, 5000u64), (10, 20), (4999, 5000), (3000, 3001), (0, 1)] {
            let (a, b) = idx.locate_range(&path, s, e).unwrap();
            let (x, y) = crate::tail::line_range_offsets(&path, s, e).unwrap();
            assert_eq!((a, b), (x, y), "range [{s}, {e})");
        }
        // end == 总行数 → end = 文件大小。
        let (_, end) = idx.locate_range(&path, 4000, 5000).unwrap();
        assert_eq!(end, size);
    }

    #[test]
    fn incremental_extension_and_growth() {
        // 定宽 10 字节/行（"seed-0000\n"），偏移可精确推算。
        let mut f = tempfile::NamedTempFile::new().unwrap();
        for i in 0..1000usize {
            writeln!(f, "seed-{i:04}").unwrap();
        }
        f.flush().unwrap();
        let path = f.path().to_path_buf();

        let mut idx = LineIndex::new();
        // 播种前 500 行区域（500 × 10 字节）。
        let first500 = 500u64 * 10;
        let n = idx.seed_range(&path, first500).unwrap();
        assert_eq!(n, 500);
        assert_eq!(idx.covered_bytes(), first500);
        // 行号在播种区内的定位正确。
        assert_eq!(idx.locate_line(&path, 500).unwrap(), Some(499 * 10));

        // 文件继续增长 500 行。
        for i in 1000..1500usize {
            writeln!(f, "seed-{i:04}").unwrap();
        }
        f.flush().unwrap();
        assert_eq!(idx.total_lines(&path).unwrap(), 1500);
        assert_eq!(idx.locate_line(&path, 1500).unwrap(), Some(1499 * 10));
    }

    #[test]
    fn line_no_at_offset_matches_newline_count() {
        // 定宽 10 字节/行（"line-0000\n"）。
        let mut f = tempfile::NamedTempFile::new().unwrap();
        for i in 0..2000usize {
            writeln!(f, "line-{i:04}").unwrap();
        }
        f.flush().unwrap();
        let path = f.path().to_path_buf();

        let mut idx = LineIndex::new();
        // 任意偏移：返回该偏移之前的完整行数。
        for x in [0u64, 10, 20, 1000 * 10, 1999 * 10, 2000 * 10] {
            let n = idx.line_no_at_offset(&path, x).unwrap();
            assert_eq!(n, x / 10, "offset {x}");
        }
    }

    #[test]
    fn reset_clears_and_bumps_generation() {
        let f = file_with("a\nb\nc\n");
        let mut idx = LineIndex::new();
        assert_eq!(idx.total_lines(f.path()).unwrap(), 3);
        let gen = idx.generation;
        idx.reset();
        assert_eq!(idx.generation, gen + 1);
        assert_eq!(idx.lines_upto, 0);
        assert_eq!(idx.covered_bytes(), 0);
        assert_eq!(idx.total_lines(f.path()).unwrap(), 3); // 重置后可重新扫描
    }

    #[test]
    fn block_avg_lens_reflects_regional_density() {
        // 块 0：每行 10 字节 × 128 行；块 1：每行 100 字节 × 128 行。
        // 块大小取 128（= 2×64 采样间隔），块边界与采样对齐 → 密度可精确验证。
        let mut f = tempfile::NamedTempFile::new().unwrap();
        for i in 0..128usize {
            writeln!(f, "{:09}", i).unwrap(); // 9 + \n = 10 字节
        }
        for _ in 0..128usize {
            writeln!(f, "{}", "x".repeat(99)).unwrap(); // 99 + \n = 100 字节
        }
        f.flush().unwrap();
        let path = f.path().to_path_buf();

        let mut idx = LineIndex::new();
        let total = idx.total_lines(&path).unwrap();
        assert_eq!(total, 256);

        let lens = idx.block_avg_lens(128, total);
        assert_eq!(lens.len(), 2);
        let l0 = lens[0].unwrap();
        let l1 = lens[1].unwrap();
        assert!((l0 - 10.0).abs() < 0.01, "block0 avg={l0}");
        assert!((l1 - 100.0).abs() < 0.01, "block1 avg={l1}");

        // block_lines 跨两块（256 行一块）→ 混合平均 = (1280 + 12800) / 256 = 55。
        let lens = idx.block_avg_lens(256, total);
        assert_eq!(lens.len(), 1);
        let lm = lens[0].unwrap();
        assert!((lm - 55.0).abs() < 0.01, "mixed avg={lm}");

        // 未覆盖区域（重置后无数据）→ None。
        idx.reset();
        let lens = idx.block_avg_lens(128, total);
        assert!(lens.iter().all(|v| v.is_none()));
    }

    #[test]
    fn block_avg_lens_handles_partial_tail_interval() {
        // 70 行 × 10 字节：完整采样区间只有 1 个（64 行），剩余 6 行走部分区间。
        let mut f = tempfile::NamedTempFile::new().unwrap();
        for i in 0..70usize {
            writeln!(f, "{:09}", i).unwrap();
        }
        f.flush().unwrap();
        let path = f.path().to_path_buf();

        let mut idx = LineIndex::new();
        let total = idx.total_lines(&path).unwrap();
        let lens = idx.block_avg_lens(10_000, total);
        assert_eq!(lens.len(), 1);
        let l = lens[0].unwrap();
        assert!((l - 10.0).abs() < 0.01, "avg={l}");
    }

    #[test]
    fn scan_step_reports_eof() {
        let f = file_with(&"x".repeat(5000));
        let mut idx = LineIndex::new();
        let mut steps = 0;
        while !idx.scan_step(f.path(), 1024).unwrap() {
            steps += 1;
            assert!(steps < 100, "扫描步数异常");
        }
        assert_eq!(idx.lines_upto, 0); // 无换行
        assert_eq!(idx.total_lines(f.path()).unwrap(), 1); // 末尾残行计 1
    }

    /// 性能探针：200k 行的全量索引 + 随机定位耗时（--nocapture 查看）。
    #[test]
    fn perf_probe_index_200k() {
        use std::time::Instant;
        let mut f = tempfile::NamedTempFile::new().unwrap();
        for i in 0..200_000usize {
            writeln!(f, "2026-01-01 12:00:00.000 [INFO] [module{}] message id={} value={}", i % 20, i, i * 7).unwrap();
        }
        f.flush().unwrap();
        let path = f.path().to_path_buf();

        let t = Instant::now();
        let mut idx = LineIndex::new();
        let total = idx.total_lines(&path).unwrap();
        eprintln!("[perf] index full scan 200k lines: {:?}, total={}", t.elapsed(), total);

        let t2 = Instant::now();
        for i in 0..1000u64 {
            let line = (i * 137) % total + 1;
            idx.locate_line(&path, line).unwrap().unwrap();
        }
        eprintln!("[perf] index 1000 random locates: {:?}", t2.elapsed());
    }
}
