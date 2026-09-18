//! 实时文本过滤：多关键词 Aho-Corasick 匹配（热路径）与正则匹配两种**互斥**模式。
//!
//! 模式互斥由前端保证：任一时刻只填 keywords 或只填 regex，另一字段显式置空。
//! 这里保留「任一命中即命中」的判断，是为了让两种模式各自独立生效；
//! 若两者同时非空（非预期用法），语义退化为 OR 并集。
//!
//! 过滤发生在后端（Rust），前端只接收「已命中」的行，保证：
//!   - 增量读取 + 增量过滤 + 增量渲染全部增量化
//!   - 高频追加时过滤不在 JS 单线程里成为瓶颈

use aho_corasick::AhoCorasick;
use regex::Regex;

/// 过滤条件。
///
/// 正常用法下 `keywords` 与 `regex` 互斥（二选一，另一个为空）：
/// 前端「关键词 / 正则」两个模式一次只填一个字段，切换模式即整表重扫。
#[derive(Debug, Clone, Default)]
pub struct FilterSpec {
    /// 普通关键词列表（OR 关系，大小写不敏感）。
    pub keywords: Vec<String>,
    /// 可选的正则表达式（编译后的）。
    pub regex: Option<String>,
    /// 是否大小写敏感（默认 false，即不敏感）。仅作用于关键词；
    /// 正则要区分大小写请自行写内联标志 `(?i)`。
    pub case_sensitive: bool,
}

/// 已编译的过滤器。
pub struct Filter {
    /// Aho-Corasick 多模式匹配器。
    ac: Option<AhoCorasick>,
    /// 正则（带回溯保护，限制长度）。
    re: Option<Regex>,
    /// 原始条件（编译后的匹配器只留得下「能不能匹配」，留不住用户填的是什么）。
    /// 换编码重建会话时要把条件原样搬过去，所以这里存一份。
    spec: FilterSpec,
}

impl Filter {
    pub fn new(spec: FilterSpec) -> Self {
        let ac = if spec.keywords.is_empty() {
            None
        } else {
            AhoCorasick::builder()
                .match_kind(aho_corasick::MatchKind::Standard)
                // ASCII 大小写不敏感直接内建在匹配器里，
                // 避免每行 text.to_lowercase() 的堆分配（高频日志热路径）。
                .ascii_case_insensitive(!spec.case_sensitive)
                .build(&spec.keywords)
                .ok()
        };

        let re = match &spec.regex {
            // 限制正则长度，防止灾难性回溯。
            Some(p) if (!p.is_empty() && p.len() <= 512) => Regex::new(p).ok(),
            _ => None,
        };

        Self { ac, re, spec }
    }

    /// 原始过滤条件。
    pub fn spec(&self) -> &FilterSpec {
        &self.spec
    }

    /// 当前是否**真的**在过滤（关键词与正则两侧都为空 = 不过滤，视图即全量）。
    ///
    /// 正文内搜索据此决定范围：生效 → 只搜「过滤后的行」（用户看得见的那些行）；
    /// 未生效 → 从磁盘流式搜整个文件。注意与「过滤条件为空」区分：正则编译失败
    /// （超长/非法）时两侧均为 None，视图本来就是全量，搜索也应按整文件处理。
    pub fn is_active(&self) -> bool {
        self.ac.is_some() || self.re.is_some()
    }

