//! GM10 client_cfg .bin 解析器（schema 驱动）。
//!
//! 格式（与 ClientCfgPacker.Core.CfgBinWriter / 运行时
//! `MemoryPackDeserializer.DeserializeCfgDictWithStringTable` 字节等价，
//! MemoryPack 1.21.4）：
//!
//! ```text
//! [int32 LE stringTableLen][stringTableSegment][dataSegment]
//!
//! stringTableSegment（MemoryPack Utf16 string[]）:
//!   [int32 count]（-1 => null）
//!   每个 string: [int32 charLen]（-1 => null）+ [UTF-16LE chars]（2*charLen 字节）
//!
//! dataSegment（ReadonlyDenseDictionary_V2<T>）:
//!   [byte 0x02 objectHeader]
//!   [int32 keyCount][int32 key]*keyCount
//!   [int32 rowCount] rows...
//!   每行: [byte fieldCount] + 按“排序后的声明顺序”写各字段
//!
//! 字段编码:
//!   string      -> int32 字符串表下标（-1=null）
//!   string[]    -> int32 元素数（-1=null）+ 每元素 int32 下标，递归
//!   标量数组     -> int32 元素数 + unmanaged LE 元素
//!   标量         -> unmanaged LE
//!   dict<K,V>   -> int32 条目数（-1=null）+ 顺序写 K、V（字符串 inline）
//!   set<T>      -> int32 元素数（-1=null）+ 逐元素（字符串 inline）
//!
//! 行内字段顺序 = CfgFieldSorter.Sort：
//!   id 最前 → 值类型在前 → 类型大小降序（string/数组按 8）→ 对齐降序
//!   → 类型字面量字典序 → 保持原始声明顺序。
//!
//! 详细规范见 docs/client_cfg_bin_format.md。

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

// ============================== 值类型 ==============================

/// 配置单元格值。序列化到前端为 tagged JSON，便于表格渲染。
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "t", content = "v", rename_all = "lowercase")]
pub enum CfgValue {
    Null,
    Bool(bool),
    Byte(i32),
    Int(i32),
    UInt(u32),
    Long(i64),
    ULong(u64),
    Short(i16),
    UShort(u16),
    Float(f32),
    Double(f64),
    Str(String),
    Array(Vec<CfgValue>),
    /// 序列化为 [[k, v], ...]。
    Dict(Vec<(CfgValue, CfgValue)>),
    Set(Vec<CfgValue>),
}

// ============================== 输出结构 ==============================

