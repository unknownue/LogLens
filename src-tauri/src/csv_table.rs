//! CSV / TSV 表格解析：正文「表格视图」的**文本**后端。
//!
//! 表格视图有两种后端，按文件扩展名分工（前端的 `tableKindOf`）：
//! - `.bin` → [`crate::client_cfg`]（GM10 配置表，MemoryPack 二进制，需要 schema）；
//! - 其余文本文件（`.csv` / `.tsv` / 手动切进来的 `.txt`…）→ 本模块。
//!
//! ## 为什么解析放在后端
//!
//! 1. **编码**：CSV 大量来自 Excel 导出，国内环境里 GBK/GB18030 与带 BOM 的 UTF-8、
//!    UTF-16（PowerShell `Out-File`）都很常见。整篇解错编码的表格是「乱码表格」，
//!    比打不开更误导人；复用 [`crate::encoding`] 的那一层，与文本视图 / Markdown
//!    预览用的是同一套探测与手动选择。
//! 2. **大文件**：几百 MB 的 CSV 不能整篇跨 IPC 传给前端再解析（解析发生在主线程，
//!    界面会卡住，内存峰值也由前端承担）。这里在**读取时**就按行数 / 文本字节两个
//!    上限截断，只把预览需要的那一部分交出去，超限只是 `truncated = true`（前端显示
//!    一条横幅），不是错误。
//!
//! ## 解析规则（RFC 4180 的宽松实现）
//!
//! 手写状态机而不是引入 `csv` crate：本项目的解析器一律手写（见 `client_cfg.rs`），
//! CSV 的规则本身很短，而「引号内换行 / `""` 转义 / CRLF / 跨块边界」这几条恰好是
//! 引依赖也躲不开的语义，手写反而能一条条钉进单测。
//!
//! - 字段可用 `"` 包裹；引号内的分隔符与换行都是字面内容；`""` 表示一个字面引号。
//! - 换行接受 `\n`、`\r\n`（Windows / Excel）与单个 `\r`。
//! - **空行跳过**（Excel 导出经常带尾随空行；把空行渲染成一行空表格没有意义）。
//! - 宽松处理畸形输入（引号未闭合、引号后又跟了字符）：按字面文本继续解析，
//!   不报错 —— 预览的价值在于「看到内容」，而不是替用户判定文件不合法。
//! - **不做类型推断**：所有单元格都是字符串。CSV 没有类型信息，前端自行按需显示，
//!   免得 `00123` 被当成数字吃掉前导零。

use std::io::Read;
use std::path::Path;

use encoding_rs::CoderResult;
use serde::Serialize;

use crate::document::require_file;

/// 默认行数上限：20 万行。
///
/// 为什么是这个量级：表格是虚拟滚动的，渲染成本与行数无关，真正的成本是
/// 「解析 + 跨 IPC 传输 + 前端持有」这三笔。20 万行 × 常见 10 来列在 JSON 里约
/// 10–30 MB，是「打开就能看」的量级；再大就该用文本视图（那边是稀疏读取）。
pub const DEFAULT_MAX_ROWS: u64 = 200_000;

/// 默认文本字节上限：32 MiB（**解码后**的字符字节数）。
///
/// 行数上限管不住「列很多 / 单元格很长」的表（20 万行 × 200 列的 JSON 能到几百 MB），
/// 所以再加一道按文本量截断的闸门。两个上限谁先到谁生效，都只影响预览长度。
pub const DEFAULT_MAX_BYTES: u64 = 32 * 1024 * 1024;

/// 读取块大小：256 KiB（够大以减少系统调用，又不至于让单个块解码后占太多内存）。
const CHUNK: usize = 256 * 1024;

