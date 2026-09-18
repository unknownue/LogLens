//! 正文内搜索：纯前向字符串匹配（无正则、无全局计数），命中窗口封顶。
//!
//! 语义（前端「查找」悬浮框的落点：`runSearch` / `searchNext`）：
//! - **范围随过滤状态切换**：过滤生效时搜「过滤后的行」（用户看得见的那些行）；
//!   未生效时从 `from_file_line` 对应的字节偏移起**流式**扫描整个文件——分块读取，
//!   不把文件读进内存。
//! - **纯前向、不做全局计数**：一次调用只返回「从起点向后扫出的命中窗口」，
//!   封顶 [`SEARCH_HIT_CAP`]；`complete = false` 表示被上限截断、后面可能还有。
//! - **大小写 / 全字**由调用方开关；大小写不敏感按 ASCII 折叠（与 filter.rs 关键词
//!   过滤同一套 Aho-Corasick 内建折叠，零堆分配）。
//! - 只做字符串匹配，**不支持正则**（正则过滤是 filter.rs 的事，两者互不影响）。
//!
//! 命中粒度：一行里**每一处**命中各算一条 [`SearchHit`]（同一 `file_line` 可以出现
//! 多条、`offset` 不同），前端据此逐个导航并给「当前命中」加重高亮。
//! 续扫约定：被封顶截断时，若最后一行的命中尚未取完，从「最后一条命中的 file_line」
//! （含）续扫不会丢命中（重复项按 (file_line, offset) 去重）；从 `最后一行 + 1` 续扫
//! 会跳过该行剩余的命中（10 万命中量级下的边界情形）。
//!
//! 内存口径：命中窗口 ≤ [`SEARCH_HIT_CAP`] 条（约 1.2MB），扫描缓冲 8MiB，
//! 另有「尚未见到换行的当前行」残片（与 TailReader::pending 同一口径）。

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use aho_corasick::AhoCorasick;

use crate::encoding::EncodingDef;

/// 单次前向搜索的命中数上限。
///
/// 命中窗口整体经 IPC 传给前端（`search_lines` 的返回值），
/// 上限同时界定 IPC 负载（10 万 × 约 12 字节 ≈ 1.2MB JSON）与后端内存占用，
/// 使「大文件里搜一个高频词」不会把整个命中集塞进内存/一次 IPC。
pub const SEARCH_HIT_CAP: usize = 100_000;

/// 整文件流式扫描的块大小（与 index.rs 的 `SCAN_CHUNK_BYTES` 一致：8MiB）。
const SCAN_CHUNK_BYTES: usize = 8 * 1024 * 1024;

/// 匹配方式：子串 / 全字（前端 `kind` 传 "substring" | "wholeword"）。
#[derive(Debug, Clone, Copy, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MatchKind {
    Substring,
    WholeWord,
}

/// 一条命中：绝对文件行号（1-based）+ 命中在该行文本里的**字符**（Unicode 标量）偏移。
#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchHit {
    pub file_line: u64,
    pub offset: u32,
}

/// 一次前向搜索的返回负载。
#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchPage {
    pub hits: Vec<SearchHit>,
    /// true = 扫到了本次搜索范围的末尾；false = 触发 [`SEARCH_HIT_CAP`] 封顶。
    pub complete: bool,
    /// 搜索范围总行数（过滤态 = 过滤后行数；否则 = 文件总行数）。
    pub scope_total: u64,
}

impl SearchPage {
    /// 空页（未扫到任何内容）：范围行数 + 「已扫完」。
    pub(crate) fn empty(scope_total: u64) -> Self {
        Self {
            hits: Vec::new(),
            complete: true,
            scope_total,
        }
    }
}

/// 词字符判断（全字匹配用）：ASCII 字母数字与下划线是词字符；
/// 任何 ≥ 0x80 的字节同样按词字符处理——UTF-8 多字节序列的每个字节都 ≥ 0x80，
/// 逐字节判断即可，**不需要也不应该**去解码半个字符（否则截断的序列会 panic）。
/// CJK 等非 ASCII 文本因此也能得到正确的全字边界（「中文err中文」不算独立单词）。
#[inline]
fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b >= 0x80
}

