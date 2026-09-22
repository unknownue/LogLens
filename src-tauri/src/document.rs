//! 文本文件整读：Markdown 预览视图的数据来源。
//!
//! 与 [`crate::tail`] 的流式读取不同，预览要整篇解析，只能一次性把内容交给前端；
//! 因此这里的核心职责是「读取」+「限流」：默认封顶 [`DEFAULT_MAX_BYTES`]，
//! 超大文件退化成截断预览，避免把内存打满 / 把 IPC 主线程卡死。
//!
//! 另外三件与预览配套的事：
//! - [`stat_text_file`]：只看 metadata（mtime + size），供前端轮询「文档是否被改动」；
//! - [`read_text_file`] 读取成功后的 asset 协议动态授权：让正文里引用的本地图片可加载；
//! - 按 `encoding` 参数解码（含自动探测）：Markdown 与日志视图用同一套编码支持，
//!   中文 GBK 写的说明文档一样能正常渲染。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use tauri::Manager;
use tracing::instrument;

/// 默认读取上限：4 MiB。
///
/// 为什么需要上限：Markdown 预览是把整篇文本喂给解析器（且跨 IPC 传整个字符串），
/// 若用户误选了一个几百 MB 的日志/dump 文件当 Markdown 打开，全量读入会让进程内存
/// 峰值飙升、主线程长时间忙于读取与反序列化。超过上限时退化为「截断预览」——
/// 内容不完整但界面可用，且 `truncated` 字段让前端能明确提示「仅预览前 N 字节」。
pub const DEFAULT_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// 整读文本文件的结果（供 Markdown 预览）。
#[derive(Debug, serde::Serialize)]
pub struct TextFilePayload {
    /// 文件内容：UTF-8 BOM 已剥离，非法字节按 lossy 替换。
    /// 截断时是文件前缀（末尾可能落在多字节字符中间，已替换为 U+FFFD）。
    pub text: String,
    /// 文件实际字节数（**完整文件**大小，不是读进来那一段），前端据此显示占比。
    pub bytes: u64,
    /// 是否因超过上限被截断（`text` 只是前 `cap` 个字节）。
    pub truncated: bool,
    /// 本篇文档实际按哪种编码解码（前端状态栏/编码弹窗显示）。
    pub encoding: crate::encoding::EncodingInfo,
}

/// 文件「最后修改时间 + 字节数」快照：前端判断「文档是否被改动」的唯一依据。
///
/// 为什么轮询 metadata 而不是用 `notify` 监听：编辑器保存普遍是「先写临时文件、
/// 再 rename 覆盖」，监听拿到的是临时文件的创建/删除事件，被 watch 的路径其 inode
/// 也随 rename 换掉；而轮询每轮只做一次 `metadata` 系统调用，既便宜又天然扛住
/// 这种原子替换（rename 后 mtime/size 一定变）。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFileStat {
    /// 文件最后修改时间（Unix 毫秒）；时间取不到时为 0，见 [`stat_text_file`]。
    pub mtime_ms: u64,
    /// 文件字节数。
    pub size: u64,
}

/// 读取文件的 mtime / size（前端每 ~1.5s 调一次，必须便宜：只做一次 metadata）。
///
/// 错误文案与 [`read_text_file`] 同一契约（前端 `classifyOpenError` 按文案分流）：
/// - 不是文件（不存在 / 是目录）→ `Err("文件不存在: <path>")`
/// - metadata 读取失败（无权限等）→ `Err("读取失败: <io error>")`
///
/// mtime 取不到时返回 0 而不是报错：文件 mtime 早于 UNIX_EPOCH（时钟回拨）或平台
/// 不支持该精度都会让 `duration_since` 失败，这种「时间未知」不该把轮询变成错误页
/// ——前端仍能靠 size 的变化判断需要重载。转换失败一律落回 0，绝不 panic。
#[instrument(fields(path = %path))]
#[tauri::command]
pub fn stat_text_file(path: String) -> Result<TextFileStat, String> {
    let path = PathBuf::from(path);
    require_file(&path)?;
    let meta = path.metadata().map_err(|e| format!("读取失败: {}", e))?;
    // modified() / duration_since 都可能失败；任何一环失败都只意味着「时间未知」。
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        // u128 毫秒 → u64：真实时间戳远小于 u64 上限，不可能截断。
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(TextFileStat {
        mtime_ms,
        size: meta.len(),
    })
}

