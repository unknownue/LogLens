//! 文本编码：探测文件编码、按编码解码，以及「换行符的字节形态」。
//!
//! 为什么需要这一层：整个读取链路（tail 增量、历史加载、稀疏块、整文件搜索、
//! Markdown 整读）此前都用 `String::from_utf8_lossy`，即**假定 UTF-8**。中文 Windows
//! 上大量日志是 GBK/GB18030 写出来的，UTF-8 解码后整篇变成 `����`；PowerShell 的
//! `Out-File` / `>` 重定向又默认写 UTF-16LE。本模块把「字节 → 文本」这一步收敛到
//! 一处，让上层不再假设编码。
//!
//! 三个关键设计：
//!
//! 1. **行切分仍然在字节层做**（[`split_complete`] / [`split_inclusive`]）。
//!    ASCII 兼容的编码（UTF-8/GBK/Big5/Shift_JIS/Latin-x……）里，多字节字符的
//!    尾字节取值区间都不含 `0x0A`，因此 `0x0A` 只可能是真正的换行 —— 这一族
//!    不需要任何额外处理。UTF-16 才是例外：换行是 `0A 00`（LE）或 `00 0A`（BE），
//!    见 [`LineTerm`]。
//!
//! 2. **换行符的字节形态随编码变化**，因此行切分、行号索引、区块定位都必须知道它。
//!    UTF-16 的换行是 2 字节，扫描时必须**按 2 字节对齐**匹配：否则
//!    `U+0A05 U+0B00`（UTF-16LE 下字节是 `05 0A 00 0B`）在偏移 1 处会与 `0A 00`
//!    撞出一个假换行。真实日志里这种组合近乎不可能出现，但「近乎」不是「不会」，
//!    而对齐判定只多一次取模。
//!
//! 3. **探测永不失败**：读不到、判不出来时一律回落到 [`FALLBACK_ID`]，
//!    宁可显示成可能是乱码的文本，也不该让「打开文件」这件事本身失败。
//!    用户随时可以在状态栏里改（见 `set_encoding` 命令）。

use std::borrow::Cow;
use std::io::Read;
use std::path::Path;

use encoding_rs::{
    Encoding, BIG5, EUC_JP, EUC_KR, GB18030, GBK, SHIFT_JIS, UTF_16BE, UTF_16LE, UTF_8,
    WINDOWS_1250, WINDOWS_1251, WINDOWS_1252,
};

/// 「自动探测」的哨兵 id：不指定编码时使用。
pub const AUTO: &str = "auto";

/// 判不出编码时的兜底编码 id。
///
/// 为什么是 GB18030 而不是 UTF-8 或系统 ANSI 代码页：本项目的日志来自中文 Windows
/// 上编译的游戏（见 CLAUDE.md），非 UTF-8 的日志绝大多数是代码页 936 写出来的，
/// 而 GB18030 是 GBK/GB2312 的严格超集 —— 猜 GB18030 能覆盖「GBK 猜对了」的全部
/// 情形，且不会把本来是 GBK 的文件解坏。代价是真正的 Big5 / Shift_JIS 日志会被
/// 猜错，但那些编码本来就无法可靠地区分开（没有统计模型就是在瞎猜），
/// 交给用户在状态栏里手动选更诚实。
pub const FALLBACK_ID: &str = "gb18030";

/// 探测采样的字节数：只读文件头部这么多字节，不做全文件统计。
///
/// 64 KiB 足够覆盖「UTF-8 合法性」判定（有非 ASCII 字符的日志几乎必然在前几行
/// 就出现多字节序列），且对小文件的相对开销可忽略。
pub const SAMPLE_BYTES: u64 = 64 * 1024;

// ==================== 换行符的字节形态 ====================

/// 换行符（LF，不含 CR）在某种编码下的字节形态。
///
/// 之所以把它建模成「形态」而不是「长度」：UTF-16 的换行是两个字节且**字节内容
/// 因端序而不同**，扫描时既要按正确的字节序列匹配，也要按正确的宽度对齐。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineTerm {
    /// 单字节 `0A`：UTF-8 / GBK / Big5 / Shift_JIS / Latin-x 等 ASCII 兼容编码。
    Lf,
    /// UTF-16LE：`0A 00`。
    Lf16Le,
    /// UTF-16BE：`00 0A`。
    Lf16Be,
}

