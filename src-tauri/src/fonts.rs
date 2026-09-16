//! 系统字体枚举：给设置页的字体下拉提供「本机所有可用字体」。
//!
//! 为什么不扫目录 / 读注册表（这两条路都试过思路，都不可靠）：
//!   - 扫 `%WINDIR%\Fonts` 会漏掉装在用户目录、以及注册在其它路径的字体，
//!     而且拿到的是**文件名**（`msyh.ttc`），不是 CSS 需要的 family 名；
//!   - 注册表 `…\CurrentVersion\Fonts` 的键名是「字体显示名」，形如
//!     `微软雅黑 & Microsoft YaHei & Microsoft YaHei UI (TrueType)`，还得自己拆解，
//!     拆出来也不保证是 DirectWrite 认的名字。
//!
//! DirectWrite 的系统字体集是**权威且完整**的一份：WebView2（Chromium）在 Windows 上
//! 就是通过它取字体的，所以这份集合 = 浏览器真正能用的字体集合。顺带还给出每个 family
//! 的**全部本地化名**：中文字体因此既能用 `Microsoft YaHei` 也能用 `微软雅黑` 指定
//! （Chromium 两个名字都认），中文界面下也就有中文名可以显示。
//!
//! 只在 Windows 上编译（本应用是 Windows 桌面工具；其它平台走 `unsupported` 分支返回
//! 空列表，前端会回落到内置的候选字体表）。

use serde::Serialize;

/// 一个可选的系统字体（发给前端的最小信息）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SystemFont {
    /// 写进 CSS 的 family 名（优先 en-us 名）。
    pub family: String,
    /// 界面展示名（优先界面语言对应的本地化名，如中文下的「微软雅黑」）。
    pub display: String,
    /// 其它本地化名：英文界面下用中文名（或反过来）也要能搜到。
    pub aliases: Vec<String>,
    /// 自带中文字形（能直接渲染汉字）。
    pub cjk: bool,
    /// 等宽字体（字体自己声明的等宽标志：日志 / 表格列对齐全靠它）。
    pub mono: bool,
}

/// 一个字体族的名字信息 + 两个渲染相关的事实（DirectWrite 枚举的中间结果）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FamilyNames {
    /// CSS 名：优先 en-us，缺了就用第一条。
    pub family: String,
    /// 全部本地化名，locale 已转小写（`"en-us"` / `"zh-cn"` …）。
    pub localized: Vec<(String, String)>,
    /// 该族是否自带中文字形。
    pub cjk: bool,
    /// 该族是否等宽。
    pub mono: bool,
}

/// 判断「自带中文字形」用的探针字：常用汉字，覆盖中文的字体必然都有。
///
/// 为什么要问字体自己而不是在页面里量宽度：**汉字在所有中文字体里都是一个 em 宽**，
/// 换字体只变字形、不变宽度 —— canvas 量宽对中文字体根本没有区分度
/// （未安装的字体与中文字体量出来一样宽），只能靠字体表里的字形覆盖表来回答。
const CJK_PROBES: [u32; 2] = [0x4E2D, 0x6C49]; // 中、汉

/// 从「(locale, name) 列表」里挑出 CSS 名与本地化名表。
///
/// 纯函数（不碰 DirectWrite），单测直接覆盖这里的挑名规则。
/// 列表中不含 en-us 时退回第一条 —— 有些字体（如部分日文字体）只有本地化名。
pub fn pick_names(names: &[(String, String)]) -> Option<FamilyNames> {
    let mut cleaned: Vec<(String, String)> = names
        .iter()
        .map(|(locale, name)| (locale.trim().to_lowercase(), name.trim().to_string()))
        .filter(|(_, name)| !name.is_empty())
        .collect();
    if cleaned.is_empty() {
        return None;
    }
    // 同一 locale 的重名只留一条（DirectWrite 偶尔给出重复项）
    cleaned.dedup_by(|a, b| a.0 == b.0 && a.1 == b.1);

    let family = cleaned
        .iter()
        .find(|(locale, _)| locale.starts_with("en"))
        .or_else(|| cleaned.first())
        .map(|(_, name)| name.clone())?;

    Some(FamilyNames {
        family,
        localized: cleaned,
        // 两个事实由平台层填（这里只负责挑名字，保持纯函数可单测）
        cjk: false,
        mono: false,
    })
}