/// CSV 解析结果（IPC 负载，字段名是前后端契约 —— 前端读 snake_case）。
#[derive(Debug, Serialize)]
pub struct CsvTable {
    /// 原始行：**含**可能的表头行、**未补齐**（行长度可能不等，前端按列数取 `?? ""`）。
    ///
    /// 表头交给前端切：那样「首行为表头」开关是纯前端状态，切一下不用重读文件。
    pub rows: Vec<Vec<String>>,
    /// 列数：全表最长的一行有几个字段（表头短于数据行时以数据行为准）。
    pub width: usize,
    /// 实际使用的分隔符（单字符；`\t` 就是制表符）。
    pub delimiter: String,
    /// 是否因为行数 / 字节上限而只解析了文件的一部分。
    pub truncated: bool,
    /// 实际生效的行数上限（前端横幅文案要显示这个数字）。
    pub max_rows: u64,
    /// 文件真实字节数（完整文件，不是读进来那一段）。
    pub bytes: u64,
    /// 实际按哪种编码解出来的（自动探测的结果也在里面）。
    pub encoding: crate::encoding::EncodingInfo,
}

/// 解析一个 CSV / TSV 文件为表格数据。
///
/// - `delimiter`：分隔符，缺省逗号；接受 `,` `\t`(制表符) `;` `|`，也接受
///   `tab` / `\\t` 这类写法（存档里可能存的是转义串）。
/// - `max_rows` / `max_bytes`：预览上限，`None` 用默认值（见 [`DEFAULT_MAX_ROWS`]）。
/// - `encoding`：用户的编码选择，`None`/空/`"auto"` 走自动探测，与文本视图一致。
///
/// 错误文案沿用 `document.rs` / `lib.rs` 的契约（前端 `classifyOpenError` 按文案分流）：
/// - 不是文件（不存在 / 是目录）→ `Err("文件不存在: <path>")`
/// - 读取 IO 失败（无权限等）→ `Err("读取失败: <io error>")`
/// - 分隔符非法（防御）→ `Err("不支持的分隔符: …")`
#[tauri::command]
pub fn parse_csv_table(
    path: String,
    delimiter: Option<String>,
    max_rows: Option<u64>,
    max_bytes: Option<u64>,
    encoding: Option<String>,
) -> Result<CsvTable, String> {
    let delim = normalize_delimiter(delimiter.as_deref().unwrap_or(","))?;
    parse_csv_table_impl(
        Path::new(&path),
        delim,
        max_rows.unwrap_or(DEFAULT_MAX_ROWS),
        max_bytes.unwrap_or(DEFAULT_MAX_BYTES),
        encoding.as_deref().unwrap_or(""),
    )
}

/// 把前端传来的分隔符归一化成单个字符（`tab` / `\t` / `\\t` 都当制表符）。
///
/// 前端只会送合法值，这里是防御：一个带换行的「分隔符」会把整份文件解析成
/// 一个字段，与其悄悄产出无意义的表格，不如明确报错。
fn normalize_delimiter(raw: &str) -> Result<char, String> {
    let c = if raw.is_empty() {
        ','
    } else {
        match raw {
            "tab" | "\\t" | "\\u0009" => '\t',
            "comma" => ',',
            "semicolon" => ';',
            "pipe" => '|',
            _ => raw.chars().next().unwrap_or(','),
        }
    };
    if c == '"' || c == '\r' || c == '\n' {
        return Err(format!("不支持的分隔符: {raw:?}"));
    }
    Ok(c)
}