impl LineTerm {
    /// 换行符的字节序列。
    pub const fn bytes(self) -> &'static [u8] {
        match self {
            LineTerm::Lf => b"\n",
            LineTerm::Lf16Le => b"\n\0",
            LineTerm::Lf16Be => b"\0\n",
        }
    }

    /// 换行符的字节宽度（也是这个编码的「对齐单位」）。
    pub const fn len(self) -> usize {
        self.bytes().len()
    }

    /// 行尾回车（CR）的字节序列：剥掉它之后行文本才与前端口径一致。
    pub const fn cr_bytes(self) -> &'static [u8] {
        match self {
            LineTerm::Lf => b"\r",
            LineTerm::Lf16Le => b"\r\0",
            LineTerm::Lf16Be => b"\0\r",
        }
    }

    /// `buf`（首字节在文件中的绝对偏移为 `base`）里下标 `i` 处是否是一个换行符。
    ///
    /// 宽度 > 1 时要求绝对偏移对齐（见模块头注释第 2 点）。
    pub fn matches_at(self, buf: &[u8], base: u64, i: usize) -> bool {
        let width = self.len();
        if width > 1 && !(base + i as u64).is_multiple_of(width as u64) {
            return false;
        }
        buf[i..].starts_with(self.bytes())
    }

    /// 从 `from` 起找下一个换行符的起始下标（对齐偏移才匹配）。
    pub fn find(self, buf: &[u8], base: u64, from: usize) -> Option<usize> {
        (from..buf.len()).find(|&i| self.matches_at(buf, base, i))
    }

    /// `buf` 里的换行符个数。
    pub fn count(self, buf: &[u8], base: u64) -> u64 {
        let mut n = 0u64;
        let mut i = 0usize;
        while let Some(p) = self.find(buf, base, i) {
            n += 1;
            i = p + self.len();
        }
        n
    }

    /// `buf` 是否以换行符结尾（即「末尾没有未完结的行」）。
    ///
    /// 末尾若是被截断的换行（UTF-16 下只剩 1 字节）同样返回 false —— 与
    /// [`split_complete`] 把这点残片留作 pending 的行为保持一致。
    pub fn ends_with(self, buf: &[u8], base: u64) -> bool {
        let width = self.len();
        if buf.len() < width {
            return false;
        }
        let at = buf.len() - width;
        if width > 1 && !(base + at as u64).is_multiple_of(width as u64) {
            return false;
        }
        buf[at..] == *self.bytes()
    }

    /// 把一次块读取的字节数对齐到换行符宽度（**返回值一定是宽度的整数倍**）。
    ///
    /// 为什么必须对齐：按块连续扫描时，模块内的匹配都按**绝对偏移**判奇偶，而块是从
    /// `covered_bytes` 接着往后读的。只要有一块的字节数是奇数，之后所有块的起点奇偶
    /// 就整体翻转 —— 一个恰好横跨块边界的换行符会两边都不认（前一块凑不满 2 字节，
    /// 后一块的绝对偏移是奇数），于是行数少算一行、后面每个采样偏移都错一行。
    ///
    /// 因此这里返回的是 `want` **向下取整到宽度整数倍**的值，不足一个换行符宽度的
    /// 尾巴返回 0（调用方据此停止推进）。这正是「写了一半的日志」那种场景需要的：
    /// 一个 UTF-16 日志当前大小是奇数时，最后一个字节正是半个换行符/半个字符，
    /// 此刻若把它算进 `covered_bytes`，之后文件增长时那个换行符就永远找不回来了。
    /// 停在那之前，等字节到齐再扫即可。
    ///
    /// 1 字节的换行符没有对齐问题，原样返回。
    pub fn align_chunk(self, want: usize) -> usize {
        let width = self.len();
        if width == 1 {
            want
        } else {
            want - want % width
        }
    }
}

// ==================== 编码目录 ====================

/// 编码在模态框里的分组（展示名由前端本地化，这里只给稳定的分组键）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Group {
    Unicode,
    Chinese,
    Japanese,
    Korean,
    Western,
}

impl Group {
    /// 分组键（写进 IPC；前端的文案表按键取名）。
    pub const fn id(self) -> &'static str {
        match self {
            Group::Unicode => "unicode",
            Group::Chinese => "chinese",
            Group::Japanese => "japanese",
            Group::Korean => "korean",
            Group::Western => "western",
        }
    }
}

/// 目录表里的一种编码。
///
/// 全部字段都是 `'static`：目录本身是一张常量表，`&'static EncodingDef` 可以
/// 自由地在线程间传递、存进会话（不需要 Arc），解码时零查找开销。
#[derive(Debug, Clone, Copy)]
pub struct EncodingDef {
    /// 稳定 id（IPC 与存档里用；改动等于破坏兼容）。
    pub id: &'static str,
    /// 展示名（技术名词，中英文一致，不做本地化）。
    pub name: &'static str,
    /// 补充说明（别名 / 代码页），无则为空串。
    pub note: &'static str,
    /// 分组。
    pub group: Group,
    /// encoding_rs 的编码句柄。
    pub enc: &'static Encoding,
    /// 换行符形态。
    pub term: LineTerm,
    /// 该编码的 BOM（解码时剥掉；空 = 无 BOM）。
    pub bom: &'static [u8],
}

/// 可选编码目录（模态框列表的唯一事实来源）。
///
/// 收录标准：中文 Windows 上「真的有文件是这么写出来的」的编码。
/// 刻意不收的东西：
/// - UTF-32（encoding_rs 不支持，日志里也见不到）；
/// - 各类 EUC/ISO 冷门变体（-8859-2/3/…）：列出来只会把列表撑长，
///   真要用的用户可以提需求，届时加一行即可。
pub const CATALOG: &[EncodingDef] = &[
    // ---- Unicode ----
    EncodingDef {
        id: "utf-8",
        name: "UTF-8",
        note: "Unicode",
        group: Group::Unicode,
        enc: UTF_8,
        term: LineTerm::Lf,
        bom: b"\xEF\xBB\xBF",
    },
    EncodingDef {
        id: "utf-16le",
        name: "UTF-16 LE",
        note: "Unicode",
        group: Group::Unicode,
        enc: UTF_16LE,
        term: LineTerm::Lf16Le,
        bom: b"\xFF\xFE",
    },
    EncodingDef {
        id: "utf-16be",
        name: "UTF-16 BE",
        note: "Unicode",
        group: Group::Unicode,
        enc: UTF_16BE,
        term: LineTerm::Lf16Be,
        bom: b"\xFE\xFF",
    },
    // ---- 中文 ----
    EncodingDef {
        id: "gb18030",
        name: "GB18030",
        note: "GBK / GB2312",
        group: Group::Chinese,
        enc: GB18030,
        term: LineTerm::Lf,
        bom: b"",
    },
    EncodingDef {
        id: "gbk",
        name: "GBK",
        note: "ANSI 936",
        group: Group::Chinese,
        enc: GBK,
        term: LineTerm::Lf,
        bom: b"",
    },
    EncodingDef {
        id: "big5",
        name: "Big5",
        note: "ANSI 950",
        group: Group::Chinese,
        enc: BIG5,
        term: LineTerm::Lf,
        bom: b"",
    },
    // ---- 日文 ----
    EncodingDef {
        id: "shift_jis",
        name: "Shift_JIS",
        note: "ANSI 932",
        group: Group::Japanese,
        enc: SHIFT_JIS,
        term: LineTerm::Lf,
        bom: b"",
    },
    EncodingDef {
        id: "euc-jp",
        name: "EUC-JP",
        note: "",
        group: Group::Japanese,
        enc: EUC_JP,
        term: LineTerm::Lf,
        bom: b"",
    },
    // ---- 韩文 ----
    EncodingDef {
        id: "euc-kr",
        name: "EUC-KR",
        note: "ANSI 949",
        group: Group::Korean,
        enc: EUC_KR,
        term: LineTerm::Lf,
        bom: b"",
    },
    // ---- 西文 ----
    // 刻意没有单独的 ISO-8859-1 条目：WHATWG Encoding 标准里 `iso-8859-1` 只是
    // Windows-1252 的一个**标签**（两者在 0x80–0x9F 区间的映射不同，标准统一按
    // Windows-1252 处理）。列成两项会让用户以为它们不同，实际上解码结果一样。
    EncodingDef {
        id: "windows-1252",
        name: "Windows-1252",
        note: "ANSI 1252 / Latin-1",
        group: Group::Western,
        enc: WINDOWS_1252,
        term: LineTerm::Lf,
        bom: b"",
    },
    EncodingDef {
        id: "windows-1251",
        name: "Windows-1251",
        note: "ANSI 1251",
        group: Group::Western,
        enc: WINDOWS_1251,
        term: LineTerm::Lf,
        bom: b"",
    },
    EncodingDef {
        id: "windows-1250",
        name: "Windows-1250",
        note: "ANSI 1250",
        group: Group::Western,
        enc: WINDOWS_1250,
        term: LineTerm::Lf,
        bom: b"",
    },
];

