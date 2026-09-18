/**
 * EncodingModal.tsx — 编码选择弹窗（左侧编码列表 + 右侧实时预览）。
 *
 * 为什么要有预览：换编码是**猜**。「GBK 还是 GB18030 还是 Big5」这种问题，
 * 光看编码名判断不出来；把「用这个编码解出来长什么样」摆在旁边，用户一眼就能
 * 挑对那个能读出中文的方案 —— 这也是 VSCode「Reopen with Encoding」的做法。
 *
 * 预览实现：拿同一个 `read_text_file` 命令读文件头部若干字节（后端已按所选编码
 * 解码），前端只负责截前十几行。不新增后端命令，也不读整篇文件。
 *
 * 交互：选中即预览（无额外确认），底部「应用」才真正重载文件 —— 换编码要重启
 * 后端会话并整体替换视图（滚动位置会丢），值得一次显式确认。
 * 文案自带中英文（与 `src/settings` 一致）。
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { ViewLang } from "../views/body-view.ts";
import {
  loadEncodingPreview,
  loadEncodingOptions,
  type EncodingPreview,
} from "./encoding-ipc.ts";
import "./statusbar.css";
import {
  AUTO_ID,
  encodingFullLabel,
  groupOptions,
  looksGarbled,
  previewLines,
  type EncodingInfo,
  type EncodingOption,
} from "./encoding.ts";

interface EncodingModalProps {
  /** 界面语言。 */
  lang: ViewLang;
  /** 目标文件路径（预览读它）。 */
  path: string;
  /** 当前生效的编码（首屏选中 + 底部对照）。 */
  current: EncodingInfo | null;
  /** 上一次「应用」的失败信息；非空时显示在底部（弹窗保持打开，可改选或取消）。 */
  error?: string | null;
  /** 正在重载（禁用「应用」，避免连点触发多次重载）。 */
  busy?: boolean;
  /** 点「应用」：由 App 去调后端重载（成功后由 App 关闭弹窗）。 */
  onApply: (id: string) => void;
  onClose: () => void;
}

const TEXT = {
  zh: {
    title: "文件编码",
    close: "关闭",
    closeHint: "Esc 关闭",
    auto: "自动检测",
    autoNote: "按 BOM 与内容判定",
    groupAuto: "自动",
    groups: {
      unicode: "Unicode",
      chinese: "中文",
      japanese: "日文",
      korean: "韩文",
      western: "西文",
      other: "其它",
    } as Record<string, string>,
    preview: "预览",
    previewLoading: "正在读取…",
    previewEmpty: "（文件为空）",
    previewFailed: "预览不可用（文件读取失败或后端不可用）",
    garbled: "该编码下有不少字节无法解码",
    currentLabel: "当前",
    apply: "应用并重新加载",
    cancel: "取消",
    applyHint: "切换编码会用新编码重新读取文件，滚动位置会回到文件尾部。",
    loadFailed: "读取编码列表失败：仅「自动检测」可用",
  },
  en: {
    title: "File Encoding",
    close: "Close",
    closeHint: "Esc to close",
    auto: "Auto-detect",
    autoNote: "Decided by BOM and content",
    groupAuto: "Auto",
    groups: {
      unicode: "Unicode",
      chinese: "Chinese",
      japanese: "Japanese",
      korean: "Korean",
      western: "Western",
      other: "Other",
    } as Record<string, string>,
    preview: "Preview",
    previewLoading: "Reading…",
    previewEmpty: "(empty file)",
    previewFailed: "Preview unavailable (read failed or backend offline)",
    garbled: "Many bytes can't be decoded with this encoding",
    currentLabel: "Current",
    apply: "Apply and reload",
    cancel: "Cancel",
    applyHint: "Switching re-reads the file with the new encoding; the scroll position returns to the end.",
    loadFailed: "Failed to load the encoding list — only Auto-detect is available",
  },
};

/** 预览显示的行数。 */
const PREVIEW_ROWS = 14;

/** 路径末段（文件名），路径为空时返回空串。 */
function baseName(path: string): string {
  const m = /[^\\/]+$/.exec(path);
  return m ? m[0] : path;
}