/// 读取文本文件全文（Markdown 预览用）。
///
/// - `path` 不是文件（不存在 / 是目录）→ `Err("文件不存在: <path>")`
/// - 读取 IO 失败（无权限等）→ `Err("读取失败: <io error>")`
///
/// 错误文案是前后端契约：[`crate::open_log_file`] 同款前缀，前端
/// `src/views/body-view.ts::classifyOpenError` 依赖其中的「文件不存在」「os error N」
/// 特征串把失败分流到「文件不存在 / 无权限 / 其它」三种状态页，措辞不可随意改动。
///
/// `max_bytes` 为 `None` 时用 [`DEFAULT_MAX_BYTES`]。只读取前 `min(文件大小, 上限)`
/// 个字节（`Read::take` 限流，不把整个文件读进内存后再截断）。
///
/// `encoding` 是用户的编码选择：`None`/空/`"auto"` 走自动探测，否则是目录 id
/// （见 [`crate::encoding`]）。返回值里带上实际生效的编码，前端据此同步状态栏。
///
/// 读取成功后额外把**文档所在目录**动态加入 asset 协议 scope（理由见
/// [`authorize_document_dir`]），这样正文里引用的本地图片才能被 webview 加载。
/// `app` 只用于该授权，对前端不可见：前端仍按 `{ path, maxBytes, encoding }` 调用。
#[instrument(skip(app), fields(bytes = max_bytes.unwrap_or(DEFAULT_MAX_BYTES)))]
#[tauri::command]
pub fn read_text_file(
    app: tauri::AppHandle,
    path: String,
    max_bytes: Option<u64>,
    encoding: Option<String>,
) -> Result<TextFilePayload, String> {
    let path = PathBuf::from(path);
    // 先取正文：只有读成功了才谈得上「这篇文档要显示图片」。
    let choice = encoding.unwrap_or_default();
    let payload = read_text_file_impl(&path, max_bytes, &choice)?;
    authorize_document_dir(&app, &path);
    Ok(payload)
}

/// [`read_text_file`] 的实现体：只负责「读 + 限流 + 解码」，不依赖 Tauri runtime。
///
/// 为什么把实现从命令里抽出来：命令签名带 `tauri::AppHandle`，单元测试里既没有
/// 也无法构造 Tauri runtime，直接测命令就得先拉起整个应用；拆出 impl 后，测试打的
/// 是同一份真实逻辑，命令退化成「调 impl + 授权 scope」的薄壳。
fn read_text_file_impl(
    path: &Path,
    max_bytes: Option<u64>,
    encoding_choice: &str,
) -> Result<TextFilePayload, String> {
    require_file(path)?;
    let size = path
        .metadata()
        .map(|m| m.len())
        .map_err(|e| format!("读取失败: {}", e))?;

    // 编码在读取前解析：`auto` 要探测文件头部，具体 id 则直接用。
    let resolved = crate::encoding::resolve(path, encoding_choice);
    let def = resolved.def;
    let info = crate::encoding::info(encoding_choice, resolved);

    let cap = max_bytes.unwrap_or(DEFAULT_MAX_BYTES);
    // take 让 read_to_end 最多读 cap 字节：截断发生在 IO 层，超限部分根本不进内存。
    let limit = size.min(cap);
    let mut file = std::fs::File::open(path).map_err(|e| format!("读取失败: {}", e))?;
    let mut buf = Vec::new();
    file.by_ref()
        .take(limit)
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取失败: {}", e))?;

    // BOM 由编码层剥离（按所选编码的 BOM，不再只认 UTF-8）。
    // 截断点可能落在多字节字符中间：按编码 lossy 解码把不完整序列替换为 U+FFFD，绝不 panic。
    let text = crate::encoding::decode_all(crate::encoding::strip_bom(&buf, def), def).into_owned();

    Ok(TextFilePayload {
        text,
        bytes: size,
        truncated: size > cap,
        encoding: info,
    })
}

/// 「目标必须是一个真实文件」的公共前置检查。
///
/// 两个命令共用同一份文案契约（前端按文案分类，措辞只能有一处定义）。目录也能
/// `metadata()` 成功，必须先 `is_file()` 判定，否则会以「读取失败」报错，前端就会
/// 把「传了目录」显示成权限/IO 问题而非「文件不存在」。
///
/// `pub(crate)`：CSV 表格解析（`crate::csv_table`）与这里读同一批文件，
/// 错误文案必须逐字一致，不能各写一份。
pub(crate) fn require_file(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err(format!("文件不存在: {}", path.display()));
    }
    Ok(())
}