/// 挑界面展示名：优先界面语言（`lang` 前缀匹配 locale），否则用 CSS 名。
///
/// 例如中文界面下 `Microsoft YaHei` 显示为「微软雅黑」——
/// 用户在字体列表里是照着系统界面找名字的。
pub fn pick_display(names: &FamilyNames, lang: Option<&str>) -> String {
    let lang = lang.unwrap_or("").trim().to_lowercase();
    if !lang.is_empty() {
        let hit = names
            .localized
            .iter()
            .find(|(locale, _)| locale.starts_with(&lang))
            .map(|(_, name)| name.clone());
        if let Some(name) = hit {
            return name;
        }
    }
    names.family.clone()
}

/// 除展示名之外的其它本地化名（去重、保持原顺序）。
///
/// 用途：界面切到英文后，用户仍可能照着系统里的中文名去找字体（「雅黑」），
/// 反过来也一样 —— 把这些名字一并带上，搜索时才能命中。
pub fn pick_aliases(names: &FamilyNames, display: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    seen.insert(display.trim().to_lowercase());
    for (_, name) in &names.localized {
        let key = name.trim().to_lowercase();
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        out.push(name.clone());
    }
    out
}

// ==================== DirectWrite 枚举 ====================

#[cfg(windows)]
mod platform {
    use super::{FamilyNames, SystemFont, CJK_PROBES};
    use std::sync::OnceLock;
    use windows::core::Interface;
    use windows::Win32::Graphics::DirectWrite::{
        DWriteCreateFactory, IDWriteFactory, IDWriteFont1, IDWriteFontCollection,
        DWRITE_FACTORY_TYPE_SHARED,
    };

    /// 一个族里检查多少个字重：等宽 / 中文字形这些事实族内一致，
    /// 头几个就够（避免为一个族把十几个字重全走一遍）。
    const FONTS_PER_FAMILY: u32 = 4;

    /// 把 `windows` crate 的错误转成命令层的 `String` 错误。
    fn werr<T>(r: windows::core::Result<T>) -> Result<T, String> {
        r.map_err(|e| format!("DirectWrite 调用失败: {e}"))
    }

    /// 系统字体集（进程内缓存一次：枚举约几毫秒，但没必要每次开设置页都做）。
    static CACHE: OnceLock<Vec<FamilyNames>> = OnceLock::new();

    /// 读一个本地化字符串（`IDWriteLocalizedStrings` 的两个调用都需要先问长度）。
    unsafe fn read_string(
        strings: &windows::Win32::Graphics::DirectWrite::IDWriteLocalizedStrings,
        index: u32,
    ) -> Result<(String, String), String> {
        let locale_len = werr(unsafe { strings.GetLocaleNameLength(index) })? as usize;
        let mut locale_buf = vec![0u16; locale_len + 1];
        werr(unsafe { strings.GetLocaleName(index, &mut locale_buf) })?;

        let name_len = werr(unsafe { strings.GetStringLength(index) })? as usize;
        let mut name_buf = vec![0u16; name_len + 1];
        werr(unsafe { strings.GetString(index, &mut name_buf) })?;

        Ok((
            String::from_utf16_lossy(&locale_buf[..locale_len]),
            String::from_utf16_lossy(&name_buf[..name_len]),
        ))
    }