/// [`parse_csv_table`] 的实现体：不依赖 Tauri runtime，单测直接打这里。
///
/// 读取是**流式**的：按块读字节 → 按选定编码增量解码（跨块的多字节序列由
/// `encoding_rs` 的 Decoder 自己缓冲）→ 喂给 CSV 状态机。任一上限触顶就停止读取，
/// 并用一次「再看一个字节」判定文件是否还有剩余（决定 `truncated`）。
fn parse_csv_table_impl(
    path: &Path,
    delim: char,
    max_rows: u64,
    max_bytes: u64,
    encoding_choice: &str,
) -> Result<CsvTable, String> {
    require_file(path)?;
    let size = path
        .metadata()
        .map(|m| m.len())
        .map_err(|e| format!("读取失败: {}", e))?;

    // 编码在读取前解析：`auto` 要探测文件头部（只读前 64 KiB），具体 id 直接用。
    let resolved = crate::encoding::resolve(path, encoding_choice);
    let def = resolved.def;
    let info = crate::encoding::info(encoding_choice, resolved);

    let mut file = std::fs::File::open(path).map_err(|e| format!("读取失败: {}", e))?;
    let max_rows = max_rows.max(1) as usize;
    let mut decoder = def.enc.new_decoder();
    let mut buf = vec![0u8; CHUNK];
    // 解码目标串必须**先预留容量**：`Decoder::decode_to_string` 不负责扩容，
    // 空 String（capacity 为 0）会让它立刻返回 `OutputFull` 且一个字节都不写
    // —— 表现就是「文件读到了，但一行都没解析出来」。
    // 预留 4×块大小：GB18030 两字节汉字 / UTF-16 代理对解成 UTF-8 最多膨胀到这个量级。
    let mut text = String::with_capacity(CHUNK * 4);
    let mut parser = CsvParser::new(delim, max_rows, max_bytes);
    let mut first_chunk = true;
    // 是否因为触顶而提前停止读取（决定要不要再看一个字节判断 truncated）。
    let mut stopped_early = false;
    // 停止时本块是否还有没喂进状态机的字节。
    let mut leftover = false;

    'read: loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("读取失败: {}", e))?;
        if n == 0 {
            break;
        }
        // BOM 只在文件开头剥（与 `document.rs` 同一口径：按所选编码的 BOM）。
        let chunk = if first_chunk {
            first_chunk = false;
            crate::encoding::strip_bom(&buf[..n], def)
        } else {
            &buf[..n]
        };
        // 一个块可能解不满（dst 写满 → OutputFull）：循环消费，直到本块输入读完。
        let mut off = 0usize;
        while off < chunk.len() {
            text.clear();
            // last = false：块尾不完整的多字节序列留在 Decoder 内部，等下一块补齐。
            let (result, read, _) = decoder.decode_to_string(&chunk[off..], &mut text, false);
            off += read;
            parser.push(&text);
            if parser.hit_limit() {
                stopped_early = true;
                // 本块里还有没喂给状态机的字节 —— 这本身就是「文件更长」的证据。
                leftover = off < chunk.len();
                break 'read;
            }
            if result == CoderResult::InputEmpty {
                break;
            }
            // OutputFull：扩容后继续（正常不会走到，见上面的容量预留）。
            text.reserve(CHUNK);
        }
    }
    if !stopped_early {
        // 收尾：把 Decoder 内部缓冲的残片吐出来（`last = true`）。
        // 返回值（CoderResult / 读取字节数 / 是否替换过非法序列）这里用不上：
        // 收尾只可能吐出一个替换字符，没有需要分支处理的语义。
        text.clear();
        let _ = decoder.decode_to_string(&[], &mut text, true);
        parser.push(&text);
    }
    parser.finish();

    // 「截断」= 确实还有没解析的内容，三处证据任一成立即可：
    //   1. 状态机触顶后还有输入被它丢掉了（同一块内的剩余字符）；
    //   2. 本块还有没喂进去的字节；
    //   3. 文件后面还有字节（整块已读完但文件没读完 —— 只有这种情况要再读一个字节确认）。
    //
    // 为什么不能只看 2 / 3：上限常常在一个 256 KiB 的块**内部**就触顶了，
    // 而此时整个小文件早已被一次性读进缓冲区（文件位置已在 EOF）——
    // 只看「文件还有没有」就会把「明明丢了 3 行」报成没截断。
    let truncated = parser.discarded_input()
        || leftover
        || (stopped_early && {
            let mut one = [0u8; 1];
            file.read(&mut one).map(|n| n > 0).unwrap_or(false)
        });

    let rows = parser.into_rows();
    Ok(CsvTable {
        width: table_width(&rows),
        rows,
        delimiter: delim.to_string(),
        truncated,
        max_rows: max_rows as u64,
        bytes: size,
        encoding: info,
    })
}

