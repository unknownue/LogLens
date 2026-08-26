import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";

/** 一行日志（与后端 LogLine 对应）。 */
interface LogLine {
  file_offset: number;
  text: string;
}

/** 后端 log-lines 事件负载。 */
interface LinesPayload {
  lines: LogLine[];
  reset: boolean;
}

function App() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [filePath, setFilePath] = useState<string>("");
  const [keywordInput, setKeywordInput] = useState("");
  const [regexInput, setRegexInput] = useState("");
  const [followTail, setFollowTail] = useState(true);
  const [status, setStatus] = useState("未打开文件");
  const listRef = useRef<HTMLDivElement>(null);

  // 虚拟滚动：只渲染可视区 + 缓冲行，保证几十万行恒定性能。
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 20, // 每行约 20px
    overscan: 10,
  });

  // 监听后端推送的增量日志。
  useEffect(() => {
    const unlisten = listen<LinesPayload>("log-lines", (event) => {
      const { lines: newLines, reset } = event.payload;
      setLines((prev) => (reset ? newLines : [...prev, ...newLines]));
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // 尾部跟随：当 followTail 为 true 且行数变化时，滚动到底部。
  useEffect(() => {
    if (followTail && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [lines.length, followTail]);

  // 打开文件：弹出原生对话框。
  const handleOpen = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "日志文件", extensions: ["log", "txt", "*"] }],
    });
    if (typeof selected === "string") {
      try {
        await invoke("open_log_file", { path: selected });
        setFilePath(selected);
        setStatus("已打开，监控尾部...");
      } catch (e) {
        setStatus(`打开失败: ${e}`);
      }
    }
  }, []);

  // 应用过滤：把关键词/正则下发到后端，后端重扫返回命中集。
  const applyFilter = useCallback(async () => {
    const keywords = keywordInput
      .split(/\s+/)
      .map((k) => k.trim())
      .filter(Boolean);
    const regex = regexInput.trim() || null;
    try {
      const matched = await invoke<LogLine[]>("set_filter", {
        keywords,
        regex,
        caseSensitive: false,
      });
      setLines(matched);
    } catch (e) {
      setStatus(`过滤失败: ${e}`);
    }
  }, [keywordInput, regexInput]);

  // 键盘回车触发过滤。
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      applyFilter();
    }
  };

  return (
    <div className="logviewer">
      <header className="toolbar">
        <button onClick={handleOpen}>打开日志文件</button>
        <input
          className="path"
          value={filePath}
          readOnly
          placeholder="（未选择文件）"
        />
        <label className="follow">
          <input
            type="checkbox"
            checked={followTail}
            onChange={(e) => setFollowTail(e.target.checked)}
          />
          跟随尾部
        </label>
      </header>

      <div className="filterbar">
        <input
          className="keyword"
          value={keywordInput}
          onChange={(e) => setKeywordInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="关键词（空格分隔，OR）"
        />
        <input
          className="regex"
          value={regexInput}
          onChange={(e) => setRegexInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="正则（可选）"
        />
        <button onClick={applyFilter}>过滤</button>
        <span className="status">{status}</span>
        <span className="count">{lines.length} 行</span>
      </div>

      <div className="list" ref={listRef}>
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((vi) => {
            const line = lines[vi.index];
            return (
              <div
                key={vi.key}
                className="row"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: `${vi.size}px`,
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                <span className="lineno">{vi.index + 1}</span>
                <span className="text">{line.text}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default App;