/// 兜底的编码定义（[`FALLBACK_ID`] 一定在目录里；查不到时退回目录首项，
/// 保证 [`lookup`] 的返回值永不为 None）。
pub fn fallback() -> &'static EncodingDef {
    lookup(FALLBACK_ID).unwrap_or(&CATALOG[0])
}

/// UTF-8 的编码定义：测试与「明确按 UTF-8 打开」的调用点用。
pub fn utf8() -> &'static EncodingDef {
    lookup("utf-8").expect("目录恒定含 utf-8")
}

/// 别名 → 目录 id。用户/存档里出现的写法五花八门（`cp936`、`936`、`utf8`…），
/// 归一化后只认目录 id，避免在会话里存下无法解析的字符串。
const ALIASES: &[(&str, &str)] = &[
    ("utf8", "utf-8"),
    ("utf-8-bom", "utf-8"),
    ("utf8-bom", "utf-8"),
    ("unicode", "utf-16le"),
    ("utf16", "utf-16le"),
    ("utf-16", "utf-16le"),
    ("utf-16-le", "utf-16le"),
    ("utf16le", "utf-16le"),
    ("utf-16-be", "utf-16be"),
    ("utf16be", "utf-16be"),
    ("ansi", FALLBACK_ID),
    ("gb2312", "gbk"),
    ("gb-2312", "gbk"),
    ("cp936", "gbk"),
    ("936", "gbk"),
    ("cp950", "big5"),
    ("950", "big5"),
    ("cp932", "shift_jis"),
    ("932", "shift_jis"),
    ("sjis", "shift_jis"),
    ("cp949", "euc-kr"),
    ("949", "euc-kr"),
    ("cp1252", "windows-1252"),
    ("1252", "windows-1252"),
    // WHATWG 把 ISO-8859-1 当作 Windows-1252 的标签，归一化到同一项。
    ("latin1", "windows-1252"),
    ("latin-1", "windows-1252"),
    ("iso-8859-1", "windows-1252"),
    ("8859-1", "windows-1252"),
    ("cp1251", "windows-1251"),
    ("1251", "windows-1251"),
    ("cp1250", "windows-1250"),
    ("1250", "windows-1250"),
];

/// 把 id / 别名归一化成目录 id；无法识别返回 None。
pub fn normalize_id(id: &str) -> Option<&'static str> {
    let raw = id.trim().to_ascii_lowercase();
    if raw.is_empty() {
        return None;
    }
    // 先按原样匹配目录 id（`shift_jis` 这类带下划线的 id 必须原样才认得），
    // 再试「下划线换成短横」的写法（`utf_16_le`），最后查别名表。
    if let Some(def) = CATALOG.iter().find(|d| d.id == raw) {
        return Some(def.id);
    }
    let key = raw.replace('_', "-");
    if let Some(def) = CATALOG.iter().find(|d| d.id == key) {
        return Some(def.id);
    }
    ALIASES
        .iter()
        .find(|(alias, _)| *alias == key || *alias == raw)
        .and_then(|(_, target)| CATALOG.iter().find(|d| d.id == *target))
        .map(|d| d.id)
}

/// 按 id 查目录项（接受别名；无法识别返回 None）。
pub fn lookup(id: &str) -> Option<&'static EncodingDef> {
    let id = normalize_id(id)?;
    CATALOG.iter().find(|d| d.id == id)
}

// ==================== 探测 ====================

/// 编码是怎么定下来的 —— 决定状态栏上那句「自动检测」的可信度提示。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// 文件开头有 BOM（最可靠）。
    Bom,
    /// 无 BOM，但采样区是合法 UTF-8。
    Utf8,
    /// 判不出来，用了 [`FALLBACK_ID`]。
    Fallback,
    /// 用户在状态栏里手动指定的。
    Manual,
}

impl Source {
    /// 写进 IPC 的字符串。
    pub const fn id(self) -> &'static str {
        match self {
            Source::Bom => "bom",
            Source::Utf8 => "utf8",
            Source::Fallback => "fallback",
            Source::Manual => "manual",
        }
    }
}

/// 传给前端的编码信息：状态栏的显示文本 + 模态框的当前项。
///
/// 为什么把「展示名 / 别名 / 分组」一起回给前端而不是让前端自己查表：目录表的
/// 唯一事实来源在后端（解码必须按它来），前端再抄一份就有两处会漂移 ——
/// 后端加了编码而前端忘了同步，用户就在下拉里看不到它。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodingInfo {
    /// 用户的**选择**：`auto` 或目录 id（状态栏的标题里要点明「自动」与否）。
    pub choice: String,
    /// 实际生效的目录 id。
    pub id: String,
    /// 展示名（技术名词，不做本地化）。
    pub name: String,
    /// 别名补充（如 `GBK / GB2312`），无则为空串。
    pub note: String,
    /// 分组键（前端本地化分组标题）。
    pub group: String,
    /// 探测依据（前端据此给出「自动检测 / 手动指定」的说明）。
    pub source: String,
    /// 文件是否带 BOM。
    pub bom: bool,
}