/// RFC 4180 状态机的四个状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// 字段开头（还没读到任何字符）：此时 `"` 是引号而不是字面量。
    FieldStart,
    /// 未加引号的字段中。
    Unquoted,
    /// 引号包裹的字段中（分隔符与换行都是字面内容）。
    Quoted,
    /// 刚读到一个引号：下一个字符决定它是 `""` 转义、字段结束还是畸形输入。
    QuoteEnd,
}

/// CSV 状态机：逐字符推进，按上限提前收手。
///
/// 刻意不持有整个文件的文本：调用方按块喂进来，`self` 只保留「当前字段 + 当前行」。
struct CsvParser {
    delim: char,
    state: State,
    /// 当前字段（累积中）。
    field: String,
    /// 当前行（已结束的字段）。
    record: Vec<String>,
    /// 当前行里是否出现过分隔符 —— 空行判定的依据（见 [`CsvParser::end_record`]）。
    saw_delim: bool,
    /// 上一个字符是否是 CR：`\r\n` 是一个换行，不能数成两个。
    last_cr: bool,
    /// 已解析的行。
    rows: Vec<Vec<String>>,
    /// 行数上限。
    max_rows: usize,
    /// 是否已触顶（触顶后 `push` 变成空操作，等价于停止解析）。
    hit: bool,
    /// 触顶之后是否还有输入被丢掉 —— `truncated` 的直接证据（见 [`CsvParser::discarded_input`]）。
    discarded: bool,
    /// 已消费的输入字节数（UTF-8 字节）与上限：按文本量截断的依据。
    consumed: u64,
    max_bytes: u64,
}

impl CsvParser {
    fn new(delim: char, max_rows: usize, max_bytes: u64) -> Self {
        Self {
            delim,
            state: State::FieldStart,
            field: String::new(),
            record: Vec::new(),
            saw_delim: false,
            last_cr: false,
            rows: Vec::with_capacity(64),
            max_rows,
            hit: false,
            discarded: false,
            consumed: 0,
            max_bytes,
        }
    }

    fn hit_limit(&self) -> bool {
        self.hit
    }

    /// 触顶后是否还有内容被丢弃（有 → 文件比上限长，前端的「已截断」横幅据此显示）。
    fn discarded_input(&self) -> bool {
        self.discarded
    }

    /// 喂一段已解码的文本；行数 / 字节数任一触顶就停止消费（后续输入记为「被丢弃」）。
    ///
    /// 字节上限放在这里逐字符计数、而不是在外面按块判断：一次读取就是 256 KiB，
    /// 在块外面判断会让「上限 300 字节」的文件实际返回 9 KB 的内容。
    fn push(&mut self, text: &str) {
        if self.hit {
            self.discarded |= !text.is_empty();
            return;
        }
        for (i, c) in text.char_indices() {
            self.push_char(c);
            self.consumed += c.len_utf8() as u64;
            if self.hit || self.consumed >= self.max_bytes {
                self.hit = true;
                // 本段里还有没消费的字符 → 确实截断了。
                self.discarded |= i + c.len_utf8() < text.len();
                return;
            }
        }
    }

