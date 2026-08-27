//! 增量 tail-follow：按字节偏移增量读取日志文件尾部，处理换行边界与文件轮转。

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

// Windows 下需要 OpenOptionsExt 以使用 .share_mode()（FILE_SHARE_* 共享打开）。
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;

/// 上次读取到的字节偏移与「未完整行」的残留缓冲。
pub struct TailReader {
    path: PathBuf,
    file: Option<File>,
    /// 已消费到的文件字节偏移。
    offset: u64,
    /// 上一次读取时末尾残留的不完整行（尚未读到换行符的部分）。
    pending: Vec<u8>,
    /// 文件当前大小（用于检测 truncate / 轮转）。
    last_size: u64,
    /// 是否首次打开（首次应从尾部加载而非从头）。
    first_open: bool,
}

#[derive(Debug, Clone)]
pub enum TailEvent {
    /// 一批新行（已按行切分，完整行）。
    Lines(Vec<String>),
    /// 文件被截断/轮转，视图需要清空重建。
    Reset,
}

impl TailReader {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            file: None,
            offset: 0,
            pending: Vec::new(),
            last_size: 0,
            first_open: true,
        }
    }

    /// 打开文件（以共享读写删除模式打开，容忍写入进程独占部分权限）。
    fn open_shared(&mut self) -> std::io::Result<()> {
        let f = OpenOptions::new()
            .read(true)
            .write(false)
            .share_mode(0x7) // FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
            .open(&self.path)?;
        self.file = Some(f);
        Ok(())
    }

    /// 初始化：定位到文件末尾（首屏显示最新日志），返回现有尾部若干行。
    pub fn init_tail(&mut self, tail_lines: u64) -> std::io::Result<Vec<String>> {
        self.open_shared()?;
        let size = self.file.as_ref().unwrap().metadata()?.len();
        self.last_size = size;

        // 从尾部向前读取 tail_lines 行（近似：从末尾回溯最多 tail_lines * 200 字节再切行）。
        let mut file = self.file.take().unwrap();
        let approx = (tail_lines.saturating_mul(256)).max(8192).min(size);
        let start = size - approx;
        file.seek(SeekFrom::Start(start))?;
        let mut buf = Vec::with_capacity(approx as usize);
        file.read_to_end(&mut buf)?;

        self.offset = size;
        self.first_open = false;
        self.file = Some(file);

        let mut lines: Vec<String> = split_lines(&buf);
        // 首行可能是不完整的（从中间开始），丢弃。
        if start > 0 && !lines.is_empty() {
            lines.remove(0);
        }
        Ok(lines)
    }

    /// 读取自上次 offset 以来的新内容，返回新完整行；检测到截断返回 Reset。
    pub fn poll(&mut self) -> std::io::Result<Vec<TailEvent>> {
        if self.file.is_none() {
            // 文件可能被轮转删除后尚未重建，尝试重开。
            if self.open_shared().is_err() {
                return Ok(Vec::new());
            }
        }

        let size = match self.file.as_ref().unwrap().metadata() {
            Ok(m) => m.len(),
            Err(_) => {
                // 文件句柄失效（被删除），标记重开并返回 Reset。
                self.file = None;
                return Ok(vec![TailEvent::Reset]);
            }
        };

        // 截断/轮转检测：文件变小，或首次打开后 offset 超过大小。
        if size < self.offset {
            self.offset = 0;
            self.pending.clear();
            self.last_size = size;
            return Ok(vec![TailEvent::Reset]);
        }

        if size <= self.offset {
            // 无新数据。
            return Ok(Vec::new());
        }

        let file = self.file.as_mut().unwrap();
        file.seek(SeekFrom::Start(self.offset))?;
        let mut buf = vec![0u8; (size - self.offset) as usize];
        file.read_exact(&mut buf)?;
        self.offset = size;
        self.last_size = size;

        // 拼接残留 + 新数据，再按行切分。
        let mut combined = std::mem::take(&mut self.pending);
        combined.extend_from_slice(&buf);

        let (complete, leftover) = split_with_pending(&combined);
        self.pending = leftover;

        if complete.is_empty() {
            return Ok(Vec::new());
        }
        Ok(vec![TailEvent::Lines(complete)])
    }

    /// 强制重开（轮转后调用）。
    pub fn reopen(&mut self) -> std::io::Result<()> {
        self.file = None;
        self.offset = 0;
        self.pending.clear();
        self.open_shared()?;
        let size = self.file.as_ref().unwrap().metadata()?.len();
        self.offset = size;
        self.last_size = size;
        Ok(())
    }
}