#[derive(Serialize, Clone, Debug)]
pub struct CfgColumn {
    pub name: String,
    pub field_type: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct ClientCfgTable {
    /// 表名（snake_case，来自文件名去掉 `.bin` 与可选 `_<序号>` 后缀）。
    pub name: String,
    /// 列定义（已按 CfgFieldSorter 排序，与 rows 对齐）。
    pub columns: Vec<CfgColumn>,
    /// 行 key（int，来自 keys 数组；通常等于 id 字段，但不保证）。
    pub keys: Vec<i32>,
    /// 每行的单元格（与 columns 对齐）。key 单独由 `keys` 提供。
    pub rows: Vec<Vec<CfgValue>>,
}

// ============================== 类型描述 ==============================

#[derive(Clone)]
enum TypeSpec {
    Scalar(String),
    Array(Box<TypeSpec>),
    Dict(String, Box<TypeSpec>),
    Set(String),
}

impl TypeSpec {
    fn parse(text: &str) -> Result<Self, String> {
        let t = text.trim();
        if let Some(inner) = t.strip_suffix("[]") {
            return Ok(TypeSpec::Array(Box::new(TypeSpec::parse(inner)?)));
        }
        if let Some(inner) = t.strip_prefix("dict<").and_then(|s| s.strip_suffix('>')) {
            let parts = split_top_level(inner)?;
            if parts.len() != 2 {
                return Err(format!("dict 必须含两个类型参数，实际为 {} 个: '{t}'", parts.len()));
            }
            let key = parts[0].trim().to_string();
            if key.ends_with("[]") || key.contains('<') || !is_scalar(&key) {
                return Err(format!("dict key 必须为标量: '{key}'"));
            }
            return Ok(TypeSpec::Dict(key, Box::new(TypeSpec::parse(parts[1].trim())?)));
        }
        if let Some(inner) = t.strip_prefix("set<").and_then(|s| s.strip_suffix('>')) {
            let parts = split_top_level(inner)?;
            if parts.len() != 1 || !is_scalar(parts[0].trim()) {
                return Err(format!("set 必须含一个标量类型参数: '{t}'"));
            }
            return Ok(TypeSpec::Set(parts[0].trim().to_string()));
        }
        if is_scalar(t) {
            return Ok(TypeSpec::Scalar(t.to_string()));
        }
        Err(format!("不支持的类型: '{text}'"))
    }
}

fn is_scalar(t: &str) -> bool {
    matches!(
        t,
        "int" | "uint"
            | "long"
            | "ulong"
            | "short"
            | "ushort"
            | "byte"
            | "sbyte"
            | "float"
            | "double"
            | "bool"
            | "string"
    )
}

fn split_top_level(s: &str) -> Result<Vec<&str>, String> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut start = 0;
    for (i, c) in s.char_indices() {
        match c {
            '<' => depth += 1,
            '>' => depth -= 1,
            ',' if depth == 0 => {
                parts.push(&s[start..i]);
                start = i + c.len_utf8();
            }
            _ => {}
        }
    }
    if depth != 0 {
        return Err(format!("类型括号不匹配: '{s}'"));
    }
    parts.push(&s[start..]);
    Ok(parts)
}

/// 类型字节大小（string 与数组视为 8，参考 CfgTypeSizeMapper）。
fn type_size(t: &TypeSpec) -> u32 {
    if is_reference(t) {
        return 8;
    }
    match t {
        TypeSpec::Scalar(s) => match s.as_str() {
            "double" | "long" | "ulong" => 8,
            "int" | "uint" | "float" => 4,
            "short" | "ushort" => 2,
            _ => 1, // bool / byte / sbyte
        },
        _ => 8,
    }
}

fn is_reference(t: &TypeSpec) -> bool {
    match t {
        TypeSpec::Array(_) | TypeSpec::Dict(..) | TypeSpec::Set(_) => true,
        TypeSpec::Scalar(s) => s == "string",
    }
}

/// CfgFieldSorter.Sort 等价实现。fields: (name, type_str)。
/// Rust `sort_by` 是稳定排序，键完全相同时自动保持原始声明顺序。
fn sort_fields(fields: &mut [(String, String)]) {
    fields.sort_by(|(na, ta), (nb, tb)| {
        sort_key(na, ta).cmp(&sort_key(nb, tb))
    });
}

fn sort_key<'a>(name: &'a str, t: &'a str) -> (u8, u8, std::cmp::Reverse<u32>, std::cmp::Reverse<u32>, &'a str) {
    let spec = TypeSpec::parse(t).unwrap_or(TypeSpec::Scalar(t.to_string()));
    let size = type_size(&spec);
    let align = size.min(8);
    (
        if name == "id" { 0 } else { 1 },
        if is_reference(&spec) { 1 } else { 0 },
        std::cmp::Reverse(size),
        std::cmp::Reverse(align),
        t, // 类型字面量字典序（与 C# 一致，比较完整类型文本）
    )
}

// ============================== 字节游标 ==============================

struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn read_i32(&mut self) -> Result<i32, String> {
        let b = self.take(4)?;
        Ok(i32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn read_u32(&mut self) -> Result<u32, String> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn read_i64(&mut self) -> Result<i64, String> {
        let b = self.take(8)?;
        Ok(i64::from_le_bytes(b.try_into().unwrap()))
    }

    fn read_u64(&mut self) -> Result<u64, String> {
        let b = self.take(8)?;
        Ok(u64::from_le_bytes(b.try_into().unwrap()))
    }

    fn read_i16(&mut self) -> Result<i16, String> {
        let b = self.take(2)?;
        Ok(i16::from_le_bytes([b[0], b[1]]))
    }

    fn read_u16(&mut self) -> Result<u16, String> {
        let b = self.take(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    fn read_byte(&mut self) -> Result<u8, String> {
        let b = self.take(1)?;
        Ok(b[0])
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.pos + n > self.data.len() {
            return Err(format!(
                "越界读取: 需要 {n} 字节于 0x{:X}，文件仅 {} 字节",
                self.pos,
                self.data.len()
            ));
        }
        let s = &self.data[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    fn read_inline_string(&mut self) -> Result<Option<String>, String> {
        let len = self.read_i32()?;
        if len < 0 {
            return Ok(None);
        }
        let bytes = self.take(len as usize * 2)?;
        let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        Ok(Some(String::from_utf16_lossy(&units)))
    }
}

// ============================== 解析 ==============================

/// 按 schema 解析 bin 数据。`fields` 为声明顺序的 (字段名, 类型) 列表。
pub fn parse_client_cfg(
    data: &[u8],
    table_name: &str,
    fields: &[(String, String)],
) -> Result<ClientCfgTable, String> {
    if data.len() < 4 {
        return Err("文件太小，不是合法的 client_cfg bin".into());
    }
    let st_len = Cursor::new(data).read_i32()?;
    if st_len < 0 {
        return Err(format!("stringTableLen 非法: {st_len}"));
    }
    let st_len = st_len as usize;
    let st_end = 4 + st_len;
    if st_end > data.len() {
        return Err(format!(
            "stringTableLen={st_len} 超出文件大小 {}",
            data.len()
        ));
    }

    // --- 字符串表 ---
    let mut c = Cursor::new(&data[4..st_end]);
    let count = c.read_i32()?;
    let mut strings: Vec<Option<String>> = Vec::new();
    if count >= 0 {
        strings.reserve(count as usize);
        for _ in 0..count {
            let len = c.read_i32()?;
            if len < 0 {
                strings.push(None);
            } else {
                let bytes = c.take(len as usize * 2)?;
                let units: Vec<u16> = bytes
                    .chunks_exact(2)
                    .map(|ch| u16::from_le_bytes([ch[0], ch[1]]))
                    .collect();
                strings.push(Some(String::from_utf16_lossy(&units)));
            }
        }
    }
    if c.pos != c.data.len() {
        return Err(format!("字符串表解析不完整: {}/{} 字节", c.pos, c.data.len()));
    }

    // --- 数据段 ---
    let mut c = Cursor::new(&data[st_end..]);
    let header = c.read_byte()?;
    if header != 2 {
        return Err(format!("数据段 objectHeader 应为 2，实际为 {header}（文件可能不是 client_cfg bin）"));
    }
    let key_count = c.read_i32()?;
    if key_count < 0 {
        return Err("keys 数组为空指针".into());
    }
    let mut keys = Vec::with_capacity(key_count as usize);
    for _ in 0..key_count {
        keys.push(c.read_i32()?);
    }
    let row_count = c.read_i32()?;
    if row_count < 0 {
        return Err("rows 数组为空指针".into());
    }

    // 字段排序 + 类型解析
    let mut sorted: Vec<(String, String)> = fields.to_vec();
    sort_fields(&mut sorted);
    let specs: Vec<TypeSpec> = sorted
        .iter()
        .map(|(_, t)| TypeSpec::parse(t).map_err(|e| format!("字段类型解析失败: {e}")))
        .collect::<Result<_, _>>()?;

    let mut rows = Vec::with_capacity(row_count as usize);
    for _ in 0..row_count {
        let fc = c.read_byte()?;
        if fc as usize != specs.len() {
            return Err(format!(
                "行 fieldCount={fc} 与 schema 字段数 {} 不符（offset 0x{:X}）",
                specs.len(),
                c.pos - 1
            ));
        }
        let mut cells = Vec::with_capacity(specs.len());
        for spec in &specs {
            cells.push(read_value(&mut c, spec, &strings, false)?);
        }
        rows.push(cells);
    }
    if c.pos != c.data.len() {
        return Err(format!(
            "数据段解析不完整: 消费 {}/{} 字节（剩余 {} 字节）",
            c.pos,
            c.data.len(),
            c.data.len() - c.pos
        ));
    }

    Ok(ClientCfgTable {
        name: table_name.to_string(),
        columns: sorted
            .iter()
            .map(|(n, t)| CfgColumn { name: n.clone(), field_type: t.clone() })
            .collect(),
        keys,
        rows,
    })
}

fn read_value(
    c: &mut Cursor<'_>,
    spec: &TypeSpec,
    strings: &[Option<String>],
    inline_strings: bool,
) -> Result<CfgValue, String> {
    match spec {
        TypeSpec::Scalar(s) => match s.as_str() {
            "string" => {
                if inline_strings {
                    // dict/set 内的字符串直接内联（charLen + UTF-16LE）
                    return c.read_inline_string().map(|s| match s {
                        Some(text) => CfgValue::Str(text),
                        None => CfgValue::Null,
                    });
                }
                let idx = c.read_i32()?;
                Ok(match idx {
                    -1 => CfgValue::Null,
                    i if i >= 0 && (i as usize) < strings.len() => strings[i as usize]
                        .clone()
                        .map(CfgValue::Str)
                        .unwrap_or(CfgValue::Null),
                    i => return Err(format!("字符串表下标越界: {i}（表大小 {}）", strings.len())),
                })
            }
            "int" => Ok(CfgValue::Int(c.read_i32()?)),
            "uint" => Ok(CfgValue::UInt(c.read_u32()?)),
            "long" => Ok(CfgValue::Long(c.read_i64()?)),
            "ulong" => Ok(CfgValue::ULong(c.read_u64()?)),
            "short" => Ok(CfgValue::Short(c.read_i16()?)),
            "ushort" => Ok(CfgValue::UShort(c.read_u16()?)),
            "byte" => Ok(CfgValue::Byte(c.read_byte()? as i32)),
            "sbyte" => Ok(CfgValue::Byte(c.read_byte()? as i8 as i32)),
            "float" => Ok(CfgValue::Float(f32::from_le_bytes(
                c.take(4)?.try_into().unwrap(),
            ))),
            "double" => Ok(CfgValue::Double(f64::from_le_bytes(
                c.take(8)?.try_into().unwrap(),
            ))),
            "bool" => Ok(CfgValue::Bool(c.read_byte()? != 0)),
            other => Err(format!("不支持的标量类型: {other}")),
        },
        TypeSpec::Array(elem) => {
            let n = c.read_i32()?;
            if n < 0 {
                return Ok(CfgValue::Null);
            }
            let mut items = Vec::with_capacity(n as usize);
            for _ in 0..n {
                items.push(read_value(c, elem, strings, inline_strings)?);
            }
            Ok(CfgValue::Array(items))
        }
        TypeSpec::Set(elem) => {
            let n = c.read_i32()?;
            if n < 0 {
                return Ok(CfgValue::Null);
            }
            let mut items = Vec::with_capacity(n as usize);
            for _ in 0..n {
                items.push(read_value(c, &TypeSpec::Scalar(elem.clone()), strings, true)?);
            }
            Ok(CfgValue::Set(items))
        }
        TypeSpec::Dict(key, value) => {
            let n = c.read_i32()?;
            if n < 0 {
                return Ok(CfgValue::Null);
            }
            let mut items = Vec::with_capacity(n as usize);
            for _ in 0..n {
                let k = read_value(c, &TypeSpec::Scalar(key.clone()), strings, true)?;
                let v = read_value(c, value, strings, true)?;
                items.push((k, v));
            }
            Ok(CfgValue::Dict(items))
        }
    }
}

// ============================== schema 加载 ==============================

/// 宽松 JSON 清洗：去除 `//` 行注释、尾随逗号，并转义字符串外的裸控制字符。
/// 与 tools/clientcfg.py 的 `_strip_json_extras` 等价（仓库 JSON 含注释/尾随逗号）。
fn sanitize_json_extras(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_str = false;
    while let Some(c) = chars.next() {
        if in_str {
            if c == '\\' {
                out.push(c);
                if let Some(n) = chars.next() {
                    out.push(n);
                }
                continue;
            }
            if c == '"' {
                in_str = false;
                out.push(c);
                continue;
            }
            if (c as u32) < 0x20 {
                out.push_str(&format!("\\u{:04x}", c as u32));
                continue;
            }
            out.push(c);
            continue;
        }
        if c == '"' {
            in_str = true;
            out.push(c);
        } else if c == '/' && chars.peek() == Some(&'/') {
            // 行注释：跳到行尾
            for ch in chars.by_ref() {
                if ch == '\n' {
                    out.push('\n');
                    break;
                }
            }
        } else if c == ',' {
            // 尾随逗号：跳过逗号后的空白，若紧跟 } 或 ] 则丢弃逗号
            let mut clone = chars.clone();
            let mut skip = false;
            while let Some(&n) = clone.peek() {
                if n == ' ' || n == '\t' || n == '\r' || n == '\n' {
                    clone.next();
                } else if n == '}' || n == ']' {
                    skip = true;
                    break;
                } else {
                    break;
                }
            }
            if skip {
                // 保持原 chars 前进：跳过空白即可（} / ] 由后续循环输出）
                while let Some(&n) = chars.peek() {
                    if n == ' ' || n == '\t' || n == '\r' || n == '\n' {
                        chars.next();
                    } else {
                        break;
                    }
                }
            } else {
                out.push(c);
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// 读取 cfg_table_slots.json，返回 表名 -> [(字段, 类型)]（未排序，声明顺序）。
pub fn load_schema(slots_path: &Path) -> Result<HashMap<String, Vec<(String, String)>>, String> {
    let text = std::fs::read_to_string(slots_path)
        .map_err(|e| format!("读取 schema 失败 {}: {}", slots_path.display(), e))?;
    let doc: serde_json::Value = serde_json::from_str(&sanitize_json_extras(&text))
        .map_err(|e| format!("解析 {} 失败: {}", slots_path.display(), e))?;
    let mut out = HashMap::new();
    // define 段是直接的表名对象；untranslate/translation_replace 段各含一个 define 子对象。
    let mut sections: Vec<&serde_json::Value> = Vec::new();
    if let Some(v) = doc.get("define") {
        sections.push(v);
    }
    for section in ["untranslate", "translation_replace"] {
        if let Some(v) = doc.get(section).and_then(|s| s.get("define")) {
            sections.push(v);
        }
    }
    for define in sections {
        if let Some(obj) = define.as_object() {
            for (table, fields) in obj {
                let mut list = Vec::new();
                if let Some(f) = fields.as_object() {
                    for (name, ty) in f {
                        if let Some(t) = ty.as_str() {
                            list.push((name.clone(), t.to_string()));
                        }
                    }
                }
                out.insert(table.clone(), list);
            }
        }
    }
    if out.is_empty() {
        return Err(format!("{} 中未找到任何表定义", slots_path.display()));
    }
    Ok(out)
}

/// 从 bin 路径自动定位 cfg_table_slots.json。
/// 沿 bin 文件向上逐级检查 `<ancestor>/res_dev/client_cfg_src/cfg_table_slots.json`、
/// `<ancestor>/client_cfg_src/cfg_table_slots.json` 与 `<ancestor>/cfg_table_slots.json`。
pub fn locate_slots(bin_path: &Path) -> Option<PathBuf> {
    let mut dir = bin_path.parent()?.to_path_buf();
    for _ in 0..8 {
        for rel in [
            "res_dev/client_cfg_src/cfg_table_slots.json",
            "client_cfg_src/cfg_table_slots.json",
            "cfg_table_slots.json",
        ] {
            let candidate = dir.join(rel);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

/// 表名：文件名去掉 `.bin`；若 schema 无该表且以 `_<数字>` 结尾，再去掉后缀重试。
fn resolve_table_name<'a>(stem: &'a str, schema: &HashMap<String, Vec<(String, String)>>) -> Option<&'a str> {
    if schema.contains_key(stem) {
        return Some(stem);
    }
    if let Some(idx) = stem.rfind('_') {
        let prefix = &stem[..idx];
        if stem[idx + 1..].chars().all(|ch| ch.is_ascii_digit()) && schema.contains_key(prefix) {
            return Some(prefix);
        }
    }
    None
}

// ============================== Tauri 命令入口 ==============================

/// 打开并解析一个 client_cfg bin 为表格数据。
/// `slots_path` 缺省时沿 bin 路径自动定位 cfg_table_slots.json。
#[tauri::command]
pub fn parse_client_cfg_bin(
    path: String,
    slots_path: Option<String>,
) -> Result<ClientCfgTable, String> {
    let bin_path = PathBuf::from(&path);
    if !bin_path.is_file() {
        return Err(format!("文件不存在: {}", path));
    }
    let stem = bin_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();

    let slots_path = match slots_path {
        Some(p) => PathBuf::from(p),
        None => locate_slots(&bin_path).ok_or_else(|| {
            format!(
                "未找到 cfg_table_slots.json（已沿 {path} 向上查找 res_dev/client_cfg_src 等位置）；请手动指定 schema 文件"
            )
        })?,
    };
    if !slots_path.is_file() {
        return Err(format!("schema 文件不存在: {}", slots_path.display()));
    }

    let schema = load_schema(&slots_path)?;
    let table_name = resolve_table_name(&stem, &schema)
        .ok_or_else(|| format!("表 '{stem}' 未在 {} 中找到", slots_path.display()))?;
    let fields = schema.get(table_name).cloned().unwrap_or_default();
    if fields.is_empty() {
        return Err(format!("表 '{table_name}' 在 schema 中无字段定义"));
    }

    let data = std::fs::read(&bin_path).map_err(|e| format!("读取失败: {e}"))?;
    parse_client_cfg(&data, table_name, &fields)
        .map_err(|e| format!("解析 {table_name} 失败: {e}"))
}

// ============================== 测试 ==============================

#[cfg(test)]
mod tests {
    use super::*;

    /// 合成一个最小 bin（与 CfgBinWriter 输出字节等价）。
    fn build_bin(strings: &[Option<&str>], keys: &[i32], rows: &[&[u8]]) -> Vec<u8> {
        // stringTable
        let mut st: Vec<u8> = Vec::new();
        st.extend_from_slice(&(strings.len() as i32).to_le_bytes());
        for s in strings {
            match s {
                None => st.extend_from_slice(&(-1i32).to_le_bytes()),
                Some(text) => {
                    st.extend_from_slice(&(text.encode_utf16().count() as i32).to_le_bytes());
                    for u in text.encode_utf16() {
                        st.extend_from_slice(&u.to_le_bytes());
                    }
                }
            }
        }
        // data segment
        let mut ds: Vec<u8> = Vec::new();
        ds.push(2u8);
        ds.extend_from_slice(&(keys.len() as i32).to_le_bytes());
        for k in keys {
            ds.extend_from_slice(&k.to_le_bytes());
        }
        ds.extend_from_slice(&(rows.len() as i32).to_le_bytes());
        for r in rows {
            ds.extend_from_slice(r);
        }
        let mut out = Vec::new();
        out.extend_from_slice(&(st.len() as i32).to_le_bytes());
        out.extend_from_slice(&st);
        out.extend_from_slice(&ds);
        out
    }

    #[test]
    fn field_sorter_matches_csharp_rules() {
        // pic_guide_data 的 schema 声明顺序（cfg_table_slots.json 原始顺序）。
        let mut fields = vec![
            ("id".to_string(), "uint".to_string()),
            ("type".to_string(), "int".to_string()),
            ("title".to_string(), "string[]".to_string()),
            ("tips".to_string(), "string[]".to_string()),
            ("tabs".to_string(), "string[]".to_string()),
            ("bg_list".to_string(), "int[]".to_string()),
            ("info_list".to_string(), "int[]".to_string()),
        ];
        sort_fields(&mut fields);
        let order: Vec<&str> = fields.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            order,
            vec!["id", "type", "bg_list", "info_list", "title", "tips", "tabs"]
        );
    }

    #[test]
    fn parses_pic_guide_like_table() {
        // 字段声明顺序与 pic_guide_data 相同（排序后 id,type,bg_list,info_list,title,tips,tabs）
        let fields = vec![
            ("id".to_string(), "uint".to_string()),
            ("type".to_string(), "int".to_string()),
            ("bg_list".to_string(), "int[]".to_string()),
            ("info_list".to_string(), "int[]".to_string()),
            ("title".to_string(), "string[]".to_string()),
            ("tips".to_string(), "string[]".to_string()),
            ("tabs".to_string(), "string[]".to_string()),
        ];
        // 行 0: id=0 type=1 bg=[1,2,3] info=[] title=[s0] tips=[s1,s2] tabs=[]
        // 行 1: id=1 type=2 bg=[] info=[] title=[s3] tips=[] tabs=[]
        let row0: Vec<u8> = {
            let mut r = vec![7u8]; // fieldCount
            r.extend_from_slice(&0u32.to_le_bytes()); // id
            r.extend_from_slice(&1i32.to_le_bytes()); // type
            r.extend_from_slice(&3i32.to_le_bytes()); // bg_list count
            r.extend_from_slice(&1i32.to_le_bytes());
            r.extend_from_slice(&2i32.to_le_bytes());
            r.extend_from_slice(&3i32.to_le_bytes());
            r.extend_from_slice(&0i32.to_le_bytes()); // info_list
            r.extend_from_slice(&1i32.to_le_bytes()); // title count
            r.extend_from_slice(&0i32.to_le_bytes()); // title[0] = strings[0]
            r.extend_from_slice(&2i32.to_le_bytes()); // tips count
            r.extend_from_slice(&1i32.to_le_bytes());
            r.extend_from_slice(&2i32.to_le_bytes());
            r.extend_from_slice(&0i32.to_le_bytes()); // tabs
            r
        };
        let row1: Vec<u8> = {
            let mut r = vec![7u8];
            r.extend_from_slice(&1u32.to_le_bytes());
            r.extend_from_slice(&2i32.to_le_bytes());
            r.extend_from_slice(&0i32.to_le_bytes()); // bg
            r.extend_from_slice(&0i32.to_le_bytes()); // info
            r.extend_from_slice(&1i32.to_le_bytes()); // title
            r.extend_from_slice(&3i32.to_le_bytes());
            r.extend_from_slice(&0i32.to_le_bytes()); // tips
            r.extend_from_slice(&0i32.to_le_bytes()); // tabs
            r
        };
        let bin = build_bin(
            &[Some("标题"), Some("提示1"), Some("提示2"), Some("分城说明")],
            &[0, 1],
            &[&row0, &row1],
        );

        let table = parse_client_cfg(&bin, "pic_guide_data", &fields).unwrap();
        assert_eq!(table.name, "pic_guide_data");
        assert_eq!(table.keys, vec![0, 1]);
        assert_eq!(table.rows.len(), 2);
        assert_eq!(table.columns.len(), 7);
        assert_eq!(table.columns[0].name, "id");
        assert_eq!(table.columns[1].name, "type");
        match &table.rows[0][2] {
            CfgValue::Array(v) => assert_eq!(v.len(), 3),
            other => panic!("bg_list 应为数组，得到 {other:?}"),
        }
        match &table.rows[1][4] {
            CfgValue::Array(v) => match &v[0] {
                CfgValue::Str(s) => assert_eq!(s, "分城说明"),
                other => panic!("title[0] 应为字符串，得到 {other:?}"),
            },
            other => panic!("title 应为数组，得到 {other:?}"),
        }
    }

    #[test]
    fn parses_nested_and_dict_values() {
        let fields = vec![
            ("id".to_string(), "uint".to_string()),
            ("data".to_string(), "int[][]".to_string()),
            ("map".to_string(), "dict<string,int>".to_string()),
        ];
        // 排序: id(uint,4) 最前；value 类型只剩 id；引用: data(int[][]) map(dict)
        // 类型字面量字典序 "dict<string,int>" < "int[][]" => map 在 data 前。
        // 行: id=7, map={"a":1,"b":2}（dict 字符串 inline）, data=[[1,2],[3]]
        fn inline_str(out: &mut Vec<u8>, s: &str) {
            out.extend_from_slice(&(s.encode_utf16().count() as i32).to_le_bytes());
            for u in s.encode_utf16() {
                out.extend_from_slice(&u.to_le_bytes());
            }
        }
        let mut r = vec![3u8];
        r.extend_from_slice(&7u32.to_le_bytes()); // id
        r.extend_from_slice(&2i32.to_le_bytes()); // map count
        inline_str(&mut r, "a");
        r.extend_from_slice(&1i32.to_le_bytes());
        inline_str(&mut r, "b");
        r.extend_from_slice(&2i32.to_le_bytes());
        r.extend_from_slice(&2i32.to_le_bytes()); // data 外层 count
        r.extend_from_slice(&2i32.to_le_bytes()); // data[0] count
        r.extend_from_slice(&1i32.to_le_bytes());
        r.extend_from_slice(&2i32.to_le_bytes());
        r.extend_from_slice(&1i32.to_le_bytes()); // data[1] count
        r.extend_from_slice(&3i32.to_le_bytes());
        let bin = build_bin(&[None], &[7], &[&r]);

        let table = parse_client_cfg(&bin, "t", &fields).unwrap();
        assert_eq!(table.columns[1].name, "map");
        assert_eq!(table.columns[2].name, "data");
        match &table.rows[0][2] {
            CfgValue::Array(outer) => assert_eq!(outer.len(), 2),
            other => panic!("data 应为数组，得到 {other:?}"),
        }
        match &table.rows[0][1] {
            CfgValue::Dict(entries) => assert_eq!(entries.len(), 2),
            other => panic!("map 应为 dict，得到 {other:?}"),
        }
    }

    #[test]
    fn rejects_truncated_bin() {
        let fields = vec![("id".to_string(), "uint".to_string())];
        let err = parse_client_cfg(&[0x10, 0x00, 0x00, 0x00, 0xFF], "t", &fields).unwrap_err();
        assert!(err.contains("越界") || err.contains("超出"), "err = {err}");
    }

    #[test]
    fn resolve_table_name_with_index_suffix() {
        let mut schema = HashMap::new();
        schema.insert("cfg_client_union_power".to_string(), Vec::new());
        assert_eq!(
            resolve_table_name("cfg_client_union_power_2", &schema),
            Some("cfg_client_union_power")
        );
        assert_eq!(resolve_table_name("missing_table", &schema), None);
    }

    /// 用真实 bin 做端到端校验（可选）：设置环境变量后运行。
    /// CLIENT_CFG_FIXTURE=<bin 路径> CLIENT_CFG_SLOTS=<slots 路径> [CLIENT_CFG_DUMP=<输出 json>]
    #[test]
    fn parses_real_fixture_if_present() {
        let Ok(bin) = std::env::var("CLIENT_CFG_FIXTURE") else {
            return;
        };
        let slots = std::env::var("CLIENT_CFG_SLOTS").unwrap_or_default();
        let table = parse_client_cfg_bin(bin.clone(), (!slots.is_empty()).then_some(slots)).unwrap();
        assert!(!table.keys.is_empty(), "fixture 表格不应为空");
        if let Ok(out) = std::env::var("CLIENT_CFG_DUMP") {
            let json = serde_json::to_string_pretty(&table).unwrap();
            std::fs::write(&out, json).unwrap();
        }
    }
}
