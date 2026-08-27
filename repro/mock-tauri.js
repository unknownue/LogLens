// 浏览器复现专用：在页面脚本运行前注入 window.__TAURI_INTERNALS__，
// 模拟后端 open_log_file / get_lines / load_history / set_filter / plugin:dialog|open。
//
// 用法：
//   1. pnpm run dev（Vite 5173 端口）
//   2. 临时把被测日志复制到 public/（如 public/log_inst21.txt，模拟后端读取它），
//      复现完务必删除——Vite 会把 public/ 整体打进产物，release exe 会内嵌大日志。
//   3. 浏览器打开 http://127.0.0.1:5173，并在页面脚本运行前注入本文件
//      （Chrome DevTools MCP 的 navigate_page initScript，或复制进控制台后刷新）。
(() => {
  const CMD_OPEN = "open_log_file";
  const CMD_LINES = "get_lines";
  const CMD_HIST = "load_history";
  const CMD_JUMP = "jump_to_line";
  const CMD_FILTER = "set_filter";
  const CMD_CLOSE = "close_tab";
  const CMD_LISTEN = "plugin:event|listen";
  const CMD_UNLISTEN = "plugin:event|unlisten";
  const CMD_DIALOG = "plugin:dialog|open";

  // 与后端 init_tail(2000) 行为对齐：先加载尾部约 2000 行。
  const TAIL_LINES = 2000;
  const HISTORY_ROWS = 2000;

  const tabs = new Map();
  const eventHandlers = new Map(); // eventName -> callback id（transformCallback 存到 window[`_${id}`]）
  let allLinesPromise = null;

  function emitEvent(event, payload) {
    const id = eventHandlers.get(event);
    if (id == null) return;
    const fn = window[`_${id}`];
    if (typeof fn === "function") {
      // 真实后端异步派发，避免在 invoke 解析过程中同步重入。
      setTimeout(() => fn({ event, payload }), 0);
    }
  }

  function getAllLines() {
    if (!allLinesPromise) {
      allLinesPromise = fetch("/log_inst21.txt")
        .then((r) => r.text())
        .then((t) => {
          const arr = t.split("\n");
          if (arr.length && arr[arr.length - 1] === "") arr.pop();
          console.log("[mock] log lines loaded:", arr.length);
          return arr;
        });
    }
    return allLinesPromise;
  }

  async function invoke(cmd, args = {}) {
    switch (cmd) {
      case CMD_DIALOG: {
        return "E:\\Work\\GM10\\qa_branch\\code\\client_csharp\\log_inst21.txt";
      }
      case CMD_OPEN: {
        const all = await getAllLines();
        const start = Math.max(0, all.length - TAIL_LINES);
        const lines = all.slice(start).map((text, i) => ({
          file_offset: start + i,
          file_line: start + i + 1,
          text,
        }));
        tabs.set(args.tabId, { lines, histStart: start, histCounter: 0 });
        console.log("[mock] open_log_file", args.tabId, "tail lines:", lines.length);
        // 与真实后端一致：打开后以 reset 事件下发初始行。
        emitEvent("log-lines", { tab_id: args.tabId, lines, reset: true });
        return null;
      }
      case CMD_LINES: {
        const t = tabs.get(args.tabId);
        return t ? t.lines : [];
      }
      case CMD_HIST: {
        const all = await getAllLines();
        const t = tabs.get(args.tabId);
        if (!t || t.histStart <= 0) return { lines: [], has_more: false };
        const end = t.histStart;
        const start = Math.max(0, end - (args.rows || HISTORY_ROWS));
        // 修复后复刻真实后端：历史行 offset 为小的负 i64（JSON/JS 精度无损，key 唯一）。
        const slice = all.slice(start, end).map((text, i) => ({
          file_offset: -(t.histCounter + i + 1),
          file_line: start + i + 1,
          text,
        }));
        t.histCounter += slice.length;
        t.histStart = start;
        t.lines = [...slice, ...t.lines];
        console.log("[mock] load_history", args.tabId, "start:", start, "rows:", slice.length, "more:", start > 0);
        return { lines: slice, has_more: start > 0 };
      }
      case CMD_JUMP: {
        // 与后端 jump_to_line 相同的窗口规则：前后各 1500 行；距 EOF ≤ 50000 行时延伸到 EOF。
        const all = await getAllLines();
        const t = tabs.get(args.tabId);
        if (!t) throw new Error("tab 不存在");
        const total = all.length;
        const line = args.lineNo ?? args.line; // Tauri camelCase：line_no → lineNo
        if (!Number.isInteger(line) || line < 1) throw new Error("行号必须 ≥ 1");
        if (line > total) throw new Error(`行号超出范围：文件共 ${total} 行`);
        const target = line - 1;
        const half = 1500;
        let start = Math.max(0, target - half);
        let end = Math.min(total, target + half);
        if (total - start <= 50000) end = total;
        const slice = all.slice(start, end).map((text, i) => ({
          file_offset: 1_000_000 + i,
          file_line: start + i + 1,
          text,
        }));
        t.histStart = start;
        t.lines = slice;
        console.log("[mock] jump", line, "window:", start, "-", end, "total:", total);
        return {
          lines: slice,
          target_index: target - start,
          target_visible: true,
          total_lines: total,
          has_more: start > 0,
          first_line_no: start + 1,
        };
      }
      case CMD_FILTER:
        console.log("[mock] set_filter", args);
        return null;
      case CMD_CLOSE:
        tabs.delete(args.tabId);
        return null;
      case CMD_LISTEN: {
        // listen('log-lines')：真实后端通过 events 表分发。记录 handler id，返回事件 id。
        const ev = args.event || args.target;
        if (ev) eventHandlers.set(ev, args.handler);
        return Promise.resolve(Math.floor(Math.random() * 1e9));
      }
      case CMD_UNLISTEN: {
        return Promise.resolve();
      }
      default:
        console.warn("[mock] unknown invoke:", cmd, args);
        return Promise.resolve(null);
    }
  }

  window.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: (callback, once) => {
      const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      const prop = `_${id}`;
      Object.defineProperty(window, prop, {
        value: (result) => {
          if (once) delete window[prop];
          return callback?.(result);
        },
        writable: false,
        configurable: true,
      });
      return id;
    },
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main", windowLabel: "main" },
    },
    convertFileSrc: (filePath, protocol) => `${protocol}://localhost/${filePath}`,
  };
  window.isTauri = true;
})();