    /// 真正枚举：DirectWrite 系统字体集里的每一个 family。
    fn enumerate() -> Result<Vec<FamilyNames>, String> {
        // SAFETY: DWriteCreateFactory 只写我们传入的 out 指针；IDWriteFactory 是
        // 引用计数的 COM 对象，返回值由 crate 的智能指针持有，随作用域释放。
        let factory: IDWriteFactory =
            werr(unsafe { DWriteCreateFactory::<IDWriteFactory>(DWRITE_FACTORY_TYPE_SHARED) })?;

        let mut collection: Option<IDWriteFontCollection> = None;
        // SAFETY: 传的是栈上 Option 的可变引用；checkforupdates=false 表示用缓存集合。
        werr(unsafe { factory.GetSystemFontCollection(&mut collection, false) })?;
        let collection = collection.ok_or("系统字体集不可用")?;

        // SAFETY: 以下调用都只在有效 COM 接口上读取只读数据，缓冲区大小由
        // Get*Length 先问后取（与 DirectWrite 文档一致）。
        let count = unsafe { collection.GetFontFamilyCount() };
        let mut out: Vec<FamilyNames> = Vec::with_capacity(count as usize);
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

        for index in 0..count {
            let family = werr(unsafe { collection.GetFontFamily(index) })?;
            let names = werr(unsafe { family.GetFamilyNames() })?;
            let name_count = unsafe { names.GetCount() };

            let mut collected: Vec<(String, String)> = Vec::with_capacity(name_count as usize);
            for i in 0..name_count {
                collected.push(unsafe { read_string(&names, i) }?);
            }

            let Some(mut picked) = super::pick_names(&collected) else {
                continue;
            };
            // 同一个 CSS 名可能被多个 family 报出来（同一字体的多个字重家族）：
            // 下拉里出现重复项没有意义，按 CSS 名去重。
            if !seen.insert(picked.family.to_lowercase()) {
                continue;
            }

            // 两个渲染相关的事实问字体自己（页面上量不出来，见 CJK_PROBES 的注释）。
            let font_total = unsafe { family.GetFontCount() };
            for j in 0..font_total.min(FONTS_PER_FAMILY) {
                let font = werr(unsafe { family.GetFont(j) })?;
                // 等宽：IDWriteFont1 上的声明标志（Win8+ 才有这个接口）
                if !picked.mono {
                    if let Ok(font1) = font.cast::<IDWriteFont1>() {
                        picked.mono = unsafe { font1.IsMonospacedFont() }.as_bool();
                    }
                }
                if !picked.cjk {
                    picked.cjk = CJK_PROBES.iter().all(|&ch| {
                        // HasCharacter 返回 Result<BOOL>（HRESULT 包装）；出错当作「没有这个字形」。
                        unsafe { font.HasCharacter(ch) }
                            .map(|exists| exists.as_bool())
                            .unwrap_or(false)
                    });
                }
                if picked.mono && picked.cjk {
                    break;
                }
            }

            out.push(picked);
        }

        out.sort_by(|a, b| a.family.to_lowercase().cmp(&b.family.to_lowercase()));
        Ok(out)
    }

    /// 系统字体集（缓存）。
    pub fn families() -> Result<&'static [FamilyNames], String> {
        if let Some(cached) = CACHE.get() {
            return Ok(cached);
        }
        let list = enumerate()?;
        Ok(CACHE.get_or_init(|| list))
    }

    /// 投影成发给前端的列表。
    pub fn list(lang: Option<&str>) -> Result<Vec<SystemFont>, String> {
        Ok(families()?
            .iter()
            .map(|names| {
                let display = super::pick_display(names, lang);
                SystemFont {
                    family: names.family.clone(),
                    aliases: super::pick_aliases(names, &display),
                    display,
                    cjk: names.cjk,
                    mono: names.mono,
                }
            })
            .collect())
    }
}

#[cfg(not(windows))]
mod platform {
    use super::SystemFont;

    /// 非 Windows：本应用不支持，返回空列表（前端回落到内置候选表）。
    pub fn list(_lang: Option<&str>) -> Result<Vec<SystemFont>, String> {
        Ok(Vec::new())
    }
}