/// 把「文档所在目录」动态加入 asset 协议 scope，使 Markdown 里引用的本地图片
/// （含 `imgs/` 之类的子目录）能通过 asset 协议被 webview 加载。
///
/// 为什么是动态授权而不是静态 scope：静态 scope 只能写在 tauri.conf.json 里写死
/// 通配路径（如 `**/*.png`），等于对 webview 长期开放整块磁盘上的所有图片；动态
/// 授权只在用户真的打开某篇文档时才放行它所在的这一个目录，把可读面收敛到「用户
/// 实际打开过的文档目录」。静态 scope 留空 + 这里按需开洞，是这套收敛策略的两半。
///
/// 为什么只在读取成功后授权：失败路径（文件不存在 / 无权限）说明这篇文档根本没被
/// 打开，没有任何理由为它扩大可读面；授权必须挂在成功路径上（调用点见
/// [`read_text_file`]，`?` 之后）。
///
/// 授权失败不致命：最坏结果是该文档里的图片加载不出来（前端显示破图），正文本身
/// 仍然完整可用，所以这里只打日志、不把命令变成 Err（与仓库其它 `eprintln!` 一致）。
///
/// `recursive = true`：文档旁边的 `imgs/` 等子目录里的图片同样要能加载。
fn authorize_document_dir(app: &tauri::AppHandle, path: &Path) {
    // `parent()` 对「只有文件名」的路径返回空串，此时把文档所在目录理解为当前目录。
    let dir = match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir,
        _ => Path::new("."),
    };
    // asset_protocol_scope() 返回的是共享同一份内部状态的句柄，就地扩展即可生效。
    if let Err(e) = app.asset_protocol_scope().allow_directory(dir, true) {
        eprintln!(
            "[document] asset scope 授权失败（不影响正文读取）: {} → {e}",
            dir.display()
        );
    }
}