/// 把 buffer 切成完整行（Vec<String>），返回剩余的「未以换行结尾」的残片。
fn split_with_pending(buf: &[u8]) -> (Vec<String>, Vec<u8>) {
    let mut lines = Vec::new();
    let mut start = 0usize;
    for (i, &b) in buf.iter().enumerate() {
        if b == b'\n' {
            let mut line = &buf[start..i];
            // 去掉 \r
            if line.last() == Some(&b'\r') {
                line = &line[..line.len() - 1];
            }
            lines.push(String::from_utf8_lossy(line).into_owned());
            start = i + 1;
        }
    }
    let leftover = buf[start..].to_vec();
    (lines, leftover)
}

fn split_lines(buf: &[u8]) -> Vec<String> {
    split_with_pending(buf).0
}

/// 行数据模型：传给前端的一行。
#[derive(Debug, Clone, serde::Serialize)]
pub struct LogLine {
    /// 稳定文件字节偏移（用于「跳转到源文件该行」等定位）。
    pub file_offset: u64,
    /// 该行文本。
    pub text: String,
}

impl LogLine {
    pub fn new(file_offset: u64, text: String) -> Self {
        Self { file_offset, text }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 写一个临时文件并返回 TailReader。
    fn make_reader(content: &str) -> (TailReader, tempfile::NamedTempFile) {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(content.as_bytes()).unwrap();
        f.flush().unwrap();
        let path = f.path().to_path_buf();
        let reader = TailReader::new(path);
        (reader, f)
    }

    #[test]
    fn splitting_handles_crlf_and_partial_lines() {
        let (complete, leftover) = split_with_pending(b"line1\r\nline2\npartial");
        assert_eq!(complete, vec!["line1".to_string(), "line2".to_string()]);
        assert_eq!(leftover, b"partial");
    }

    #[test]
    fn poll_detects_truncation() {
        let (mut reader, mut f) = make_reader("aaa\nbbb\n");
        let evts = reader.poll().unwrap();
        // 首次 poll 从 offset 0 读到全部 2 行。
        let lines: Vec<String> = evts
            .into_iter()
            .filter_map(|e| match e {
                TailEvent::Lines(l) => Some(l.join(",")),
                _ => None,
            })
            .collect();
        assert_eq!(lines, vec!["aaa,bbb"]);

        // 截断文件，重新写入更短内容。
        use std::io::Seek;
        let fh = f.as_file_mut();
        fh.seek(std::io::SeekFrom::Start(0)).unwrap();
        fh.set_len(0).unwrap();
        fh.write_all(b"x\n").unwrap();
        fh.flush().unwrap();

        let evts = reader.poll().unwrap();
        assert!(evts.iter().any(|e| matches!(e, TailEvent::Reset)));
    }

    #[test]
    fn poll_appends_only_new_bytes() {
        let (mut reader, mut f) = make_reader("first\n");
        let _ = reader.poll().unwrap();

        // 追加两行。
        use std::io::Seek;
        let fh = f.as_file_mut();
        fh.seek(std::io::SeekFrom::End(0)).unwrap();
        fh.write_all(b"second\nthird\n").unwrap();
        fh.flush().unwrap();

        let evts = reader.poll().unwrap();
        let mut all = Vec::new();
        for e in evts {
            if let TailEvent::Lines(l) = e {
                all.extend(l);
            }
        }
        // 只应返回新增的 second/third，而非 first。
        assert_eq!(all, vec!["second".to_string(), "third".to_string()]);
    }

    /// 模拟真实场景：init_tail 后用「另一个独立句柄」追加（类似另一个进程写日志），
    /// 验证 poll 能否通过 metadata().len() 看到新大小并读回增量。
    #[test]
    fn poll_after_init_tail_sees_external_append() {
        use std::io::Write;

        // 先写初始内容（用第一个句柄，写完关闭）。
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(b"line1\nline2\nline3\n").unwrap();
        f.flush().unwrap();
        let path = f.path().to_path_buf();

        // TailReader 独立打开 + init_tail（模拟应用启动）。
        let mut reader = TailReader::new(path.clone());
        let initial = reader.init_tail(1000).unwrap();
        assert_eq!(initial, vec!["line1".to_string(), "line2".to_string(), "line3".to_string()]);

        // 模拟另一个进程：用 append 模式打开独立句柄追加。
        {
            let mut appender = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
            appender.write_all(b"line4\nline5\n").unwrap();
            appender.flush().unwrap();
            // appender drop 关闭
        }

        // poll 应能看到新大小并读回 line4/line5。
        let evts = reader.poll().unwrap();
        let mut all = Vec::new();
        for e in evts {
            if let TailEvent::Lines(l) = e {
                all.extend(l);
            }
        }
        assert_eq!(all, vec!["line4".to_string(), "line5".to_string()]);
    }
}