/// 本机所有可用字体（按 family 名排序，已去重）。
///
/// `lang` 决定展示名用哪种本地化名（如 `"zh"` →「微软雅黑」），
/// 与写进 CSS 的 `family` 无关。
pub fn list_system_fonts(lang: Option<&str>) -> Result<Vec<SystemFont>, String> {
    platform::list(lang)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(l, n)| (l.to_string(), n.to_string()))
            .collect()
    }

    #[test]
    fn picks_the_english_name_as_the_css_family() {
        let picked = pick_names(&names(&[("zh-cn", "微软雅黑"), ("en-us", "Microsoft YaHei")]))
            .expect("至少要有名字");
        assert_eq!(picked.family, "Microsoft YaHei");
        assert_eq!(picked.localized.len(), 2);
    }

    #[test]
    fn falls_back_to_the_first_name_when_there_is_no_english_one() {
        let picked = pick_names(&names(&[("ja-jp", "ＭＳ ゴシック")])).expect("至少要有名字");
        assert_eq!(picked.family, "ＭＳ ゴシック");
    }

    #[test]
    fn ignores_blank_names_and_returns_none_when_nothing_is_usable() {
        assert!(pick_names(&names(&[("en-us", "   ")])).is_none());
        assert!(pick_names(&[]).is_none());
        let picked = pick_names(&names(&[("en-us", ""), ("zh-cn", " 宋体 ")])).expect("还有一条可用");
        assert_eq!(picked.family, "宋体");
    }

    #[test]
    fn the_display_name_follows_the_ui_language() {
        let picked = pick_names(&names(&[("en-us", "Microsoft YaHei"), ("zh-cn", "微软雅黑")]))
            .expect("至少要有名字");
        assert_eq!(pick_display(&picked, Some("zh")), "微软雅黑");
        assert_eq!(pick_display(&picked, Some("zh-CN")), "微软雅黑");
        assert_eq!(pick_display(&picked, Some("en")), "Microsoft YaHei");
        // 界面语言对应的本地化名不存在时退回 CSS 名
        assert_eq!(pick_display(&picked, Some("ja")), "Microsoft YaHei");
        assert_eq!(pick_display(&picked, None), "Microsoft YaHei");
    }

    #[test]
    fn aliases_carry_the_other_localized_names_for_cross_language_search() {
        let picked = pick_names(&names(&[("en-us", "Microsoft YaHei"), ("zh-cn", "微软雅黑")]))
            .expect("至少要有名字");
        // 中文界面（展示名 = 微软雅黑）→ 英文名作为别名，供英文搜索
        assert_eq!(pick_aliases(&picked, "微软雅黑"), vec!["Microsoft YaHei"]);
        // 英文界面（展示名 = Microsoft YaHei）→ 中文名作为别名，供中文搜索
        assert_eq!(pick_aliases(&picked, "Microsoft YaHei"), vec!["微软雅黑"]);
        // 去重：同一名字在多条 locale 下重复出现只留一条
        let dupes = pick_names(&names(&[
            ("en-us", "Foo"),
            ("en-gb", "Foo"),
            ("zh-cn", "福"),
        ]))
        .expect("至少要有名字");
        assert_eq!(pick_aliases(&dupes, "Foo"), vec!["福"]);
        assert_eq!(pick_aliases(&dupes, "福"), vec!["Foo"]);
    }

    /// 集成用例：真机上的系统字体集应该是「一大串、非空、无重名」。
    ///
    /// 不断言具体字体名（每台机器的字体集不同），只断言结构性事实 ——
    /// 真正要防的回归是「DirectWrite 调用写错导致返回空列表」（那样设置页
    /// 会静默退回内置候选表，看起来只是「字体少了」而不像报错）。
    #[cfg(windows)]
    #[test]
    fn the_machine_reports_a_full_font_set() {
        let fonts = list_system_fonts(Some("zh")).expect("枚举系统字体失败");
        // 打印实际分布（`cargo test -- --nocapture` 可见）：排障时的第一个线索 ——
        // 分组全靠这两个事实，数字明显不合理就说明字体表查询有问题。
        let mono = fonts.iter().filter(|f| f.mono && !f.cjk).count();
        let cjk = fonts.iter().filter(|f| f.cjk).count();
        println!(
            "系统字体 family 共 {} 个：等宽 {} / 含中文字形 {} / 其它 {}",
            fonts.len(),
            mono,
            cjk,
            fonts.len() - mono - cjk
        );
        assert!(
            fonts.len() >= 20,
            "系统字体只枚举到 {} 个，DirectWrite 调用多半写错了",
            fonts.len()
        );
        assert!(fonts.iter().all(|f| !f.family.is_empty() && !f.display.is_empty()));

        let mut lowered: Vec<String> = fonts.iter().map(|f| f.family.to_lowercase()).collect();
        let total = lowered.len();
        lowered.sort();
        lowered.dedup();
        assert_eq!(total, lowered.len(), "同一个 family 名不该重复出现");

        // 任何一台 Windows 都装了的字体：有它就说明集合没取错
        assert!(
            fonts
                .iter()
                .any(|f| f.family.eq_ignore_ascii_case("Arial")
                    || f.family.eq_ignore_ascii_case("Segoe UI")
                    || f.family.eq_ignore_ascii_case("Consolas")),
            "系统字体集里连 Arial / Segoe UI / Consolas 都没有，解析多半有问题"
        );

        // 两个事实（等宽 / 中文字形）：分组全靠它们，断言结构性事实 ——
        // 「一个都没有」说明字体表查询（IsMonospacedFont / HasCharacter）写错了，
        // 而那会让设置页把所有字体都归到同一组里，看起来只是「分组没了」。
        assert!(
            fonts.iter().any(|f| f.mono),
            "没有任何等宽字体，IsMonospacedFont 调用多半写错了"
        );
        assert!(
            fonts.iter().any(|f| !f.mono),
            "所有字体都是等宽，IsMonospacedFont 调用多半写错了"
        );
        assert!(
            fonts.iter().any(|f| f.cjk),
            "没有任何带中文字形的字体，HasCharacter 调用多半写错了"
        );
        assert!(
            fonts.iter().any(|f| !f.cjk),
            "所有字体都带中文字形，HasCharacter 调用多半写错了"
        );

        // 具体字体的事实：装了才断言（换台机器也稳）
        let find = |name: &str| fonts.iter().find(|f| f.family.eq_ignore_ascii_case(name));
        if let Some(consolas) = find("Consolas") {
            assert!(consolas.mono, "Consolas 应当被判为等宽");
            assert!(!consolas.cjk, "Consolas 不该被判为带中文字形");
        }
        if let Some(simsun) = find("SimSun") {
            assert!(simsun.cjk, "SimSun（宋体）应当被判为带中文字形");
            assert!(!simsun.mono, "SimSun（宋体）不是等宽字体");
        }
        if let Some(arial) = find("Arial") {
            assert!(!arial.mono, "Arial 不是等宽字体");
        }

        // 本地化别名：中文名的字体在中文界面下要带出英文名（反之亦然），
        // 否则界面切成英文后就再也搜不到「雅黑」了。
        if let Some(yahei) = find("Microsoft YaHei") {
            assert!(
                yahei.aliases.iter().any(|a| a.contains("雅黑")) || yahei.display.contains("雅黑"),
                "微软雅黑的中文名既不在展示名也不在别名里：display={:?} aliases={:?}",
                yahei.display,
                yahei.aliases
            );
        }
    }

    /// 同一个 family 在两次调用之间必须一致（缓存不能改变结果）。
    #[cfg(windows)]
    #[test]
    fn repeated_calls_are_stable() {
        let first = list_system_fonts(Some("zh")).expect("枚举失败");
        let second = list_system_fonts(Some("en")).expect("枚举失败");
        assert_eq!(first.len(), second.len());
        // family 与语言无关，display 才跟语言走
        assert_eq!(
            first.iter().map(|f| &f.family).collect::<Vec<_>>(),
            second.iter().map(|f| &f.family).collect::<Vec<_>>()
        );
    }
}
