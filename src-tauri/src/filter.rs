//! 实时文本过滤：多关键词 Aho-Corasick 匹配（热路径），可选正则兜底。
//!
//! 过滤发生在后端（Rust），前端只接收「已命中」的行，保证：
//!   - 增量读取 + 增量过滤 + 增量渲染全部增量化
//!   - 高频追加时过滤不在 JS 单线程里成为瓶颈

use aho_corasick::AhoCorasick;
use regex::Regex;

/// 过滤条件。
#[derive(Debug, Clone, Default)]
pub struct FilterSpec {
    /// 普通关键词列表（OR 关系，大小写不敏感）。
    pub keywords: Vec<String>,
    /// 可选的正则表达式（编译后的）。
    pub regex: Option<String>,
    /// 是否大小写敏感（默认 false，即不敏感）。
    pub case_sensitive: bool,
}

/// 已编译的过滤器。
pub struct Filter {
    /// Aho-Corasick 多模式匹配器。
    ac: Option<AhoCorasick>,
    /// 正则（带回溯保护，限制长度）。
    re: Option<Regex>,
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

        Self { ac, re }
    }

    /// 判断一行文本是否命中过滤条件（空条件 = 全命中）。
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