export function EncodingModal(props: EncodingModalProps) {
  const { lang, path, current, error, busy, onApply, onClose } = props;
  const t = TEXT[lang];

  /** 用户当前的选择（`auto` 或目录 id）。 */
  const [selected, setSelected] = useState<string>(current?.choice || AUTO_ID);
  const [options, setOptions] = useState<EncodingOption[] | null>(null);
  const [optionsFailed, setOptionsFailed] = useState(false);
  const [preview, setPreview] = useState<EncodingPreview | null>(null);
  const [loading, setLoading] = useState(true);

  // 取目录：拿不到后端时只留「自动」一项（弹窗仍可用、不崩）。
  useEffect(() => {
    let alive = true;
    void loadEncodingOptions().then((list) => {
      if (!alive) {
        return;
      }
      setOptions(list);
      setOptionsFailed(list === null);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 预览：选中项一变就重读。用序号挡掉乱序返回（快速连点多个编码时，
  // 先发的请求可能后到，会把旧编码的预览盖在新选择上）。
  const token = useRef(0);
  useEffect(() => {
    const mine = (token.current += 1);
    setLoading(true);
    void loadEncodingPreview(path, selected).then((result) => {
      if (token.current !== mine) {
        return;
      }
      setPreview(result);
      setLoading(false);
    });
  }, [path, selected]);

  // Esc 关闭。
  //
  // 与设置页那几个模态框（冒泡阶段、不拦截）不同，这里用**捕获**阶段并吃掉事件：
  // 编码弹窗可以叠在别的浮层之上打开（例如日志页的 Ctrl+F 查找框还开着时点状态栏），
  // 冒泡的话一次 Esc 会把两层一起关掉 —— 用户以为只关了最上面那个。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const groups = useMemo(() => groupOptions(options ?? []), [options]);
  const rows = useMemo(
    () =>
      preview ? previewLines(preview.text, PREVIEW_ROWS, preview.truncated) : [],
    [preview]
  );
  const garbled = useMemo(
    () => (preview ? looksGarbled(preview.text) : false),
    [preview]
  );

  /** 选中项与「当前生效的选择」一致时无事可做。 */
  const dirty = selected !== (current?.choice || AUTO_ID);

  const groupLabel = (key: string) => t.groups[key] ?? t.groups.other;

  /** 一个编码项：名字 + 别名（别名可能为空）。 */
  const renderItem = (id: string, label: string, note: string) => (
    <button
      key={id}
      type="button"
      // 列表容器声明了 role="listbox"，选项就得跟上 role="option" + aria-selected，
      // 否则读屏软件只会念出一串没有状态的按钮。
      role="option"
      aria-selected={selected === id}
      className={`encoding-item${selected === id ? " selected" : ""}`}
      onClick={() => setSelected(id)}
      title={note ? `${label} · ${note}` : label}
    >
      <span className="encoding-item-name">{label}</span>
      {note ? <span className="encoding-item-note">{note}</span> : null}
    </button>
  );

  return (
    <div className="body-modal-overlay" onClick={onClose}>
      <div
        className="encoding-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="encoding-header">
          <span className="encoding-title">{t.title}</span>
          <span className="encoding-file" title={path}>
            {baseName(path)}
          </span>
          <span className="encoding-spacer" />
          <button className="encoding-close" onClick={onClose} title={t.closeHint}>
            ✕
          </button>
        </div>

        <div className="encoding-body">
          <div className="encoding-list" role="listbox" aria-label={t.title}>
            <div className="encoding-group">{t.groupAuto}</div>
            {renderItem(AUTO_ID, t.auto, t.autoNote)}
            {groups.map((g) => (
              <div key={g.group}>
                <div className="encoding-group">{groupLabel(g.group)}</div>
                {g.items.map((o) => renderItem(o.id, o.name, o.note))}
              </div>
            ))}
            {optionsFailed ? <div className="encoding-note">{t.loadFailed}</div> : null}
          </div>

          <div className="encoding-preview">
            <div className="encoding-preview-head">
              <span>{t.preview}</span>
              {garbled ? <span className="encoding-preview-warn">{t.garbled}</span> : null}
            </div>
            <pre className="encoding-preview-body">
              {loading
                ? t.previewLoading
                : preview === null
                  ? t.previewFailed
                  : rows.length === 0
                    ? t.previewEmpty
                    : rows.join("\n")}
            </pre>
          </div>
        </div>

        <div className="encoding-footer">
          <span className="encoding-current" title={current ? encodingFullLabel(current) : ""}>
            {t.currentLabel}: {current ? encodingFullLabel(current) : "—"}
          </span>
          <span className="encoding-spacer" />
          {error ? <span className="encoding-error">{error}</span> : null}
          {!error ? <span className="encoding-hint">{t.applyHint}</span> : null}
          <button className="encoding-btn" onClick={onClose}>
            {t.cancel}
          </button>
          <button
            className="encoding-btn primary"
            disabled={!dirty || busy}
            onClick={() => onApply(selected)}
          >
            {t.apply}
          </button>
        </div>
      </div>
    </div>
  );
}