/// 剥掉开头的 BOM 由 [`crate::encoding::strip_bom`] 负责（按所选编码的 BOM，
/// 不再只认 UTF-8 —— GBK 文档里的 UTF-8 BOM 三个字节就是普通内容，不该被吃掉）。
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 写一个临时文件（内容为原始字节）并返回句柄；句柄需存活到测试结束
    /// （`NamedTempFile` drop 时删文件）。路径保证是合法 UTF-8。
    fn write_temp(bytes: &[u8]) -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(bytes).unwrap();
        f.flush().unwrap();
        f
    }

    fn temp_path(bytes: &[u8]) -> (String, tempfile::NamedTempFile) {
        let f = write_temp(bytes);
        let path = f.path().to_string_lossy().to_string();
        (path, f)
    }

    /// 直呼 [`read_text_file_impl`]：命令签名的 `tauri::AppHandle` 在单测里构造不出来
    /// （那需要一整个 Tauri runtime），所以读取类测试一律打 impl。命令与 impl 之间只有
    /// 「授权 asset scope」这一行差别，读取逻辑是同一份。
    ///
    /// 默认走自动探测（空选择），与前端不传 `encoding` 时的行为一致。
    fn read(path: &str, max_bytes: Option<u64>) -> Result<TextFilePayload, String> {
        read_text_file_impl(Path::new(path), max_bytes, "")
    }

    /// 指定编码读取。
    fn read_with(
        path: &str,
        max_bytes: Option<u64>,
        encoding: &str,
    ) -> Result<TextFilePayload, String> {
        read_text_file_impl(Path::new(path), max_bytes, encoding)
    }

    /// 按目录里的编码把文本编成字节（造测试输入用）。
    fn encode(text: &str, encoding_id: &str) -> Vec<u8> {
        let def = crate::encoding::lookup(encoding_id).expect("目录里应有该编码");
        def.enc.encode(text).0.into_owned()
    }

    /// 正常读取：中文按 UTF-8 解码，bytes 是真实字节数而非字符数。
    #[test]
    fn reads_utf8_text_with_chinese() {
        let content = "# 标题\n\n一段正文：你好，世界。\n";
        let (path, _f) = temp_path(content.as_bytes());

        let got = read(&path, None).unwrap();
        assert_eq!(got.text, content);
        assert_eq!(got.bytes, content.as_bytes().len() as u64);
        assert!(!got.truncated, "小于上限不应截断");
    }

    /// 带 BOM 的文件：BOM 必须剥掉，否则首行标题会被渲染成正文。
    #[test]
    fn strips_utf8_bom() {
        let mut content = vec![0xEF, 0xBB, 0xBF];
        content.extend_from_slice("# 标题\n正文\n".as_bytes());
        let (path, _f) = temp_path(&content);

        let got = read(&path, None).unwrap();
        assert_ne!(
            got.text.as_bytes().first(),
            Some(&0xEF),
            "返回文本不应以 BOM 开头"
        );
        assert!(
            got.text.starts_with("# 标题"),
            "首行应正常，实测 {:?}",
            got.text
        );
        assert_eq!(got.text, "# 标题\n正文\n");
        // bytes 是文件实际大小：BOM 计入文件本身，只是不进 text。
        assert_eq!(got.bytes, content.len() as u64);
        assert!(!got.truncated);
    }

    /// 截断（ASCII 边界）：只读前 cap 字节，truncated 为真，bytes 仍是完整文件大小。
    #[test]
    fn truncates_large_file_and_reports_full_size() {
        let content: String = (0..100).map(|i| format!("line-{i:03}\n")).collect();
        assert!(content.len() > 40);
        let (path, _f) = temp_path(content.as_bytes());

        let got = read(&path, Some(40)).unwrap();
        assert!(got.truncated, "超过上限应截断");
        assert_eq!(got.text.len(), 40);
        assert_eq!(got.text, content[..40]);
        assert_eq!(got.bytes, content.len() as u64, "bytes 应是完整文件大小");
    }

    /// 截断点落在多字节字符中间：不许 panic，不完整序列被 lossy 替换为 U+FFFD。
    /// 用 3 字节汉字精准落刀：cap=5 →「你」完整 + 2 字节残片。
    #[test]
    fn truncation_boundary_inside_multibyte_char_does_not_panic() {
        let content = "你好世界"; // 每个汉字 3 字节，共 12 字节

        // 最极端：cap=1 —— 缓冲只有第一个汉字的首字节，一个完整字符都凑不出，
        // 结果只能是单个替换字符（若实现依赖「尾部完整」假设就会在这里炸）。
        let (path, _f) = temp_path(content.as_bytes());
        let got = read(&path, Some(1)).unwrap();
        assert!(got.truncated);
        assert_eq!(got.text, "\u{FFFD}", "cap=1 应退化为单个替换字符");
        assert_eq!(got.bytes, content.len() as u64);

        // 其余上限都至少含一个完整汉字：完整前缀逐字节保留，末尾残片替换为 U+FFFD。
        for cap in [2u64, 4, 5, 7, 8, 11] {
            let (path, _f) = temp_path(content.as_bytes());
            let got = read(&path, Some(cap)).unwrap();
            assert!(got.truncated, "cap={cap} 应判为截断");
            assert!(
                got.text.contains('\u{FFFD}'),
                "cap={cap} 残片应被替换为 U+FFFD，实测 {:?}",
                got.text
            );
            // 残片只可能落在缓冲末尾，所以替换字符必是最后一个。
            assert!(
                got.text.ends_with('\u{FFFD}'),
                "cap={cap} 替换字符应在末尾，实测 {:?}",
                got.text
            );
            let prefix = &content.as_bytes()[..(cap as usize / 3) * 3];
            assert_eq!(
                got.text.as_bytes()[..prefix.len()],
                *prefix,
                "cap={cap} 完整前缀不应被改动"
            );
            assert_eq!(got.bytes, content.len() as u64);
        }
    }

    /// 非法 UTF-8 字节（非截断导致）：显式按 UTF-8 读时同样 lossy 替换，不 panic。
    #[test]
    fn invalid_utf8_bytes_are_replaced_lossily() {
        let (path, _f) = temp_path(&[b'a', 0xFF, 0xFE, b'b']);

        let got = read_with(&path, None, "utf-8").unwrap();
        assert!(!got.truncated);
        assert!(got.text.starts_with('a') && got.text.ends_with('b'));
        assert!(got.text.contains('\u{FFFD}'), "非法字节应替换为 U+FFFD");
    }

    /// 同一份文件走自动探测时不再按 UTF-8 硬解 —— 这正是编码支持的意义：
    /// 非法 UTF-8 的字节序列交给兜底编码（GB18030）去解，字节组合能配对就还原成
    /// 一个汉字，而不是一律 U+FFFD。这条用例钉住「自动探测确实换了编码」，
    /// 避免哪天又退回「一律 lossy UTF-8」。
    #[test]
    fn auto_detection_does_not_force_utf8_on_invalid_bytes() {
        let raw = [b'a', 0xFF, 0xFE, b'b'];
        let (path, _f) = temp_path(&raw);

        let got = read(&path, None).unwrap();
        assert_eq!(
            got.encoding.id,
            crate::encoding::FALLBACK_ID,
            "非法 UTF-8 应落到兜底编码，实测 {:?}",
            got.encoding.id
        );
        assert_eq!(got.encoding.source, "fallback");
        assert!(got.text.starts_with('a'), "ASCII 前缀应保持不变");

        // 与「一律按 UTF-8 lossy」的结果必须不同：否则说明编码参数根本没生效。
        let utf8_lossy = read_with(&path, None, "utf-8").unwrap();
        assert_ne!(
            got.text, utf8_lossy.text,
            "自动探测与显式 UTF-8 应给出不同的解码结果"
        );
        // 收尾的 'b'(0x62) 在 GB18030 里是前一个字节 0xFE 的尾字节，会被一并吃掉。
        assert!(!got.text.ends_with('\u{FFFD}'), "GB18030 能配对完整字节");
    }

    /// GBK 写的 Markdown：按 GBK 读能还原中文（`encoding` 参数与自动探测两条路都要通）。
    #[test]
    fn decodes_gbk_markdown() {
        let content = "# 标题\n\n正文：你好，世界。\n";
        let bytes = encode(content, "gbk");
        let (path, _f) = temp_path(&bytes);

        // 显式指定。
        let got = read_with(&path, None, "gbk").unwrap();
        assert_eq!(got.text, content);
        assert_eq!(got.encoding.id, "gbk");
        assert_eq!(got.encoding.source, "manual");

        // 自动探测：GBK 字节不是合法 UTF-8 → 落到兜底编码，中文同样正确。
        let auto = read(&path, None).unwrap();
        assert_eq!(auto.text, content);
        assert_eq!(auto.encoding.source, "fallback");
    }

    /// 别名（`cp936` / `936`）也要能选上，否则前端存档里存过一次就再也开不回来。
    #[test]
    fn encoding_aliases_are_accepted() {
        let bytes = encode("中文", "gbk");
        let (path, _f) = temp_path(&bytes);
        for alias in ["cp936", "936", "GBK", "gb2312"] {
            let got = read_with(&path, None, alias).unwrap();
            assert_eq!(got.text, "中文", "别名 {alias} 应解出正确文本");
            assert_eq!(got.encoding.id, "gbk", "别名 {alias} 应归一化到目录 id");
        }
    }

    /// UTF-16LE（PowerShell `Out-File` 的默认输出）带 BOM：整读要按 2 字节编码解码。
    #[test]
    fn decodes_utf16le_with_bom() {
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "# 标题\n正文\n".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let (path, _f) = temp_path(&bytes);

        let got = read(&path, None).unwrap();
        assert_eq!(got.text, "# 标题\n正文\n");
        assert_eq!(got.encoding.id, "utf-16le");
        assert_eq!(got.encoding.source, "bom");
        assert!(got.encoding.bom);
    }

    /// 不存在 → 错误文案带「文件不存在」前缀与路径（前端据此走 missing 页）。
    #[test]
    fn missing_file_reports_contract_error() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope.md");
        let path = missing.to_string_lossy().to_string();
        // 目录还在，先确认文件确实不存在。
        assert!(!missing.exists());

        let err = read(&path, None).unwrap_err();
        assert!(err.contains("文件不存在"), "错误文案契约: {err}");
        assert!(err.contains("nope.md"), "错误应带上路径: {err}");
    }

    /// 传目录 → 同样报「文件不存在」（目录能 open 成功，靠 is_file() 拦截）。
    #[test]
    fn directory_reports_file_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        assert!(std::path::Path::new(&path).is_dir());

        let err = read(&path, None).unwrap_err();
        assert!(
            err.contains("文件不存在"),
            "传目录应报「文件不存在」: {err}"
        );
    }

    /// 空文件 → 空文本、truncated 为假、bytes 为 0。
    #[test]
    fn empty_file_yields_empty_text() {
        let (path, _f) = temp_path(b"");

        let got = read(&path, None).unwrap();
        assert!(got.text.is_empty());
        assert_eq!(got.bytes, 0);
        assert!(!got.truncated);
    }

    /// cap 显式给 0：非空文件也读不出内容，且 truncated 为真（size > 0）。
    #[test]
    fn zero_cap_reads_nothing() {
        let (path, _f) = temp_path("你好".as_bytes());

        let got = read(&path, Some(0)).unwrap();
        assert!(got.text.is_empty());
        assert!(got.truncated);
        assert_eq!(got.bytes, 6);
    }

    /// 错误文案与前端分类器的契约对齐（对齐 `src/views/body-view.ts::classifyOpenError`
    /// 的 MISSING/DENIED 特征串）：措辞若被改动，这条测试先失败。
    #[test]
    fn error_text_matches_frontend_classifier_patterns() {
        let missing = format!("文件不存在: {}", r"C:\logs\a.md");
        assert!(missing.contains("文件不存在"));
        // 权限类 IO 错误在 Windows 下形如 "拒绝访问。 (os error 5)"，
        // 包进「读取失败: {}」后仍能被前端识别为 denied。
        let denied = format!("读取失败: {}", "拒绝访问。 (os error 5)");
        assert!(denied.contains("读取失败"));
        assert!(denied.contains("拒绝访问") && denied.contains("os error 5"));
    }

    /// 默认上限就是 4 MiB（前端「截断预览」提示依赖这个数）。
    #[test]
    fn default_cap_is_4_mib() {
        assert_eq!(DEFAULT_MAX_BYTES, 4 * 1024 * 1024);
    }

    // ==================== stat_text_file（文件变化轮询） ====================
    //
    // stat 命令没有 `AppHandle` 参数，测试直接调命令本身（与 impl 是同一份逻辑），
    // 顺带证明 `#[tauri::command]` 包装后的函数仍可被普通 Rust 代码调用。

    /// 正常文件 → size 是真实字节数，mtime 是非零 Unix 毫秒。
    /// 前端拿这两个字段判断「文件变了」，mtime 恒为 0 会让自动刷新彻底失效。
    #[test]
    fn stat_reports_size_and_nonzero_mtime() {
        let content = "你好，世界\n";
        let (path, _f) = temp_path(content.as_bytes());

        let got = stat_text_file(path).unwrap();
        assert_eq!(got.size, content.as_bytes().len() as u64);
        assert!(
            got.mtime_ms > 0,
            "mtime 应是非零 Unix 毫秒，实测 {}",
            got.mtime_ms
        );
    }

    /// 改写文件 → size 与 mtime 都要变化（前端据此触发自动刷新）。
    ///
    /// NTFS 的 mtime 精度足够（100ns），但「写完立刻读 metadata」可能撞在同一时刻，
    /// 所以先 sleep 一小会儿再写，保证两次时间戳可分辨。
    #[test]
    fn stat_changes_after_rewrite() {
        let mut f = write_temp(b"a");
        let path = f.path().to_string_lossy().to_string();
        let first = stat_text_file(path.clone()).unwrap();
        assert_eq!(first.size, 1);

        std::thread::sleep(std::time::Duration::from_millis(20));
        f.write_all(b"bcd").unwrap(); // 追加 3 字节：size 1 → 4
        f.flush().unwrap();

        let second = stat_text_file(path).unwrap();
        assert_eq!(second.size, 4, "追加后 size 应变大");
        assert!(
            second.mtime_ms > first.mtime_ms,
            "追加后 mtime 应变大: {} -> {}",
            first.mtime_ms,
            second.mtime_ms
        );
    }

    /// 不存在 → 与读取命令同款「文件不存在」文案与路径（前端走 missing 页）。
    #[test]
    fn stat_missing_file_reports_contract_error() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope.md");
        assert!(!missing.exists());

        let err = stat_text_file(missing.to_string_lossy().to_string()).unwrap_err();
        assert!(err.contains("文件不存在"), "错误文案契约: {err}");
        assert!(err.contains("nope.md"), "错误应带上路径: {err}");
    }

    /// 传目录 → 同样报「文件不存在」（目录也能 metadata 成功，靠 is_file() 拦截）。
    #[test]
    fn stat_directory_reports_file_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        assert!(Path::new(&path).is_dir());

        let err = stat_text_file(path).unwrap_err();
        assert!(
            err.contains("文件不存在"),
            "传目录应报「文件不存在」: {err}"
        );
    }

    /// 序列化契约：前端读的是 `mtimeMs`（camelCase）。改字段名或去掉
    /// `rename_all` 会让自动刷新静默失效，所以在这里把 JSON 形状钉死。
    #[test]
    fn stat_serializes_with_camel_case_keys() {
        let json = serde_json::to_string(&TextFileStat {
            mtime_ms: 1234,
            size: 56,
        })
        .unwrap();
        assert_eq!(json, r#"{"mtimeMs":1234,"size":56}"#);
    }
}