    fn push_char(&mut self, c: char) {
        // CRLF：`\r` 已经把上一行结束了，紧跟的 `\n` 要吞掉（不能数成两个换行）。
        // 例外是引号内 —— 那里的换行是单元格内容，`\r\n` 必须原样保留。
        if c == '\n' && self.last_cr && self.state != State::Quoted {
            self.last_cr = false;
            return;
        }
        self.last_cr = c == '\r';
        let newline = c == '\n' || c == '\r';

        match self.state {
            State::FieldStart => {
                if c == '"' {
                    self.state = State::Quoted;
                } else if c == self.delim {
                    self.end_field();
                    self.saw_delim = true;
                } else if newline {
                    self.end_record();
                } else {
                    self.field.push(c);
                    self.state = State::Unquoted;
                }
            }
            State::Unquoted => {
                if c == self.delim {
                    self.end_field();
                    self.saw_delim = true;
                    self.state = State::FieldStart;
                } else if newline {
                    self.end_record();
                } else {
                    // 畸形输入（未加引号的字段里出现引号）：按字面量收下。
                    self.field.push(c);
                }
            }
            State::Quoted => {
                if c == '"' {
                    self.state = State::QuoteEnd;
                } else {
                    // 引号内的分隔符与换行都是内容（多行单元格）。
                    self.field.push(c);
                }
            }
            State::QuoteEnd => {
                if c == '"' {
                    // `""` → 一个字面引号，回到引号内。
                    self.field.push('"');
                    self.state = State::Quoted;
                } else if c == self.delim {
                    self.end_field();
                    self.saw_delim = true;
                    self.state = State::FieldStart;
                } else if newline {
                    self.end_record();
                } else {
                    // 引号后跟了别的字符（畸形）：当普通字符接着写，尽量不丢内容。
                    self.field.push(c);
                    self.state = State::Unquoted;
                }
            }
        }
    }

    /// 结束当前字段（把累积的文本推进当前行）。
    fn end_field(&mut self) {
        self.record.push(std::mem::take(&mut self.field));
        self.state = State::FieldStart;
    }

    /// 结束当前行（含 `end_field`），空行丢弃。
    ///
    /// 空行判定：整行只有一个空字段且从未出现分隔符 —— 即文件里一个光秃秃的
    /// 换行符。Excel 导出的 CSV 常有尾随空行，渲染成一行空表格只会让人困惑。
    fn end_record(&mut self) {
        self.end_field();
        let blank = self.record.len() == 1 && self.record[0].is_empty() && !self.saw_delim;
        if !blank {
            self.rows.push(std::mem::take(&mut self.record));
        } else {
            self.record.clear();
        }
        self.saw_delim = false;
        self.state = State::FieldStart;
        if self.rows.len() >= self.max_rows {
            self.hit = true;
        }
    }

    /// 文件结束：把最后一个没有换行符结尾的字段 / 行交出来。
    fn finish(&mut self) {
        if self.hit {
            return;
        }
        // 行尾没有换行符时，状态机还停在字段中间（或引号内未闭合）。
        // 只要本行有任何内容（含分隔符）就补一条记录。
        let pending = !self.field.is_empty()
            || !self.record.is_empty()
            || self.saw_delim
            || self.state == State::Quoted
            || self.state == State::QuoteEnd;
        if pending {
            self.end_record();
        }
    }

    fn into_rows(mut self) -> Vec<Vec<String>> {
        // 触顶时 rows 已经等于上限（end_record 里推进去的那一刻就置了 hit）。
        self.rows.truncate(self.max_rows);
        self.rows
    }
}

/// 表格列数：最长的一行有多少个字段（表头短于数据行时以行为准）。
///
/// 单独算而不是在解析时维护：`width` 要跟着「行数上限内实际解析到的行」走，
/// 解析结束后扫一遍最直接。
pub fn table_width(rows: &[Vec<String>]) -> usize {
    rows.iter().map(|r| r.len()).max().unwrap_or(0)
}