/// 构建单模式匹配器：大小写不敏感由 Aho-Corasick 内建的 ASCII 折叠处理
/// （与 filter.rs 关键词过滤同一套做法，避免每行 to_lowercase 的堆分配）。
pub(crate) fn build_matcher(query: &str, case_sensitive: bool) -> Result<AhoCorasick, String> {
    AhoCorasick::builder()
        .match_kind(aho_corasick::MatchKind::Standard)
        .ascii_case_insensitive(!case_sensitive)
        .build([query])
        .map_err(|e| format!("构建搜索匹配器失败: {e}"))
}

/// 在一行文本里收集全部命中，追加到 `hits`。
/// 返回 true 表示命中数已达 [`SEARCH_HIT_CAP`]（调用方应立即停止扫描）。
///
/// `text` 必须与前端收到的行文本口径一致（行尾无 \r\n），
/// `offset` 为该文本里的字符偏移（`text[..byte_idx].chars().count()`）。
pub(crate) fn collect_line_hits(
    ac: &AhoCorasick,
    kind: MatchKind,
    text: &str,
    file_line: u64,
    hits: &mut Vec<SearchHit>,
) -> bool {
    if hits.len() >= SEARCH_HIT_CAP {
        return true;
    }
    let bytes = text.as_bytes();
    // Aho-Corasick 从左到右的不重叠命中（与 VSCode 查找一致：aaaa 里搜 aa 得 2 处）。
    for m in ac.find_iter(text) {
        if kind == MatchKind::WholeWord {
            // 命中两侧只要紧邻词字符就不算独立单词；字节级判断，不触碰边界外的解码。
            let before_is_word = m.start() > 0 && is_word_byte(bytes[m.start() - 1]);
            let after_is_word = m.end() < bytes.len() && is_word_byte(bytes[m.end()]);
            if before_is_word || after_is_word {
                continue;
            }
        }
        hits.push(SearchHit {
            file_line,
            offset: text[..m.start()].chars().count() as u32,
        });
        if hits.len() >= SEARCH_HIT_CAP {
            return true;
        }
    }
    false
}

/// 把一行**已解码**的文本交给匹配器。返回 true = 命中数已达上限。
///
/// 解码（含按编码替换非法字节、剥行尾 `\r`）由 [`crate::encoding::split_complete`]
/// 统一完成，与前端经 `get_lines`/`get_range` 收到的行文本口径完全一致。
fn emit_text(
    ac: &AhoCorasick,
    kind: MatchKind,
    text: &str,
    file_line: u64,
    hits: &mut Vec<SearchHit>,
) -> bool {
    collect_line_hits(ac, kind, text, file_line, hits)
}