/// 由「用户选择 + 解析结果」组装 IPC 载荷。
pub fn info(choice: &str, resolved: Resolved) -> EncodingInfo {
    EncodingInfo {
        choice: choice.trim().to_string(),
        id: resolved.def.id.to_string(),
        name: resolved.def.name.to_string(),
        note: resolved.def.note.to_string(),
        group: resolved.def.group.id().to_string(),
        source: resolved.source.id().to_string(),
        bom: resolved.bom,
    }
}

/// 目录项（`list_encodings` 命令的返回元素）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodingOption {
    pub id: &'static str,
    pub name: &'static str,
    pub note: &'static str,
    pub group: &'static str,
}

/// 目录表 → IPC 载荷。
pub fn options() -> Vec<EncodingOption> {
    CATALOG
        .iter()
        .map(|d| EncodingOption {
            id: d.id,
            name: d.name,
            note: d.note,
            group: d.group.id(),
        })
        .collect()
}

/// 一次探测的结果。
#[derive(Debug, Clone, Copy)]
pub struct Detected {
    pub def: &'static EncodingDef,
    pub source: Source,
    /// 文件是否真的带 BOM（`source == Bom` 时为 true）。
    pub bom: bool,
}

/// 从一个头部采样判定编码（纯函数，可单测）。
///
/// 判定顺序即可信度顺序：BOM → UTF-8 合法性 → 兜底。
pub fn detect_sample(sample: &[u8]) -> Detected {
    // 1) BOM。UTF-16 的 BOM 优先判定：`FF FE` 是 UTF-16LE 的 BOM，也同时是
    //    UTF-32LE BOM 的前两字节，本项目不支持 UTF-32，按 UTF-16LE 处理。
    if sample.starts_with(b"\xEF\xBB\xBF") {
        return Detected {
            def: lookup("utf-8").expect("目录恒定含 utf-8"),
            source: Source::Bom,
            bom: true,
        };
    }
    if sample.starts_with(b"\xFF\xFE") {
        return Detected {
            def: lookup("utf-16le").expect("目录恒定含 utf-16le"),
            source: Source::Bom,
            bom: true,
        };
    }
    if sample.starts_with(b"\xFE\xFF") {
        return Detected {
            def: lookup("utf-16be").expect("目录恒定含 utf-16be"),
            source: Source::Bom,
            bom: true,
        };
    }

    // 2) 合法 UTF-8。采样边界可能把一个多字节字符切成两半，因此末尾最多 3 个
    //    字节允许「不完整」（`error_len() == None` 表示只是没读全，不是非法字节）。
    if is_utf8_prefix(sample) {
        return Detected {
            def: lookup("utf-8").expect("目录恒定含 utf-8"),
            source: Source::Utf8,
            bom: false,
        };
    }

    // 3) 兜底。注意纯 ASCII 的文件在上一步已经判成 UTF-8 —— 对 ASCII 而言
    //    UTF-8 与任何 ASCII 兼容编码等价，这个选择是对的。
    Detected {
        def: fallback(),
        source: Source::Fallback,
        bom: false,
    }
}

/// 采样区是否是「合法 UTF-8 的前缀」（末尾允许有不完整的字符）。
///
/// `Utf8Error::error_len()` 为 `None` 表示「输入恰好在一个字符中间结束」——
/// 那是采样边界截断，不是非法字节，必须放行，否则把一个合法的 UTF-8 中文文件
/// 判成 GBK 就发生在「第 64 KiB 正好切在某个汉字中间」这种偶然上。
/// 它是 `Some` 则说明真的出现了非法字节序列，直接否决。
fn is_utf8_prefix(sample: &[u8]) -> bool {
    match std::str::from_utf8(sample) {
        Ok(_) => true,
        Err(e) => e.error_len().is_none(),
    }
}

/// 读文件头部采样并判定编码。
///
/// 读失败（文件不存在 / 无权限）不在这里报错：调用方（打开流程）随后会用
/// 同一个路径去开真正的文件，那里才是报错的正确位置。这里失败就按兜底编码走。
pub fn detect_file(path: &Path) -> Detected {
    match read_sample(path) {
        Ok(sample) => detect_sample(&sample),
        Err(_) => Detected {
            def: fallback(),
            source: Source::Fallback,
            bom: false,
        },
    }
}

/// 读文件头部 [`SAMPLE_BYTES`] 个字节（文件更短则读全部）。
fn read_sample(path: &Path) -> std::io::Result<Vec<u8>> {
    let mut file = std::fs::File::open(path)?;
    let mut buf = Vec::new();
    file.by_ref().take(SAMPLE_BYTES).read_to_end(&mut buf)?;
    Ok(buf)
}

// ==================== 会话级「已解析编码」 ====================

/// 一个 tab 当前生效的编码：用户的**选择**（`choice`，可为 `auto`）+ 实际**解析结果**。
///
/// 两者都要留着：状态栏要显示「自动（GB18030）」这类信息，而重新打开文件时
/// 要沿用用户的原始选择（`auto` 要继续自动探测，不能固化成上次探测到的具体编码）。
#[derive(Debug, Clone, Copy)]
pub struct Resolved {
    pub def: &'static EncodingDef,
    pub source: Source,
    pub bom: bool,
}

/// 解析用户选择：`auto`/空 → 探测文件；具体 id → 直接用（`source = manual`）。
///
/// 无法识别的 id 按 `auto` 处理而不是报错：编码是「显示层」的东西，一个存档里
/// 的陈旧/拼错的 id 不该让文件打不开。
pub fn resolve(path: &Path, choice: &str) -> Resolved {
    let trimmed = choice.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case(AUTO) {
        let d = detect_file(path);
        return Resolved {
            def: d.def,
            source: d.source,
            bom: d.bom,
        };
    }
    match lookup(trimmed) {
        Some(def) => Resolved {
            def,
            source: Source::Manual,
            bom: file_has_bom(path, def.bom),
        },
        None => {
            let d = detect_file(path);
            Resolved {
                def: d.def,
                source: d.source,
                bom: d.bom,
            }
        }
    }
}