// ============================== 单元测试 ==============================

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 写一个临时文件（原始字节），返回路径与句柄（句柄需存活到测试结束）。
    fn temp_path(bytes: &[u8]) -> (String, tempfile::NamedTempFile) {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(bytes).unwrap();
        f.flush().unwrap();
        let path = f.path().to_string_lossy().to_string();
        (path, f)
    }

    /// 按指定编码把文本编成字节（造测试输入用）。
    fn encode(text: &str, encoding_id: &str) -> Vec<u8> {
        let def = crate::encoding::lookup(encoding_id).expect("目录里应有该编码");
        def.enc.encode(text).0.into_owned()
    }

    /// 默认参数解析（逗号、自动编码、默认上限）。
    fn parse(path: &str) -> CsvTable {
        parse_csv_table_impl(Path::new(path), ',', DEFAULT_MAX_ROWS, DEFAULT_MAX_BYTES, "")
            .unwrap()
    }

    /// 把结果规整成 `Vec<Vec<&str>>` 便于断言。
    fn as_strs(t: &CsvTable) -> Vec<Vec<&str>> {
        t.rows
            .iter()
            .map(|r| r.iter().map(|s| s.as_str()).collect())
            .collect()
    }

    #[test]
    fn parses_plain_comma_csv() {
        let (path, _f) = temp_path(b"name,age,city\nTom,18,Beijing\nAnn,20,Shanghai\n");
        let t = parse(&path);

        assert_eq!(
            as_strs(&t),
            vec![
                vec!["name", "age", "city"],
                vec!["Tom", "18", "Beijing"],
                vec!["Ann", "20", "Shanghai"],
            ]
        );
        assert_eq!(t.width, 3);
        assert_eq!(t.delimiter, ",");
        assert!(!t.truncated);
        assert_eq!(t.bytes, 45);
    }

    #[test]
    fn quoted_fields_keep_delimiters_newlines_and_escaped_quotes() {
        // 引号内：逗号是内容、换行是内容、"" 是一个引号。
        let csv = "a,b\n\"x,y\",\"line1\nline2\"\n\"he said \"\"hi\"\"\",z\n";
        let (path, _f) = temp_path(csv.as_bytes());
        let t = parse(&path);

        assert_eq!(
            as_strs(&t),
            vec![
                vec!["a", "b"],
                vec!["x,y", "line1\nline2"],
                vec!["he said \"hi\"", "z"],
            ]
        );
        assert_eq!(t.width, 2);
    }

    #[test]
    fn crlf_and_lone_cr_both_end_a_row() {
        let (path, _f) = temp_path(b"a,b\r\n1,2\r\n3,4\r");
        let t = parse(&path);
        assert_eq!(as_strs(&t), vec![vec!["a", "b"], vec!["1", "2"], vec!["3", "4"]]);
    }

    #[test]
    fn blank_lines_are_skipped() {
        // Excel 导出常见的尾随空行 / 中间空行都不该变成空表格行。
        let (path, _f) = temp_path(b"a,b\n\n1,2\n\n\n3,4\n\n");
        let t = parse(&path);
        assert_eq!(as_strs(&t), vec![vec!["a", "b"], vec!["1", "2"], vec!["3", "4"]]);
    }

    #[test]
    fn empty_fields_are_kept() {
        // 有分隔符的空字段是**有意义**的空值（与空行区分开）。
        let (path, _f) = temp_path(b"a,b,c\n1,,3\n,,\n");
        let t = parse(&path);
        assert_eq!(
            as_strs(&t),
            vec![vec!["a", "b", "c"], vec!["1", "", "3"], vec!["", "", ""]]
        );
    }

    #[test]
    fn last_row_without_trailing_newline_is_kept() {
        let (path, _f) = temp_path(b"a,b\n1,2");
        let t = parse(&path);
        assert_eq!(as_strs(&t), vec![vec!["a", "b"], vec!["1", "2"]]);
    }

    #[test]
    fn unterminated_quote_still_yields_the_field() {
        // 畸形输入（引号没闭合）：不报错，把已读到的内容交出来。
        // 注意换行也归这个字段 —— 状态机在引号内看不出「这是最后一行了」，
        // 只能按字面收下（活到 EOF 才由 finish() 收尾）。
        let (path, _f) = temp_path(b"a,b\n\"unclosed,2\n");
        let t = parse(&path);
        assert_eq!(as_strs(&t), vec![vec!["a", "b"], vec!["unclosed,2\n"]]);
    }

    #[test]
    fn ragged_rows_report_the_widest_row() {
        let (path, _f) = temp_path(b"a,b\n1,2,3,4\n5\n");
        let t = parse(&path);
        assert_eq!(t.width, 4, "列数应取最长的一行");
        assert_eq!(t.rows[1].len(), 4);
        assert_eq!(t.rows[2].len(), 1, "行本身不补齐，由前端按列数取空串");
    }

    #[test]
    fn tab_and_semicolon_delimiters_are_supported() {
        let (path, _f) = temp_path("a\tb\n1\t2\n".as_bytes());
        let t = parse_csv_table_impl(
            Path::new(&path),
            normalize_delimiter("\\t").unwrap(),
            DEFAULT_MAX_ROWS,
            DEFAULT_MAX_BYTES,
            "",
        )
        .unwrap();
        assert_eq!(as_strs(&t), vec![vec!["a", "b"], vec!["1", "2"]]);

        let (path2, _f2) = temp_path(b"a;b\n1;2\n");
        let t2 = parse_csv_table_impl(
            Path::new(&path2),
            normalize_delimiter(";").unwrap(),
            DEFAULT_MAX_ROWS,
            DEFAULT_MAX_BYTES,
            "",
        )
        .unwrap();
        assert_eq!(as_strs(&t2), vec![vec!["a", "b"], vec!["1", "2"]]);
    }

    #[test]
    fn normalize_delimiter_accepts_aliases_and_rejects_line_breaks() {
        assert_eq!(normalize_delimiter(",").unwrap(), ',');
        assert_eq!(normalize_delimiter("").unwrap(), ',', "缺省是逗号");
        assert_eq!(normalize_delimiter("tab").unwrap(), '\t');
        assert_eq!(normalize_delimiter("\\t").unwrap(), '\t');
        assert_eq!(normalize_delimiter(";").unwrap(), ';');
        assert_eq!(normalize_delimiter("|").unwrap(), '|');
        assert!(normalize_delimiter("\n").is_err(), "换行符不能当分隔符");
        assert!(normalize_delimiter("\"").is_err(), "引号不能当分隔符");
    }

    #[test]
    fn row_cap_truncates_and_reports_more_data() {
        let (path, _f) = temp_path(b"h\n1\n2\n3\n4\n");
        let t = parse_csv_table_impl(Path::new(&path), ',', 2, DEFAULT_MAX_BYTES, "")
            .unwrap();
        assert_eq!(as_strs(&t), vec![vec!["h"], vec!["1"]], "只保留前 2 行");
        assert!(t.truncated, "还有剩余行时应标记截断");
        assert_eq!(t.max_rows, 2);
    }

    #[test]
    fn exact_row_count_is_not_truncated() {
        // 上限恰好等于文件行数：没有剩余内容，不该谎报截断。
        let (path, _f) = temp_path(b"h\n1\n2\n");
        let t = parse_csv_table_impl(Path::new(&path), ',', 3, DEFAULT_MAX_BYTES, "")
            .unwrap();
        assert_eq!(t.rows.len(), 3);
        assert!(!t.truncated);
    }

    #[test]
    fn byte_cap_truncates_long_content() {
        // 每个单元格 100 字节：100 行 × 2 列已经远超 300 字节的上限。
        let mut csv = String::from("c1,c2\n");
        for i in 0..100 {
            csv.push_str(&format!("{}{},x\n", "a".repeat(90), i));
        }
        let (path, _f) = temp_path(csv.as_bytes());
        let t = parse_csv_table_impl(Path::new(&path), ',', DEFAULT_MAX_ROWS, 300, "")
            .unwrap();
        assert!(t.truncated, "超过字节上限应标记截断");
        assert!(t.rows.len() < 100, "应只解析了一部分，实测 {} 行", t.rows.len());
        assert!(t.rows.len() > 1);
    }

    #[test]
    fn decodes_gbk_csv() {
        let content = "名称,数量\n中文项目,3\n";
        let (path, _f) = temp_path(&encode(content, "gbk"));
        // 显式指定 GBK。
        let t = parse_csv_table_impl(Path::new(&path), ',', DEFAULT_MAX_ROWS, DEFAULT_MAX_BYTES, "gbk")
            .unwrap();
        assert_eq!(as_strs(&t), vec![vec!["名称", "数量"], vec!["中文项目", "3"]]);
        assert_eq!(t.encoding.id, "gbk");
        assert_eq!(t.encoding.source, "manual");

        // 自动探测：GBK 字节不是合法 UTF-8 → 落到兜底编码，中文同样正确。
        let auto = parse(&path);
        assert_eq!(as_strs(&auto), vec![vec!["名称", "数量"], vec!["中文项目", "3"]]);
    }

    #[test]
    fn strips_utf8_bom_from_the_first_header() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"name,qty\nTom,1\n");
        let (path, _f) = temp_path(&bytes);

        let t = parse(&path);
        // BOM 若没剥掉，第一列表头会变成 "\u{feff}name"，界面上看不见却对不上。
        assert_eq!(t.rows[0][0], "name");
        assert_eq!(t.width, 2);
    }

    #[test]
    fn decodes_utf16le_with_bom() {
        // PowerShell `Out-File` 的默认输出：UTF-16LE + BOM。
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "名称,数量\n中文,3\n".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let (path, _f) = temp_path(&bytes);

        let t = parse(&path);
        assert_eq!(as_strs(&t), vec![vec!["名称", "数量"], vec!["中文", "3"]]);
        assert_eq!(t.encoding.id, "utf-16le");
        assert_eq!(t.encoding.source, "bom");
    }

    #[test]
    fn empty_file_yields_no_rows() {
        let (path, _f) = temp_path(b"");
        let t = parse(&path);
        assert!(t.rows.is_empty());
        assert_eq!(t.width, 0);
        assert_eq!(t.bytes, 0);
        assert!(!t.truncated);
    }

    #[test]
    fn file_with_only_newlines_yields_no_rows() {
        let (path, _f) = temp_path(b"\n\n\r\n");
        let t = parse(&path);
        assert!(t.rows.is_empty(), "全是空行应解析出 0 行");
    }

    #[test]
    fn missing_file_reports_contract_error() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope.csv");
        assert!(!missing.exists());

        let err = parse_csv_table_impl(&missing, ',', DEFAULT_MAX_ROWS, DEFAULT_MAX_BYTES, "")
            .unwrap_err();
        assert!(err.contains("文件不存在"), "错误文案契约: {err}");
        assert!(err.contains("nope.csv"), "错误应带上路径: {err}");
    }

    #[test]
    fn directory_reports_file_missing() {
        let dir = tempfile::tempdir().unwrap();
        let err = parse_csv_table_impl(dir.path(), ',', DEFAULT_MAX_ROWS, DEFAULT_MAX_BYTES, "")
            .unwrap_err();
        assert!(err.contains("文件不存在"), "传目录应报「文件不存在」: {err}");
    }

    /// 序列化契约：前端读的就是这些字段名（snake_case，与 `MdDoc` 一致）。
    #[test]
    fn serializes_with_the_frontend_contract() {
        let (path, _f) = temp_path(b"a,b\n1,2\n");
        let t = parse(&path);
        let json = serde_json::to_value(&t).unwrap();
        for key in [
            "rows",
            "width",
            "delimiter",
            "truncated",
            "max_rows",
            "bytes",
            "encoding",
        ] {
            assert!(json.get(key).is_some(), "缺少字段 {key}: {json}");
        }
        assert_eq!(json["rows"][1][0], "1");
        assert_eq!(json["width"], 2);
        assert_eq!(json["delimiter"], ",");
    }

    #[test]
    fn default_limits_match_documentation() {
        assert_eq!(DEFAULT_MAX_ROWS, 200_000);
        assert_eq!(DEFAULT_MAX_BYTES, 32 * 1024 * 1024);
    }
}