/// 整文件路径：从字节偏移 `start_off` 起流式向后扫描到文件末尾。
///
/// - `first_line_no` 是 `start_off` 处那一行的文件行号（1-based，由行索引 `locate_line`
///   定位得到，因此必然落在行首、行号精确）。
/// - `def` 是当前生效的编码：决定换行符形态与解码方式（UTF-16 的换行是 2 字节）。
/// - 每块读取前重取文件大小：文件在扫描期间被追加时能看到新字节；变小（截断/轮转）
///   或句柄失效时按「已扫到的内容」提前收工，返回 `complete = true` 而不是报错。
/// - 跨块行用 `pending` 残片缓冲拼接；其内存上界 = 最长的一条未换行行
///   （与 TailReader::pending 同一口径）。
///
/// 返回 (命中, complete)。
pub(crate) fn scan_file_from(
    path: &Path,
    start_off: u64,
    first_line_no: u64,
    ac: &AhoCorasick,
    kind: MatchKind,
    def: &'static EncodingDef,
) -> Result<(Vec<SearchHit>, bool), String> {
    let mut file = crate::tail::open_shared_file(path).map_err(|e| format!("打开文件失败: {e}"))?;
    file.seek(SeekFrom::Start(start_off))
        .map_err(|e| format!("seek 失败: {e}"))?;

    let mut buf = vec![0u8; SCAN_CHUNK_BYTES];
    let mut pending: Vec<u8> = Vec::new();
    let mut hits: Vec<SearchHit> = Vec::new();
    let mut line_no = first_line_no;
    let mut pos = start_off;
    let mut capped = false;
    let mut at_eof = false;

    loop {
        let size = match file.metadata() {
            Ok(m) => m.len(),
            Err(_) => break, // 句柄失效（被删除/轮转）：按已扫内容返回
        };
        if size < pos {
            break; // 文件变小：截断/轮转，按已扫内容返回
        }
        let want = ((size - pos).min(SCAN_CHUNK_BYTES as u64)) as usize;
        if want == 0 {
            at_eof = true; // 已追上当前文件末尾：范围扫完
            break;
        }
        let n = match file.read(&mut buf[..want]) {
            Ok(n) => n,
            Err(_) => break, // 读取失败（截断/锁冲突）：按已扫内容返回
        };
        if n == 0 {
            break; // 期望还有字节却读到 EOF：截断/轮转
        }

        // 残片 + 本块拼成一段连续字节再切行：换行符可能横跨块边界（UTF-16 是
        // 2 字节），交给 Splitter 统一处理比在块内手写状态机可靠。
        let pending_len = pending.len() as u64;
        let mut combined = std::mem::take(&mut pending);
        combined.extend_from_slice(&buf[..n]);
        let base = pos - pending_len;
        let (lines, rest) = crate::encoding::split_complete(&combined, base, def);
        pending = rest;

        for text in &lines {
            let done = emit_text(ac, kind, text, line_no, &mut hits);
            line_no += 1;
            if done {
                capped = true;
                break;
            }
        }
        if capped {
            break;
        }
        pos += n as u64;
    }

    // 读到文件末尾时，末尾未换行的残片就是最后一行（与总行数/按行读取口径一致）。
    // 命中封顶而提前收工时不再处理残片（续扫会从该行重新开始）。
    if at_eof && !capped && !pending.is_empty() {
        // 残片的绝对起点 = 已扫到的位置 - 残片长度。只有它正好是文件第 0 字节时才剥
        // BOM —— 否则正文里一个真实的 U+FEFF 会被吃掉，而命中偏移是按文本算的，
        // 与显示路径（`split_inclusive`）的口径就对不上了。
        let line_start = pos.saturating_sub(pending.len() as u64);
        let raw = if line_start == 0 {
            crate::encoding::strip_bom(&pending, def)
        } else {
            &pending[..]
        };
        let text = crate::encoding::decode_line(raw, def);
        emit_text(ac, kind, &text, line_no, &mut hits);
    }

    Ok((hits, !capped))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::Arc;

    use crate::encoding;
    use crate::filter::FilterSpec;
    use crate::state::TabSession;
    use crate::tail::TailReader;

    /// 用真实临时文件接好会话（file_path + 行索引 + reader），与生产路径一致：
    /// 整文件搜索靠行索引定位起点，再从磁盘流式扫描。
    fn session_for_file(path: &Path) -> Arc<TabSession> {
        let s = TabSession::new();
        *s.file_path.lock() = Some(path.to_path_buf());
        let mut reader = TailReader::new(path.to_path_buf(), encoding::utf8());
        // 只加载尾部极少行：整文件路径不依赖已加载窗口。
        let _ = reader.init_tail(2).unwrap();
        *s.index.lock() = reader.index.clone();
        *s.reader.lock() = Some(reader);
        Arc::new(s)
    }

    /// 写一个真实临时文件并接好会话（返回句柄，drop 即删除临时文件）。
    fn file_session(lines: &[&str]) -> (Arc<TabSession>, tempfile::NamedTempFile) {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        f.flush().unwrap();
        let s = session_for_file(f.path());
        (s, f)
    }

    /// 写原始字节的临时文件（非法/截断 UTF-8 用）。
    fn raw_file_session(bytes: &[u8]) -> (Arc<TabSession>, tempfile::NamedTempFile) {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(bytes).unwrap();
        f.flush().unwrap();
        let s = session_for_file(f.path());
        (s, f)
    }

    /// 把「已加载窗口」放进会话（模拟首屏只加载了尾部一段）。
    fn load_window(s: &TabSession, lines: Vec<String>, first_line_no: u64) {
        s.prepend_history(lines, first_line_no);
    }

    /// 命中的 (行号, 字符偏移) 投影：SearchHit 按契约不派生 PartialEq，
    /// 测试里比较这个投影更直观。
    fn hits_of(page: &SearchPage) -> Vec<(u64, u32)> {
        page.hits.iter().map(|h| (h.file_line, h.offset)).collect()
    }

    /// 默认大小写不敏感；`case_sensitive: true` 时不再匹配大小写不同的文本。
    #[test]
    fn substring_is_case_insensitive_by_default_and_respects_case_sensitive() {
        let (s, _f) = file_session(&[
            "2026 INFO nothing here",
            "2026 ERROR Something",
            "2026 error nothing",
        ]);

        let page = s.search_forward("error", MatchKind::Substring, false, 1).unwrap();
        assert_eq!(hits_of(&page), vec![(2, 5), (3, 5)]);
        assert!(page.complete);
        assert_eq!(page.scope_total, 3);

        let page = s.search_forward("error", MatchKind::Substring, true, 1).unwrap();
        assert_eq!(hits_of(&page), vec![(3, 5)], "大小写敏感应只命中全小写的 error");
        assert!(page.complete);
    }

    /// 全字匹配：`err` 不命中 `error`/`errored`，命中独立的 `err`（行首/行尾也算边界）。
    #[test]
    fn whole_word_matches_only_at_word_boundaries() {
        let (s, _f) = file_session(&[
            "prefix error occurred",
            "the err here",
            "err",
            "errored",
            "err at tail",
            "head err",
        ]);

        let page = s.search_forward("err", MatchKind::WholeWord, false, 1).unwrap();
        assert_eq!(hits_of(&page), vec![(2, 4), (3, 0), (5, 0), (6, 5)]);
        assert!(page.complete);

        // 子串模式全部 6 行都命中（对照：差异来自全字边界判断，而非匹配器本身）。
        let page = s.search_forward("err", MatchKind::Substring, false, 1).unwrap();
        assert_eq!(
            hits_of(&page),
            vec![(1, 7), (2, 4), (3, 0), (4, 0), (5, 0), (6, 5)]
        );
    }

    /// 全字匹配在 UTF-8 边界上不得 panic：查询紧邻 CJK（两侧都是多字节序列）时，
    /// 逐字节的「≥0x80 即词字符」判断给出正确边界；字符偏移按 Unicode 标量计。
    #[test]
    fn whole_word_is_utf8_safe_around_cjk_text() {
        let (s, _f) = file_session(&[
            "中文 err 中文",   // 空格间隔 => err 是独立单词
            "中文err中文",     // 两侧紧邻 CJK => 不是独立单词
            "测试错误err测试", // 同上
            "a中err文",        // 同上
        ]);

        let page = s.search_forward("err", MatchKind::WholeWord, false, 1).unwrap();
        assert_eq!(hits_of(&page), vec![(1, 3)], "CJK 紧邻时不应判为独立单词");
        assert!(page.complete);

        // 子串模式：4 行全命中，偏移是字符偏移（CJK 各占 1 个字符，不是 3 字节）。
        let page = s.search_forward("err", MatchKind::Substring, false, 1).unwrap();
        assert_eq!(hits_of(&page), vec![(1, 3), (2, 2), (3, 4), (4, 2)]);

        // 非 ASCII 查询（多字节模式）同样匹配，同一行里的多处置位各算一条。
        let page = s.search_forward("测试", MatchKind::Substring, false, 1).unwrap();
        assert_eq!(hits_of(&page), vec![(3, 0), (3, 7)]);

        // 全字 + 非 ASCII 查询：第 1 行两处「中文」都是独立单词；第 2 行的两处两侧
        // 都紧邻 'e'/'r'（ASCII 词字符）=> 全部落空。
        let page = s.search_forward("中文", MatchKind::WholeWord, false, 1).unwrap();
        assert_eq!(hits_of(&page), vec![(1, 0), (1, 7)]);
    }

    /// 非法/截断 UTF-8：不 panic；行文本按 lossy 解码（与前端经 get_lines/get_range
    /// 收到的文本一致），字符偏移按 lossy 后的文本计算。全字匹配走字节判断，
    /// 因此「替换字符/截断序列」这类 ≥0x80 的字节会阻止相邻的 err 成为独立单词。
    #[test]
    fn invalid_and_truncated_utf8_do_not_panic() {
        // 第 2 行：截断的 CJK 紧邻 err 之前；第 3 行：孤立非法字节 + 空格；第 4 行：截断序列在 err 之后。
        let (s, _f) = raw_file_session(b"ok err here\n\xe4\xb8err here\n\xff\xfe err here\ntail err\xe4\xb8\n");

        let page = s.search_forward("err", MatchKind::Substring, false, 1).unwrap();
        assert_eq!(
            hits_of(&page),
            vec![(1, 3), (2, 1), (3, 3), (4, 5)],
            "第 2/3 行的非法字节各折成 1 个替换字符，偏移按 lossy 文本计"
        );

        let page = s.search_forward("err", MatchKind::WholeWord, false, 1).unwrap();
        assert_eq!(
            hits_of(&page),
            vec![(1, 3), (3, 3)],
            "第 2/4 行的 err 紧邻 ≥0x80 的字节（词字符）=> 不算独立单词"
        );
    }

    /// 过滤态：只在「过滤后留下的行」里搜，scope_total = 过滤后行数。
    /// 被过滤掉的行里同样的文本必须搜不到（不会悄悄回退到整文件扫描）。
    #[test]
    fn filtered_scope_searches_only_rows_that_survived_the_filter() {
        let lines = [
            "2026 INFO token=AAA",
            "2026 ERROR token=BBB",
            "2026 INFO token=CCC",
            "2026 ERROR token=DDD",
            "2026 INFO token=EEE",
            "2026 ERROR token=FFF",
        ];
        let (s, _f) = file_session(&lines);
        // 先把 6 行放进会话（模拟已加载），再设置过滤条件。
        load_window(&s, lines.iter().map(|l| l.to_string()).collect(), 1);

        // 未过滤：范围是整文件（6 行全命中）。
        let page = s.search_forward("token", MatchKind::Substring, false, 1).unwrap();
        assert_eq!(page.hits.len(), 6);
        assert_eq!(page.scope_total, 6);

        // 过滤 ERROR：范围收缩为第 2/4/6 行。
        s.apply_filter(FilterSpec {
            keywords: vec!["ERROR".to_string()],
            regex: None,
            case_sensitive: false,
        });

        let page = s.search_forward("token", MatchKind::Substring, false, 1).unwrap();
        assert_eq!(hits_of(&page), vec![(2, 11), (4, 11), (6, 11)]);
        assert!(page.complete);
        assert_eq!(page.scope_total, 3, "scope_total 应为过滤后的行数");

        // 过滤态的前向起点也按文件行号过滤（含起点行）。
        let page = s.search_forward("token", MatchKind::Substring, false, 5).unwrap();
        assert_eq!(hits_of(&page), vec![(6, 11)]);

        // 清除过滤：范围回到整文件。
        s.apply_filter(FilterSpec::default());
        let page = s.search_forward("token", MatchKind::Substring, false, 1).unwrap();
        assert_eq!(page.hits.len(), 6);
        assert_eq!(page.scope_total, 6);
    }

    /// 未过滤态：从磁盘流式扫描整个文件，能命中「任何已加载窗口之外」的行。
    #[test]
    fn unfiltered_scope_scans_the_whole_file_beyond_loaded_windows() {
        const TOTAL: u64 = 30_000;
        // 命中点在第 3 行（文件很靠前），其余为填充行。
        let mut lines: Vec<String> = (1..=TOTAL)
            .map(|i| {
                if i == 3 {
                    "03 顶部深处的目标行 need-needle-xyz".to_string()
                } else {
                    format!("{i:06} 填充日志内容 padding padding padding")
                }
            })
            .collect();
        let mut f = tempfile::NamedTempFile::new().unwrap();
        for l in &lines {
            writeln!(f, "{l}").unwrap();
        }
        f.flush().unwrap();
        let s = session_for_file(f.path());

        // 会话只加载「尾部 200 行」这一窗口（文件远大于该窗口）。
        let tail: Vec<String> = lines.split_off(lines.len() - 200);
        load_window(&s, tail, TOTAL - 200 + 1);
        assert_eq!(s.current_view().len(), 200);
        assert!(
            s.current_view().iter().all(|l| l.file_line != 3),
            "命中行必须不在已加载窗口内，否则证明不了整文件扫描"
        );

        // 字符偏移：行首 "03 " + 8 个汉字 = 12 个字符后才是指针文本（字节偏移是 28）。
        let page = s.search_forward("need-needle-xyz", MatchKind::Substring, false, 1).unwrap();
        assert_eq!(hits_of(&page), vec![(3, 12)]);
        assert!(page.complete);
        assert_eq!(page.scope_total, TOTAL, "未过滤态的 scope_total 应为文件总行数");

        // 从文件末尾起扫（同样在已加载窗口内，验证边界不越界）。
        let page = s.search_forward("need-needle-xyz", MatchKind::Substring, false, TOTAL).unwrap();
        assert!(page.hits.is_empty());
        assert!(page.complete, "从文件末尾起扫应正常结束（无命中）");
    }

    /// `from_file_line` 为 1-based 且**含**起点：起点之前的命中不返回；
    /// 同一行里的多处置位各算一条命中。
    #[test]
    fn from_file_line_is_inclusive_and_skips_earlier_hits() {
        let (s, _f) = file_session(&[
            "hit line one",
            "nothing",
            "hit line three",
            "nothing",
            "hit line five",
        ]);

        let page = s.search_forward("hit", MatchKind::Substring, false, 1).unwrap();
        assert_eq!(hits_of(&page), vec![(1, 0), (3, 0), (5, 0)]);

        // 含起点行：从第 3 行起扫，第 3 行仍返回。
        let page = s.search_forward("hit", MatchKind::Substring, false, 3).unwrap();
        assert_eq!(hits_of(&page), vec![(3, 0), (5, 0)]);

        // 跳过起点之前（含起点行内更早的）命中。
        let page = s.search_forward("hit", MatchKind::Substring, false, 4).unwrap();
        assert_eq!(hits_of(&page), vec![(5, 0)]);

        // 起点超出文件末尾：空页且已扫完（不报错）。
        let page = s.search_forward("hit", MatchKind::Substring, false, 100).unwrap();
        assert!(page.hits.is_empty());
        assert!(page.complete);
        assert_eq!(page.scope_total, 5);

        // 同一行里多处置位：offset 递增，行号相同。
        let (s2, _f2) = file_session(&["abc abc abc"]);
        let page = s2.search_forward("abc", MatchKind::Substring, false, 1).unwrap();
        assert_eq!(hits_of(&page), vec![(1, 0), (1, 4), (1, 8)]);
    }

    /// 封顶：命中数超过 [`SEARCH_HIT_CAP`] 时停在上限并置 `complete = false`。
    /// 整文件路径与过滤态路径都必须遵守（否则高频词会把命中集撑爆 IPC）。
    #[test]
    fn more_hits_than_cap_stops_at_cap_and_reports_incomplete() {
        // 一行里 100_001 处 "ab"（不重叠），刚好越过上限。
        let line = "ab".repeat(SEARCH_HIT_CAP + 1);
        let mut f = tempfile::NamedTempFile::new().unwrap();
        writeln!(f, "{line}").unwrap();
        f.flush().unwrap();
        let s = session_for_file(f.path());
        load_window(&s, vec![line.clone()], 1);

        let page = s.search_forward("ab", MatchKind::Substring, false, 1).unwrap();
        assert_eq!(page.hits.len(), SEARCH_HIT_CAP);
        assert!(!page.complete, "触发封顶时 complete 必须为 false");
        assert_eq!(page.scope_total, 1);
        // 命中顺序即前向扫描顺序，偏移单调（用于导航）。
        assert_eq!(hits_of(&page)[0], (1, 0));
        assert_eq!(
            hits_of(&page)[SEARCH_HIT_CAP - 1],
            (1, (SEARCH_HIT_CAP as u32 - 1) * 2)
        );

        // 从最后一条命中所在行续扫（含）不会丢命中：第 10 万条之后还有一处。
        let page = s
            .search_forward("ab", MatchKind::Substring, false, 1)
            .unwrap();
        assert_eq!(page.hits.len(), SEARCH_HIT_CAP);
        assert!(!page.complete);

        // 过滤态同样遵守封顶。
        s.apply_filter(FilterSpec {
            keywords: vec!["ab".to_string()],
            regex: None,
            case_sensitive: false,
        });
        let page = s.search_forward("ab", MatchKind::Substring, false, 1).unwrap();
        assert_eq!(page.hits.len(), SEARCH_HIT_CAP);
        assert!(!page.complete);
        assert_eq!(page.scope_total, 1);
    }

    /// 空查询与全空白查询：空页 + `complete = true`，且不报错
    /// （即使 tab 尚未打开文件也不报错）。
    #[test]
    fn empty_query_returns_empty_page_without_error() {
        let (s, _f) = file_session(&["alpha", "beta"]);
        for q in ["", "   ", "\t\n"] {
            let page = s.search_forward(q, MatchKind::Substring, false, 1).unwrap();
            assert!(page.hits.is_empty(), "q={q:?}");
            assert!(page.complete, "q={q:?}");
            assert_eq!(page.scope_total, 2, "q={q:?}");
        }

        // 未打开文件的 tab：空查询同样不报错；非空查询则报「未打开文件」。
        let empty = TabSession::new();
        let page = empty.search_forward("  ", MatchKind::Substring, false, 1).unwrap();
        assert!(page.hits.is_empty());
        assert!(page.complete);
        assert_eq!(page.scope_total, 0);
        assert!(empty.search_forward("x", MatchKind::Substring, false, 1).is_err());
    }

    /// 契约：IPC 的 JSON 形状与前端 App.tsx 的类型逐字段对应
    /// （`kind` 取值 "substring"/"wholeword"；hit 字段 file_line/offset；
    /// page 字段 hits/complete/scope_total —— 前端按这些键名读取）。
    #[test]
    fn ipc_json_shape_matches_frontend_contract() {
        assert_eq!(
            serde_json::from_str::<MatchKind>(r#""substring""#).unwrap(),
            MatchKind::Substring
        );
        assert_eq!(
            serde_json::from_str::<MatchKind>(r#""wholeword""#).unwrap(),
            MatchKind::WholeWord
        );
        assert!(serde_json::from_str::<MatchKind>(r#""regex""#).is_err());

        let page = SearchPage {
            hits: vec![SearchHit {
                file_line: 7,
                offset: 3,
            }],
            complete: false,
            scope_total: 42,
        };
        assert_eq!(
            serde_json::to_string(&page).unwrap(),
            r#"{"hits":[{"file_line":7,"offset":3}],"complete":false,"scope_total":42}"#
        );
        assert_eq!(
            serde_json::to_string(&SearchPage::empty(9)).unwrap(),
            r#"{"hits":[],"complete":true,"scope_total":9}"#
        );
    }

    /// CRLF：匹配与偏移都按去掉行尾 \r 的行文本计算；末尾无换行的最后一行也要搜到。
    #[test]
    fn crlf_lines_are_matched_without_trailing_carriage_return() {
        let (s, _f) = raw_file_session(b"first\r\nthe err here\r\nlast-no-newline err");
        let page = s.search_forward("err", MatchKind::Substring, false, 1).unwrap();
        assert_eq!(hits_of(&page), vec![(2, 4), (3, 16)]);
        assert!(page.complete, "末尾无换行的最后一行也要搜到");
        assert_eq!(page.scope_total, 3);
    }
}