/// 文件是否以 `bom` 开头（`bom` 为空 → 恒 false）。
fn file_has_bom(path: &Path, bom: &[u8]) -> bool {
    if bom.is_empty() {
        return false;
    }
    match read_sample(path) {
        Ok(s) => s.starts_with(bom),
        Err(_) => false,
    }
}

// ==================== 解码 ====================

/// 剥掉行首的 BOM（只对「文件第一行」有意义，见 [`split_complete`]）。
pub fn strip_bom<'a>(raw: &'a [u8], def: &EncodingDef) -> &'a [u8] {
    if def.bom.is_empty() {
        raw
    } else {
        raw.strip_prefix(def.bom).unwrap_or(raw)
    }
}

/// 把一行的原始字节解码为文本（不含换行符；非法字节替换为 U+FFFD，不 panic）。
///
/// 用 `decode_without_bom_handling` 而不是 `decode`：BOM 的剥离由调用方在
/// 「确实是文件第一行」时用 [`strip_bom`] 做，这里不再猜一次 —— 否则中间某个
/// 以 U+FEFF 开头的行会被悄悄吃掉一个零宽字符。
pub fn decode_line(raw: &[u8], def: &EncodingDef) -> String {
    def.enc.decode_without_bom_handling(raw).0.into_owned()
}

/// 整段文本解码（Markdown 整读用）：同样不做 BOM 猜测。
pub fn decode_all<'a>(raw: &'a [u8], def: &EncodingDef) -> Cow<'a, str> {
    def.enc.decode_without_bom_handling(raw).0
}

// ==================== 行切分 ====================

/// 把一段原始字节切成**完整行**（以换行符结尾的那些），返回 (行文本, 末尾残片)。
///
/// - `base`：`buf` 首字节在文件中的绝对偏移。两个用途：UTF-16 的换行对齐判定
///   （见 [`LineTerm::matches_at`]）与「首行剥 BOM」（只有 `base == 0` 处才可能是
///   文件真正的开头）。
/// - 行尾的 `\r`（CRLF）在这里剥掉：与前端上一次收到的行文本口径一致
///   （行尾不带 `\r`），此前的实现也是这么做的。
/// - 末尾不以换行符结束的残片原样返回，由调用方跨批次拼接（tail 的 `pending`）。
pub fn split_complete(
    buf: &[u8],
    base: u64,
    def: &EncodingDef,
) -> (Vec<String>, Vec<u8>) {
    let term = def.term;
    let mut lines = Vec::new();
    let mut start = 0usize;
    while let Some(pos) = term.find(buf, base, start) {
        // 行字节 = [start, pos)，去掉行尾 CR。
        let mut line = &buf[start..pos];
        if line.ends_with(term.cr_bytes()) {
            line = &line[..line.len() - term.cr_bytes().len()];
        }
        // 只有文件的第一个字节处才剥 BOM。
        if base + start as u64 == 0 {
            line = strip_bom(line, def);
        }
        lines.push(decode_line(line, def));
        start = pos + term.len();
    }
    (lines, buf[start..].to_vec())
}

