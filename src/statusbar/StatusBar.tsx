/**
 * StatusBar.tsx — 窗口底部的状态栏。
 *
 * 放什么、不放什么：
 * - **行数**：从工具栏右上角搬到这里（同一个 `activeTotal` 上报通道，见 App 的
 *   `reportTotal`）。它是一条「跟文件有关、跟操作无关」的只读信息，属于状态栏；
 *   工具栏右上角留给真正要点的按钮。
 * - **编码**：本功能新增。文件按什么编码解出来的，是排查「中文全是问号」的第一
 *   线索，而它必须能**点**（点开编码弹窗切换）。
 *
 * 一条设计约定：状态栏**永远显示**，即使一个 tab 都没开。它只有 24px 高，
 * 有它在窗口底部收边，比「打开文件后才突然多出一条」稳定得多。
 *
 * 文案自带中英文（与 `src/settings`、`src/views` 一致：statusbar → App 单向依赖）。
 */

import type { ViewLang } from "../views/body-view.ts";
import { encodingFullLabel, type EncodingInfo } from "./encoding.ts";
import "./statusbar.css";

interface StatusBarProps {
  /** 界面语言。 */
  lang: ViewLang;
  /** 当前激活 tab 的文件总行数；`null` = 尚未算出 / 不适用。 */
  total: number | null;
  /** 行数项的悬浮提示（说明这个数字是实时更新的）。 */
  totalTitle?: string;
  /** 当前激活 tab 的编码；`null` = 不适用（二进制表格）或尚未探测出。 */
  encoding: EncodingInfo | null;
  /** 是否有 tab 打开（没有时左侧显示「未打开文件」）。 */
  hasTab: boolean;
  /** 编码是否可切换（二进制表格视图不可）。 */
  canPickEncoding: boolean;
  /** 正在按新编码重新加载（禁止重复点）。 */
  busy: boolean;
  /** 点编码项：打开编码弹窗。 */
  onPickEncoding: () => void;
}

/** 千分位分组：不依赖 `toLocaleString`（它的结果随系统区域变化，E2E 断言会飘）。 */
export function formatCount(n: number): string {
  const s = Math.trunc(Math.abs(n)).toString();
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    if (i > 0 && (s.length - i) % 3 === 0) {
      out += ",";
    }
    out += s[i];
  }
  return n < 0 ? `-${out}` : out;
}

const TEXT = {
  zh: {
    lines: (n: string) => `${n} 行`,
    noLines: "行数 —",
    noFile: "未打开文件",
    encodingTitle: "文件编码 — 点击切换",
    encodingTitleDisabled: "二进制表格视图不按文本编码解码，无法切换",
    busy: "正在按新编码重新加载…",
    /** 编码是怎么定下来的：四项与后端 `encoding::Source` 对应。 */
    sourceBom: "由文件开头的 BOM 判定",
    sourceUtf8: "自动检测：内容是合法的 UTF-8",
    sourceFallback: "自动检测未能判定，按 GB18030 解码（可在右侧改）",
    sourceManual: "手动指定",
  },
  en: {
    lines: (n: string) => `${n} lines`,
    noLines: "Lines —",
    noFile: "No file open",
    encodingTitle: "File encoding — click to change",
    encodingTitleDisabled: "Binary table view is not decoded as text; encoding can't be changed",
    busy: "Reloading with the new encoding…",
    sourceBom: "From the BOM at the start of the file",
    sourceUtf8: "Auto-detected: the content is valid UTF-8",
    sourceFallback: "Auto-detection was inconclusive, decoded as GB18030 (change it on the right)",
    sourceManual: "Set manually",
  },
};

/** 探测依据 → 悬浮提示的补充说明（未知来源返回空串，不编造）。 */
function sourceHint(lang: ViewLang, info: EncodingInfo | null): string {
  const t = TEXT[lang];
  switch (info?.source) {
    case "bom":
      return t.sourceBom;
    case "utf8":
      return t.sourceUtf8;
    case "fallback":
      return t.sourceFallback;
    case "manual":
      return t.sourceManual;
    default:
      return "";
  }
}

export function StatusBar(props: StatusBarProps) {
  const { lang, total, totalTitle, encoding, hasTab, canPickEncoding, busy, onPickEncoding } =
    props;
  const t = TEXT[lang];

  const linesText = !hasTab
    ? t.noFile
    : total != null
      ? t.lines(formatCount(total))
      : t.noLines;

  const encTitle = [
    canPickEncoding ? t.encodingTitle : t.encodingTitleDisabled,
    encoding ? encodingFullLabel(encoding) : "",
    busy ? t.busy : "",
    sourceHint(lang, encoding),
  ]
    .filter((s) => s !== "")
    .join("\n");

  return (
    <footer className="statusbar">
      <div className="statusbar-side">
        <span className="statusbar-item statusbar-lines" title={totalTitle ?? linesText}>
          {linesText}
        </span>
      </div>
      <div className="statusbar-side statusbar-right">
        {busy ? <span className="statusbar-item statusbar-busy">{t.busy}</span> : null}
        <button
          type="button"
          className={`statusbar-item statusbar-encoding${canPickEncoding ? "" : " disabled"}`}
          onClick={onPickEncoding}
          disabled={!canPickEncoding || busy}
          title={encTitle}
          aria-haspopup="dialog"
        >
          <span className="statusbar-encoding-name">
            {encoding ? encodingFullLabel(encoding) : "—"}
          </span>
        </button>
      </div>
    </footer>
  );
}
