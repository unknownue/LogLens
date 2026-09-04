# GM10 client_cfg .bin 格式规范（已逆向验证）

来源：对 `client_csharp` 仓库中打包器/读取器源码的交叉阅读 +
`MemoryPack 1.21.4`（仓库内 DLL + NuGet）字节级实测 +
全量表验证（见下文「验证结果」）。

## 总体布局

```
[int32 LE stringTableLen]
[stringTableSegment]        // MemoryPack Utf16 string[]，长 stringTableLen 字节
[dataSegment]               // ReadonlyDenseDictionary_V2<T>
```

- `stringTableLen` = 紧随其后的字符串表段**字节数**（不含自身 4 字节）。
  注意：文件头 `54 56` 恰好是 ASCII "TV"，但那是巧合——它其实是 0x5654=22100
  （stringTableLen），不是 magic。多语言文件头各不相同（en=85226, ja=31786…），
  数据段长度则一致（如 pic_guide_data 各语言均为 9748 字节）。

### stringTableSegment

```
[int32 count]                              // count == -1 => null（无表）
per string: [int32 charLen][UTF-16LE chars] // charLen == -1 => null；单位是"字符数"（占 2*charLen 字节）
```

### dataSegment = ReadonlyDenseDictionary_V2<T>

```
[byte 0x02]                                // MemoryPack WriteObjectHeader(memberCount=2)
[int32 keyCount][int32 key] * keyCount     // Keys: int[]，unmanaged LE
[int32 rowCount] rows...                   // Values: T[]
```

每行（`WriteObjectHeader(fieldCount)` 格式）：

```
[byte fieldCount]
每字段按"排序后的声明顺序"依次写入（见下）
```

字段编码（`CfgTypeNode.Write`，非 inline 字符串均走 stringTable 下标）：

| 类型 | 编码 |
|---|---|
| `string` | int32 下标（-1=null） |
| `string[]` / 嵌套 | int32 元素数（-1=null）+ 每元素 int32 下标，递归 |
| `int[]` 等标量数组 | int32 元素数 + unmanaged LE 元素 |
| `int/uint/float` | 4B LE；`long/ulong/double` 8B；`short/ushort` 2B；`bool/byte/sbyte` 1B |
| `dict<K,V>` | int32 条目数（-1=null）+ 顺序写 K、V（无 object header，字符串 inline） |
| `set<T>` | int32 元素数（-1=null）+ 逐元素 |

所有长度/计数均为 **int32 LE**（MemoryPack 1.21.4 实测：集合头非 varint）。
null 数组/字符串用 `-1` 表示。

### 字段排序（CfgFieldSorter.Sort，决定行内字段顺序）

1. `id` 字段最前
2. 值类型在引用类型前
3. 类型大小降序（string 与数组视为 8）
4. 对齐降序（min(size,8)）
5. 类型字面量字典序
6. 保持原始声明顺序

### 表结构（schema）来源

`res_dev/client_cfg_src/cfg_table_slots.json`：

```json
{"define": {"<表名>": {"<字段>": "<类型>", ...}, ...},
 "untranslate": {...}, "translation_replace": {...}}
```

支持类型：`int/uint/long/ulong/short/ushort/byte/sbyte/float/double/bool/string`、
`T[]`、`dict<K,V>`、`set<T>`。

## 验证结果

- 参考实现 `tools/clientcfg.py`（schema 驱动，纯 Python 标准库）。
- `tools/verify_all.py` 对 default 语言**全部 65 张有源 JSON 的表**逐表逐字段对比
  `res_dev/client_cfg_src/*.json`：
  - **56 张表逐字节/逐字段完全一致**；
  - 9 张表存在少量差异，全部是文本内容单字差异（如 `城池`→`城邑`、
    `校场`→`演武场`）——即 bin 打包后源 JSON 又被改过，属数据过期而非格式错误；
  - **0 个结构性解析失败**（行数、字段数、长度全部消费干净，delta=0）。
- `pic_guide_data.bin`：8 种语言（default/en/ja/ko/th/vi/zh_hans/zh_hant）
  全部解析成功，每语言 195 行。
- `caption_video`（含 `float[][]`）、`cfg_client_dragon_dance_pass`（含 `int[][]`）
  等嵌套数组类型也解析正确。

## 在 LogLens 中的用法

- 所有文件**默认按文本（日志）打开**；右上角图标按钮（网格 ⇄ 多行文本）把
  **当前激活 tab** 在文本/表格视图间切换，每个 tab 的模式相互独立。
- 后端 `parse_client_cfg_bin` 自动沿 bin 路径定位 `cfg_table_slots.json`
  （`<祖先>/res_dev/client_cfg_src/cfg_table_slots.json` 等），解析后以虚拟滚动
  表格展示；解析失败时显示错误，可「选择 schema…」手动指定。
- 实现位置：
  - Rust 解析器：`src-tauri/src/client_cfg.rs`（含单元测试与真实 bin 夹具测试）
  - Tauri 命令：`parse_client_cfg_bin`、`get_startup_paths`（lib.rs 注册）
  - 前端表格视图：`src/CfgTableTab.tsx`（TanStack Virtual + sticky 表头 + TSV 复制）
  - 模式切换：`App.tsx`（`TabInfo.viewMode` 按 tab 独立，右上角图标按钮）
  - 前端产物跟踪：`src-tauri/build.rs` 显式声明 `rerun-if-changed=../dist/**`
    （tauri-build 默认不跟踪 dist，只改前端不触发 release 重嵌）

## 参考工具（Python）

`tools/clientcfg.py <bin> --slots <cfg_table_slots.json> --table <表名> --out out.json`
（schema 驱动参考实现；`tools/verify_all.py` 全量表验证用）。