    /// 判断一行文本是否命中过滤条件（空条件 = 全命中）。
    ///
    /// 两种模式互斥时，这里等价于「用当前模式匹配」：另一侧为 None，不参与判断。
    pub fn matches(&self, text: &str) -> bool {
        // 无任何条件 => 所有行都命中。
        if self.ac.is_none() && self.re.is_none() {
            return true;
        }

        // 直接匹配原文本：大小写不敏感由 Aho-Corasick 内部处理，零分配。
        if let Some(ac) = &self.ac {
            if ac.is_match(text) {
                return true;
            }
        }

        if let Some(re) = &self.re {
            if re.is_match(text) {
                return true;
            }
        }

        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_filter_matches_all() {
        let f = Filter::new(FilterSpec::default());
        assert!(f.matches("anything"));
        assert!(f.matches(""));
    }

    #[test]
    fn keyword_filter_is_case_insensitive_by_default() {
        let spec = FilterSpec {
            keywords: vec!["ERROR".to_string()],
            regex: None,
            case_sensitive: false,
        };
        let f = Filter::new(spec);
        assert!(f.matches("2026 ERROR something"));
        assert!(f.matches("an error occurred"));
        assert!(!f.matches("all good"));
    }

    #[test]
    fn multi_keyword_or_semantics() {
        let spec = FilterSpec {
            keywords: vec!["error".to_string(), "warn".to_string()],
            regex: None,
            case_sensitive: false,
        };
        let f = Filter::new(spec);
        assert!(f.matches("WARN: low memory"));
        assert!(f.matches("error: failed"));
        assert!(!f.matches("info: ok"));
    }

    #[test]
    fn regex_filter_works() {
        let spec = FilterSpec {
            keywords: vec![],
            regex: Some(r"uid=\d+".to_string()),
            case_sensitive: false,
        };
        let f = Filter::new(spec);
        assert!(f.matches("login uid=12345"));
        assert!(!f.matches("login uid=abc"));
    }

    #[test]
    fn oversized_regex_is_rejected() {
        let huge = "a".repeat(600);
        let spec = FilterSpec {
            keywords: vec![],
            regex: Some(huge),
            case_sensitive: false,
        };
        // 超长正则被拒绝 => 空过滤，全命中（不崩溃）。
        let f = Filter::new(spec);
        assert!(f.matches("any"));
    }

    /// 正文搜索靠 `is_active()` 决定范围（过滤后的行 vs 整个文件）。
    /// 编译失败的正则会被静默丢弃，此时视图本身就是全量，
    /// 因此必须报告「未过滤」，否则搜索会把整文件的内容当成过滤结果来搜。
    #[test]
    fn is_active_is_false_when_regex_fails_to_compile() {
        // 正常编译的正则 => 真的在过滤。
        let ok = Filter::new(FilterSpec {
            keywords: vec![],
            regex: Some(r"uid=\d+".to_string()),
            case_sensitive: false,
        });
        assert!(ok.is_active());

        // 关键词同样算「在过滤」。
        let kw = Filter::new(FilterSpec {
            keywords: vec!["error".to_string()],
            regex: None,
            case_sensitive: false,
        });
        assert!(kw.is_active());

        // 非法正则被丢弃 => 空过滤 => 未过滤（视图全量）。
        let bad = Filter::new(FilterSpec {
            keywords: vec![],
            regex: Some("(".to_string()),
            case_sensitive: false,
        });
        assert!(bad.matches("anything"), "空过滤应全命中");
        assert!(!bad.is_active(), "正则编译失败后不应报告为「在过滤」");

        // 超长正则会同上被丢弃。
        let huge = Filter::new(FilterSpec {
            keywords: vec![],
            regex: Some("a".repeat(600)),
            case_sensitive: false,
        });
        assert!(!huge.is_active());

        // 空条件 => 未过滤。
        assert!(!Filter::new(FilterSpec::default()).is_active());
    }

    #[test]
    fn keyword_with_spaces_matches_exact_phrase() {
        // 带空格的关键词应作为「完整短语」做子串匹配，而非被拆成多个词。
        let spec = FilterSpec {
            keywords: vec!["database error".to_string()],
            regex: None,
            case_sensitive: false,
        };
        let f = Filter::new(spec);
        assert!(f.matches("2026/01/01 a database error occurred"));
        assert!(f.matches("DATABASE ERROR found"));
        // 单独的 database 或 error（非连续短语）不应命中。
        assert!(!f.matches("database is healthy"));
        assert!(!f.matches("an error happened"));
    }

    /// 性能探针（带 --nocapture 运行查看）：过滤 10 万行的耗时。
    #[test]
    fn perf_probe_filter_100k() {
        use std::time::Instant;
        let mut lines: Vec<String> = Vec::with_capacity(100_000);
        for i in 0..100_000 {
            lines.push(format!(
                "2026-01-01 12:00:00.000 [{}] [module{}] message id={} value={}",
                ["INFO", "DEBUG", "WARN", "ERROR"][i % 4],
                i % 20,
                i,
                i * 7
            ));
        }

        let spec = FilterSpec {
            keywords: vec!["error".to_string(), "warn".to_string()],
            regex: None,
            case_sensitive: false,
        };
        let f = Filter::new(spec);

        let t = Instant::now();
        let mut hits = 0usize;
        for l in &lines {
            if f.matches(l) {
                hits += 1;
            }
        }
        let el = t.elapsed();
        eprintln!("[perf] AC keyword filter 100k lines: {:?}, hits={}", el, hits);

        // 对比：显式 lowercase（模拟无 ascii_case_insensitive 时的分配开销）。
        let t2 = Instant::now();
        let mut allocs = 0usize;
        for l in &lines {
            let lower = l.to_lowercase(); // 每行一次堆分配
            if lower.contains("error") || lower.contains("warn") {
                allocs += 1;
            }
        }
        eprintln!("[perf] to_lowercase+contains 100k: {:?}, hits={}", t2.elapsed(), allocs);

        // 正则过滤（如果用户用正则过滤）。
        let t3 = Instant::now();
        let re = regex::Regex::new(r"error|warn").unwrap();
        let mut rehits = 0usize;
        for l in &lines {
            if re.is_match(l) {
                rehits += 1;
            }
        }
        eprintln!("[perf] regex filter 100k: {:?}, hits={}", t3.elapsed(), rehits);
    }
}