/// 同 [`split_complete`]，但末尾残片也作为一行返回。
///
/// 用于「按行区间读窗口」：窗口终点是文件 EOF 且末行没有换行时，这一行不能丢。
///
/// 末尾那一行的 BOM 判据是 `base == 0 && leftover.len() == buf.len()` —— 残片就是
/// 整段缓冲（即它从 `base` 开始，而 `base == 0` 就是文件开头）。**不能只判
/// `base == 0`**：按行区间读窗口时 base 也可能是 0，但那时前面几行已经切走了，
/// 残片其实从文件中间开始；把恰好以 U+FEFF 开头的正文（UTF-16LE 下正是 BOM 的
/// 字节 `FF FE`）当成 BOM 吃掉，同一行会随「文件末尾有没有换行」显示成两种样子。
pub fn split_inclusive(buf: &[u8], base: u64, def: &EncodingDef) -> Vec<String> {
    let (mut lines, leftover) = split_complete(buf, base, def);
    if !leftover.is_empty() {
        let mut line = &leftover[..];
        if line.ends_with(def.term.cr_bytes()) {
            // 理论上不会发生（残片以换行符之外的内容结尾），保持对称处理。
            line = &line[..line.len() - def.term.cr_bytes().len()];
        }
        if base == 0 && leftover.len() == buf.len() {
            line = strip_bom(line, def);
        }
        lines.push(decode_line(line, def));
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn def_of(id: &str) -> &'static EncodingDef {
        lookup(id).unwrap_or_else(|| panic!("目录里应有 {id}"))
    }

    /// 按编码把文本编成字节，**不带 BOM**。
    ///
    /// 两处坑都在测试输入这一侧：
    /// - `Encoding::encode` 的规格行为是给 UTF-16 系列补 BOM，这里统一剥掉；
    /// - encoding_rs **只支持解码 UTF-16**：它的 `output_encoding()` 对
    ///   UTF-16LE/BE 返回 UTF-8，`encode` 于是原样吐出 UTF-8 字节。所以 UTF-16
    ///   的输入必须自己拼字节（生产代码只解码，不受影响）。
    fn encode(text: &str, def: &EncodingDef) -> Vec<u8> {
        match def.term {
            LineTerm::Lf16Le => return encode_utf16(text, true),
            LineTerm::Lf16Be => return encode_utf16(text, false),
            LineTerm::Lf => {}
        }
        let bytes = def.enc.encode(text).0.into_owned();
        let bom = def.bom;
        if !bom.is_empty() && bytes.starts_with(bom) {
            bytes[bom.len()..].to_vec()
        } else {
            bytes
        }
    }

    /// 手工拼 UTF-16 字节（子节序由 `le` 决定，不含 BOM）。
    fn encode_utf16(text: &str, le: bool) -> Vec<u8> {
        let mut out = Vec::with_capacity(text.len() * 2);
        for unit in text.encode_utf16() {
            let pair = if le {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            };
            out.extend_from_slice(&pair);
        }
        out
    }

    /// 目录自身的完整性：id 唯一、可反查、兜底 id 在目录里。
    #[test]
    fn catalog_is_self_consistent() {
        let mut ids: Vec<&str> = CATALOG.iter().map(|d| d.id).collect();
        let n = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), n, "目录存在重复 id");

        for d in CATALOG {
            assert_eq!(
                lookup(d.id).map(|x| x.id),
                Some(d.id),
                "id {} 应能按自身反查",
                d.id
            );
            assert!(!d.name.is_empty(), "id {} 缺展示名", d.id);
        }
        assert!(lookup(FALLBACK_ID).is_some(), "兜底 id 必须在目录中");
    }

    /// 别名归一化。
    #[test]
    fn aliases_normalize_to_catalog_ids() {
        assert_eq!(normalize_id("UTF8"), Some("utf-8"));
        assert_eq!(normalize_id("  utf-8  "), Some("utf-8"));
        assert_eq!(normalize_id("cp936"), Some("gbk"));
        assert_eq!(normalize_id("936"), Some("gbk"));
        assert_eq!(normalize_id("GB2312"), Some("gbk"));
        assert_eq!(normalize_id("ansi"), Some(FALLBACK_ID));
        assert_eq!(normalize_id("utf_16_le"), Some("utf-16le"));
        assert_eq!(normalize_id("shift_jis"), Some("shift_jis"));
        // WHATWG 里 iso-8859-1 是 Windows-1252 的标签，两者归一化成同一项。
        assert_eq!(normalize_id("latin1"), Some("windows-1252"));
        assert_eq!(normalize_id("iso-8859-1"), Some("windows-1252"));
        assert_eq!(normalize_id("klingon-9"), None);
        assert_eq!(normalize_id(""), None);
    }

    // ---------- 探测 ----------

    #[test]
    fn detects_utf8_bom() {
        let d = detect_sample(b"\xEF\xBB\xBFhello");
        assert_eq!(d.def.id, "utf-8");
        assert_eq!(d.source, Source::Bom);
        assert!(d.bom);
    }

    #[test]
    fn detects_utf16_boms() {
        let le = detect_sample(b"\xFF\xFEh\x00i\x00");
        assert_eq!(le.def.id, "utf-16le");
        assert_eq!(le.source, Source::Bom);

        let be = detect_sample(b"\xFE\xFF\x00h\x00i");
        assert_eq!(be.def.id, "utf-16be");
        assert_eq!(be.source, Source::Bom);
    }

    #[test]
    fn detects_plain_utf8() {
        let d = detect_sample("日志：你好\n".as_bytes());
        assert_eq!(d.def.id, "utf-8");
        assert_eq!(d.source, Source::Utf8);
        assert!(!d.bom);
    }

    /// 纯 ASCII 归为 UTF-8（对 ASCII 而言各 ASCII 兼容编码等价）。
    #[test]
    fn plain_ascii_is_utf8() {
        let d = detect_sample(b"[INFO] 2026-01-01 boot ok\n");
        assert_eq!(d.def.id, "utf-8");
        assert_eq!(d.source, Source::Utf8);
    }

    /// GBK 编码的中文不是合法 UTF-8 → 落到兜底编码。
    #[test]
    fn gbk_chinese_falls_back() {
        let bytes = encode("中文日志", def_of("gbk"));
        assert!(!is_utf8_prefix(&bytes), "GBK 中文不应是合法 UTF-8");
        let d = detect_sample(&bytes);
        assert_eq!(d.def.id, FALLBACK_ID);
        assert_eq!(d.source, Source::Fallback);
    }

    /// 采样边界把多字节字符切成两半时不能误判为「非法 UTF-8」。
    #[test]
    fn truncated_multibyte_tail_is_still_utf8() {
        let text = "日志";
        let bytes = text.as_bytes();
        for cut in 1..bytes.len() {
            assert!(
                is_utf8_prefix(&bytes[..cut]),
                "截断到 {cut} 字节应仍判为合法 UTF-8 前缀"
            );
        }
    }

    /// 真正的非法字节（不是截断）必须被否决。
    #[test]
    fn invalid_bytes_are_not_utf8() {
        assert!(!is_utf8_prefix(b"ab\xFF\xFEcd"));
        assert!(!is_utf8_prefix(b"\xC3\x28")); // 非法续字节
    }

    #[test]
    fn empty_sample_is_utf8() {
        let d = detect_sample(b"");
        assert_eq!(d.def.id, "utf-8");
        assert_eq!(d.source, Source::Utf8);
    }

    // ---------- 行切分 ----------

    fn utf8() -> &'static EncodingDef {
        def_of("utf-8")
    }

    #[test]
    fn splits_lf_lines_and_strips_crlf() {
        let (lines, rest) = split_complete(b"a\r\nb\nc", 0, utf8());
        assert_eq!(lines, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(rest, b"c");
    }

    #[test]
    fn strips_utf8_bom_from_first_line_only() {
        let buf = b"\xEF\xBB\xBFhead\nbody\n";
        let (lines, _) = split_complete(buf, 0, utf8());
        assert_eq!(lines, vec!["head".to_string(), "body".to_string()]);
    }

    /// 非文件开头（base > 0）处即使出现同样字节也不剥 —— 那是正文里的零宽字符。
    #[test]
    fn does_not_strip_bom_away_from_file_start() {
        let buf = b"\xEF\xBB\xBFhead\n";
        let (lines, _) = split_complete(buf, 1024, utf8());
        assert_eq!(lines, vec!["\u{FEFF}head".to_string()]);
    }

    #[test]
    fn decodes_gbk_lines() {
        let bytes = encode("中文\r\n日志\n", def_of("gbk"));
        let (lines, _) = split_complete(&bytes, 0, def_of("gbk"));
        assert_eq!(lines, vec!["中文".to_string(), "日志".to_string()]);
    }

    /// 非法字节 lossy 替换，不 panic（与 UTF-8 时代的契约一致）。
    #[test]
    fn invalid_bytes_decode_lossily() {
        let (lines, _) = split_complete(b"a\xFF\xFEb\n", 0, utf8());
        assert!(lines[0].starts_with('a'));
        assert!(lines[0].contains('\u{FFFD}'));
    }

    /// UTF-16LE：换行是 2 字节，且要把行尾的 CR 也按 2 字节剥掉。
    #[test]
    fn splits_utf16le_lines() {
        let def = def_of("utf-16le");
        let bytes = encode("第一行\r\n第二行\n第三行", def);
        let (lines, rest) = split_complete(&bytes, 0, def);
        assert_eq!(lines, vec!["第一行".to_string(), "第二行".to_string()]);
        assert_eq!(decode_line(&rest, def), "第三行", "末尾残片应能独立解码");
    }

    /// 带 BOM 的 UTF-16LE：首行要剥掉 BOM，其余行不受影响。
    #[test]
    fn strips_utf16le_bom_from_first_line() {
        let def = def_of("utf-16le");
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend_from_slice(&encode("hi\nyo\n", def));
        let (lines, _) = split_complete(&bytes, 0, def);
        assert_eq!(lines, vec!["hi".to_string(), "yo".to_string()]);
    }

    #[test]
    fn splits_utf16be_lines() {
        let def = def_of("utf-16be");
        let bytes = encode("alpha\r\nbeta\n", def);
        let (lines, rest) = split_complete(&bytes, 0, def);
        assert_eq!(lines, vec!["alpha".to_string(), "beta".to_string()]);
        assert!(rest.is_empty());
    }

    /// 换行检测必须按宽度对齐：`05 0A 00 0B`（U+0A05 U+0B00 的 UTF-16LE 字节）
    /// 在偏移 1 处与 `0A 00` 撞出一个**假**换行，对齐判定要否决它。
    #[test]
    fn utf16_terminator_matching_is_aligned() {
        let bytes = encode("\u{0A05}\u{0B00}", def_of("utf-16le"));
        assert_eq!(bytes, vec![0x05, 0x0A, 0x00, 0x0B]);
        assert_eq!(
            LineTerm::Lf16Le.count(&bytes, 0),
            0,
            "错位处不应被当成换行"
        );
        // 去掉对齐限制就会数出 1 个假换行 —— 这条断言钉住「为什么需要对齐」。
        assert_eq!(bytes.windows(2).filter(|w| *w == b"\n\0").count(), 1);
    }

    /// 被切成两半的 UTF-16 换行（chunk 边界）不能算完整换行。
    #[test]
    fn partial_utf16_terminator_at_tail_is_not_a_terminator() {
        let buf = [0x41u8, 0x00, 0x0A]; // "A" + 换行符的前一字节
        assert!(!LineTerm::Lf16Le.ends_with(&buf, 0));
        let (lines, rest) = split_complete(&buf, 0, def_of("utf-16le"));
        assert!(lines.is_empty(), "换行没读全时不应产出完整行");
        assert_eq!(rest, vec![0x41, 0x00, 0x0A], "残片应原样留待下一批");
    }

    /// 跨批次拼接：换行的后半字节到齐后才成行。
    #[test]
    fn utf16_line_completes_after_terminator_tail_arrives() {
        let mut pending = vec![0x41u8, 0x00, 0x0A];
        let mut next = vec![0x00u8, 0x42, 0x00];
        pending.append(&mut next);
        let (lines, rest) = split_complete(&pending, 0, def_of("utf-16le"));
        assert_eq!(lines, vec!["A".to_string()]);
        assert_eq!(rest, vec![0x42, 0x00]);
        assert_eq!(LineTerm::Lf16Le.count(&pending, 0), 1);
    }

    #[test]
    fn split_inclusive_keeps_trailing_unterminated_line() {
        let lines = split_inclusive(b"a\nb", 0, utf8());
        assert_eq!(lines, vec!["a".to_string(), "b".to_string()]);

        let lines = split_inclusive(b"a\nb\n", 0, utf8());
        assert_eq!(lines, vec!["a".to_string(), "b".to_string()]);
    }

    /// 末尾残片只有在**它自己就从文件第 0 字节开始**时才算「首行」，才剥 BOM。
    ///
    /// 反例（曾经的行为）：`base == 0` 就剥 —— 按行区间读窗口时 base 也可能是 0，
    /// 但那时前面几行已经切走了，残片其实从文件中间开始。恰好以 U+FEFF 开头的正文
    /// （UTF-16LE 下正是 BOM 的两个字节 `FF FE`）会被吃掉，同一行随「文件末尾有
    /// 没有换行」显示成两种样子。
    #[test]
    fn split_inclusive_strips_bom_only_when_the_leftover_is_the_whole_file() {
        // 单行 + BOM，无换行结尾 → 残片就是整段缓冲 → 剥。
        let lines = split_inclusive(b"\xEF\xBB\xBFonly", 0, utf8());
        assert_eq!(lines, vec!["only".to_string()]);

        // 前面还有一行 —— 残片不是整段缓冲，那个 U+FEFF 是正文内容，必须保留。
        let lines = split_inclusive(b"first\n\xEF\xBB\xBFsecond", 0, utf8());
        assert_eq!(lines, vec!["first".to_string(), "\u{FEFF}second".to_string()]);

        // 与「末尾有换行」时的口径一致（那次走的不是残片分支）。
        let lines = split_inclusive(b"first\n\xEF\xBB\xBFsecond\n", 0, utf8());
        assert_eq!(lines, vec!["first".to_string(), "\u{FEFF}second".to_string()]);
    }

    /// 计数与切分必须给出同一个答案（索引与读取走的是两条代码路径）。
    #[test]
    fn terminator_count_agrees_with_actual_splits() {
        for (id, text) in [
            ("utf-8", "a\nb\r\nc\n"),
            ("gbk", "中\n文\n"),
            ("utf-16le", "a\nb\r\n"),
            ("utf-16be", "x\ny\n"),
        ] {
            let def = def_of(id);
            let bytes = encode(text, def);
            let (lines, rest) = split_complete(&bytes, 0, def);
            let expected = text.matches('\n').count();
            assert_eq!(lines.len(), expected, "{id}: 切分行数应等于换行数");
            assert_eq!(
                def.term.count(&bytes, 0) as usize,
                expected,
                "{id}: 换行计数应等于换行数"
            );
            assert!(rest.is_empty(), "{id}: 以换行结尾时不该有余留");
        }
    }

    /// `ends_with` 与切分口径一致：以换行结尾 ⇔ 没有余留残片。
    #[test]
    fn ends_with_matches_leftover_semantics() {
        for (id, text) in [("utf-8", "a\n"), ("utf-16le", "a\n"), ("utf-16le", "a")] {
            let def = def_of(id);
            let bytes = encode(text, def);
            let (_, rest) = split_complete(&bytes, 0, def);
            assert_eq!(
                def.term.ends_with(&bytes, 0),
                rest.is_empty(),
                "{id} 文本 {text:?}"
            );
        }
    }

    /// 非零 base 下的对齐：把同一段内容放在奇数偏移上，2 字节换行不该被匹配
    /// （真实文件里不会出现，但分块读取可能从奇数偏移续扫，判定必须自洽）。
    #[test]
    fn alignment_uses_absolute_offset() {
        let buf = [0x0Au8, 0x00];
        assert!(LineTerm::Lf16Le.matches_at(&buf, 0, 0));
        assert!(!LineTerm::Lf16Le.matches_at(&buf, 1, 0));
    }

    /// 块长对齐：返回值一定是换行符宽度的整数倍。
    ///
    /// 这是 [`LineTerm::align_chunk`] 的契约测试。端到端回归见
    /// `index::tests::utf16_scan_step_with_an_odd_budget_still_counts_every_line`
    /// （未对齐时 200 行会被数成 133 行）与
    /// `index::tests::utf16_odd_size_file_then_growth_keeps_every_line`
    /// （大小是奇数的文件增长后不许丢换行符）。
    #[test]
    fn chunk_length_is_aligned_to_the_terminator_width() {
        assert_eq!(LineTerm::Lf16Le.align_chunk(15), 14);
        assert_eq!(LineTerm::Lf16Le.align_chunk(16), 16);
        // 不足一个换行符宽度 → 0：调用方据此停止推进，把这点尾巴留给下一批字节。
        assert_eq!(LineTerm::Lf16Le.align_chunk(1), 0);
        assert_eq!(LineTerm::Lf16Le.align_chunk(0), 0);
        assert_eq!(LineTerm::Lf16Be.align_chunk(1023), 1022);
        assert_eq!(LineTerm::Lf16Be.align_chunk(3), 2);
        // 1 字节换行没有对齐问题，一位都不能少。
        assert_eq!(LineTerm::Lf.align_chunk(15), 15);
        assert_eq!(LineTerm::Lf.align_chunk(1), 1);
        assert_eq!(LineTerm::Lf.align_chunk(0), 0);
        // 契约：任何宽度下返回值都是宽度的整数倍（0 也算）。
        for term in [LineTerm::Lf, LineTerm::Lf16Le, LineTerm::Lf16Be] {
            for want in 0..40usize {
                assert_eq!(term.align_chunk(want) % term.len(), 0);
                assert!(term.align_chunk(want) <= want);
            }
        }
    }

    // ---------- resolve ----------

    fn temp_file(bytes: &[u8]) -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(bytes).unwrap();
        f.flush().unwrap();
        f
    }

    #[test]
    fn resolve_auto_detects() {
        let f = temp_file("你好\n".as_bytes());
        let r = resolve(f.path(), AUTO);
        assert_eq!(r.def.id, "utf-8");
        assert_eq!(r.source, Source::Utf8);
    }

    #[test]
    fn resolve_manual_uses_requested_encoding() {
        let bytes = encode("中文\n", def_of("gbk"));
        let f = temp_file(&bytes);
        let r = resolve(f.path(), "gbk");
        assert_eq!(r.def.id, "gbk");
        assert_eq!(r.source, Source::Manual);
        assert!(!r.bom);
    }

    /// 手动选了 UTF-8 而文件确实带 BOM 时，`bom` 标记要如实上报（状态栏显示用）。
    #[test]
    fn resolve_manual_reports_bom_presence() {
        let f = temp_file(b"\xEF\xBB\xBFhi\n");
        assert!(resolve(f.path(), "utf-8").bom);
        // 选的是别的编码：那 3 个字节就是普通内容，不算 BOM。
        assert!(!resolve(f.path(), "gbk").bom);
    }

    /// 无法识别的 id 退化为自动探测，而不是报错。
    #[test]
    fn resolve_unknown_id_falls_back_to_auto() {
        let f = temp_file("你好\n".as_bytes());
        let r = resolve(f.path(), "no-such-encoding");
        assert_eq!(r.def.id, "utf-8");
    }

    /// 文件读不到（不存在）时探测不报错，按兜底编码返回。
    #[test]
    fn detect_missing_file_uses_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let d = detect_file(&dir.path().join("nope.log"));
        assert_eq!(d.def.id, FALLBACK_ID);
        assert_eq!(d.source, Source::Fallback);
    }

    /// 大端序 BOM 不会被小端序判定抢走。
    #[test]
    fn utf16be_bom_is_not_confused_with_le() {
        let mut bytes = vec![0xFE, 0xFF];
        bytes.extend_from_slice(&encode("hi", def_of("utf-16be")));
        let d = detect_sample(&bytes);
        assert_eq!(d.def.id, "utf-16be");
    }

    /// IPC 载荷的 JSON 形状（前端读的是 camelCase）。
    #[test]
    fn info_serializes_with_camel_case_keys() {
        let r = Resolved {
            def: def_of("gbk"),
            source: Source::Manual,
            bom: false,
        };
        let json = serde_json::to_string(&info("gbk", r)).unwrap();
        assert_eq!(
            json,
            r#"{"choice":"gbk","id":"gbk","name":"GBK","note":"ANSI 936","group":"chinese","source":"manual","bom":false}"#
        );
    }

    /// 目录载荷与目录表一一对应（前端下拉的全部内容）。
    #[test]
    fn options_cover_catalog() {
        let opts = options();
        assert_eq!(opts.len(), CATALOG.len());
        assert!(opts.iter().all(|o| o.id != AUTO), "auto 不是目录项");
        assert!(opts.iter().any(|o| o.id == FALLBACK_ID));
    }
}
