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
    /// 是否大小写敏感。
    case_sensitive: bool,
}

impl Filter {
    pub fn new(spec: FilterSpec) -> Self {
        let ac = if spec.keywords.is_empty() {
            None
        } else {
            let patterns: Vec<String> = if spec.case_sensitive {
                spec.keywords.clone()
            } else {
                spec.keywords.iter().map(|k| k.to_lowercase()).collect()
            };
            AhoCorasick::builder()
                .match_kind(aho_corasick::MatchKind::Standard)
                .build(&patterns)
                .ok()
        };

        let re = match &spec.regex {
            // 限制正则长度，防止灾难性回溯。
            Some(p) if (!p.is_empty() && p.len() <= 512) => Regex::new(p).ok(),
            _ => None,
        };

        Self {
            ac,
            re,
            case_sensitive: spec.case_sensitive,
        }
    }

    /// 判断一行文本是否命中过滤条件（空条件 = 全命中）。
    pub fn matches(&self, text: &str) -> bool {
        // 无任何条件 => 所有行都命中。
        if self.ac.is_none() && self.re.is_none() {
            return true;
        }

        if let Some(ac) = &self.ac {
            let haystack = if self.case_sensitive {
                text.to_string()
            } else {
                text.to_lowercase()
            };
            if ac.is_match(&haystack) {
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
}
