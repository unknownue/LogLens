/**
 * SettingsModal.tsx — 模态的设置页（外观 / 字体 / 字号 + 实时预览）。
 *
 * 交互约定（与工具栏的 A-/A+、主题按钮一致）：**改动立刻生效并持久化**，
 * 没有「确定 / 取消」两个按钮 —— 设置项都是可逆的即时观感调整，
 * 所见即所得比两段式确认更好用；想回到起点按「恢复默认设置」。
 *
 * 字体分「非中文字体 / 中文字体」两项，原理见 `font-catalog.ts` 头部注释：
 * 两者会被拼成一条 font-family 列表（西文在前、中文在后），浏览器逐字符回退，
 * 因此中英混排里的两种字形各走各的字体。预览区把三个视图（日志 / Markdown /
 * 表格）的典型内容并排摆出来，选择字体时能直接看出差异。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { ViewLang } from "../views/body-view.ts";
import { parseFamilyList, type FontRole } from "./font-catalog.ts";
import {
  buildFontGroups,
  catalogChoices,
  choicesFromSystem,
  filterChoices,
  findChoice,
  optionLabel,
  type FontChoice,
  type FontGroupKey,
} from "./font-options.ts";
import {
  familyProvidesCjk,
  isFamilyInstalled,
  isMonospaceFamily,
} from "./font-probe.ts";
import {
  DEFAULT_SETTINGS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  resolveFontStack,
  type AppSettings,
} from "./settings.ts";
import { loadSystemFonts, type SystemFontInfo } from "./system-fonts.ts";
import "./settings.css";

/** 下拉里代表「自定义…」的哨兵值（不会与字体族名冲突）。 */
const CUSTOM_OPTION = "__lv-custom__";

type Theme = "dark" | "light";

interface SettingsModalProps {
  /** 界面语言（模态框自己带中英文案，与 views 下的页面一致）。 */
  lang: ViewLang;
  settings: AppSettings;
  /** 局部更新（立即生效 + 持久化由 App 负责）。 */
  onChange: (patch: Partial<AppSettings>) => void;
  theme: Theme;
  onSetTheme: (theme: Theme) => void;
  onSetLang: (lang: ViewLang) => void;
  onClose: () => void;
}

/**
 * 界面文案（本模块自带中英文案，与 MarkdownView / CfgTableTab 一致：settings → App 单向依赖）。
 * 不加 `as const`：两个语言的键集与类型必须完全一致，`TEXT[lang]` 才是同一种类型。
 */
const TEXT = {
  zh: {
    title: "设置",
    appearance: "外观",
    theme: "主题",
    themeDark: "深色",
    themeLight: "浅色",
    language: "界面语言",
    fonts: "字体",
    fontsHint:
      "字体按字符回退：非中文字体排在前、中文字体排在后，中英混排时两种字形各走各的字体（同 Windows Terminal 的做法）。只用系统已安装的字体。",
    latinFont: "非中文字体",
    latinHint: "西文、数字、符号等（建议选等宽字体）",
    cjkFont: "中文字体",
    cjkHint: "中日韩字形（建议选带中文字形的等宽或黑体）",
    fontDefault: "默认（内置字体栈）",
    fontCustom: "自定义…",
    customPlaceholder: "字体族名，可用逗号分隔多个（按优先级从前往后）",
    fontSearchPlaceholder: "搜索字体名（中英文均可）",
    fontLoading: "正在读取系统字体…",
    fontCount: (n: number, source: string) => `${source} ${n} 个`,
    fontSourceSystem: "系统字体",
    fontSourceBuiltin: "内置候选（未连上后端）",
    fontNoMatch: (q: string) => `没有匹配「${q}」的字体`,
    groupMono: "等宽字体",
    groupCjk: "含中文字形",
    groupOther: "其它字体",
    noteMono: "等宽：列对齐与列宽估算准确",
    noteProportional: "比例字体：日志列对齐与表格列宽只能按估算值处理",
    noteCjkInLatin: "该字体自带中文字形，中文会先被它渲染 —— 想区分中西文请选纯西文字体",
    noteMissing: "未检测到该字体，实际渲染会回落到字体栈里后面的字体",
    fontSize: "正文字号",
    fontSizeUnit: "px",
    fontSizeReset: "默认",
    preview: "预览",
    previewLog: "日志视图",
    previewMd: "Markdown 视图",
    previewTable: "表格视图",
    stackLabel: "实际字体栈",
    reset: "恢复默认设置",
    close: "关闭",
    closeHint: "Esc 关闭",
  },
  en: {
    title: "Settings",
    appearance: "Appearance",
    theme: "Theme",
    themeDark: "Dark",
    themeLight: "Light",
    language: "Language",
    fonts: "Fonts",
    fontsHint:
      "Fonts fall back per character: the non-CJK family comes first, the CJK family second, so mixed text uses each family for its own glyphs (the same trick Windows Terminal uses). System fonts only — nothing is downloaded.",
    latinFont: "Non-CJK font",
    latinHint: "Latin letters, digits and symbols (a monospace face is recommended)",
    cjkFont: "CJK font",
    cjkHint: "Chinese / Japanese / Korean glyphs",
    fontDefault: "Default (built-in stack)",
    fontCustom: "Custom…",
    customPlaceholder: "Family names, comma-separated, highest priority first",
    fontSearchPlaceholder: "Search font name",
    fontLoading: "Loading system fonts…",
    fontCount: (n: number, source: string) => `${n} ${source}`,
    fontSourceSystem: "system fonts",
    fontSourceBuiltin: "built-in candidates (no backend)",
    fontNoMatch: (q: string) => `No font matches “${q}”`,
    groupMono: "Monospace",
    groupCjk: "With CJK glyphs",
    groupOther: "Other faces",
    noteMono: "Monospace: column alignment and width estimates stay exact",
    noteProportional: "Proportional: column alignment and table widths are estimates",
    noteCjkInLatin:
      "This face ships CJK glyphs, so Chinese text uses it first — pick a Latin-only face to keep the two apart",
    noteMissing: "Not detected on this machine: rendering falls back to the next family in the stack",
    fontSize: "Body font size",
    fontSizeUnit: "px",
    fontSizeReset: "Default",
    preview: "Preview",
    previewLog: "Log view",
    previewMd: "Markdown view",
    previewTable: "Table view",
    stackLabel: "Effective font stack",
    reset: "Reset to defaults",
    close: "Close",
    closeHint: "Esc to close",
  },
};

type Messages = (typeof TEXT)["zh"];

/** 分组的显示名（带条数：长列表里「等宽字体 · 41」比单独一个标题更有信息量）。 */
function groupLabel(key: FontGroupKey, count: number, t: Messages): string {
  const name =
    key === "mono" ? t.groupMono : key === "cjk" ? t.groupCjk : t.groupOther;
  return `${name} · ${count}`;
}

/** 一行「标签 + 控件」的骨架。 */
function Row(props: { label: string; children: ReactNode }) {
  return (
    <div className="settings-row">
      <span className="settings-label">{props.label}</span>
      <div className="settings-control">{props.children}</div>
    </div>
  );
}

/**
 * 单个字体项：系统字体下拉（带搜索）+ 自定义输入 + 实时提示。
 *
 * 下拉与输入是**同一个值的两种入口**：从列表里选中的字体显示在下拉里；
 * 手动输入（或多族栈）时下拉切到「自定义…」，输入框成为唯一事实来源。
 *
 * 列表默认是本机**所有**可用字体（后端 DirectWrite 枚举，通常两三百个），
 * 因此上面配一个搜索框：中文界面下按中文名或英文名都能搜到。后端不可用时
 * 自动回落到内置候选表（列表短一些，但设置页照常能用）。
 */
function FontField(props: {
  role: FontRole;
  label: string;
  hint: string;
  value: string;
  lang: ViewLang;
  t: Messages;
  /** 本机字体列表（null = 后端不可用，走内置候选表）；由模态框统一取一次。 */
  systemFonts: SystemFontInfo[] | null;
  loading: boolean;
  onChange: (value: string) => void;
}) {
  const { role, value, lang, t, onChange } = props;
  /** 用户主动选了「自定义…」但输入框还是空的：需要保留这个状态。 */
  const [customPicked, setCustomPicked] = useState(false);
  /** 搜索词（列表很长，没有它等于大海捞针）。 */
  const [query, setQuery] = useState("");

  /**
   * 候选：优先用系统字体集（后端 DirectWrite 枚举出来的这份就是「浏览器能用的全部字体」，
   * 等宽 / 中文字形也是字体自己声明的事实），拿不到才回落到内置候选表。
   */
  const choices = useMemo<FontChoice[]>(() => {
    if (props.systemFonts && props.systemFonts.length > 0) {
      return choicesFromSystem(props.systemFonts);
    }
    return catalogChoices(role, lang);
  }, [props.systemFonts, role, lang]);

  const groups = useMemo(() => buildFontGroups(filterChoices(choices, query), lang), [
    choices,
    query,
    lang,
  ]);

  const trimmed = value.trim();
  /**
   * 候选命中（忽略大小写 / 引号）：命中的话下拉直接显示它，否则切到「自定义…」。
   * 手输 `consolas` 这种大小写不一致的族名也应被认出来，不然下拉会显示成空项。
   */
  const hit = findChoice(choices, trimmed);
  const custom = customPicked || (trimmed !== "" && !hit);
  /** 下拉的当前值：候选命中就显示它的 family，否则显示「自定义…」。 */
  const selectValue = custom ? CUSTOM_OPTION : (hit?.family ?? trimmed);
  const total = choices.length;

  /**
   * 提示只针对第一个族名（多族栈的后续项由用户自己负责）。
   *
   * 字体的事实优先取自列表（系统字体集里就是 DirectWrite 问出来的权威答案），
   * 只有「手输了一个列表里没有的字体名」才会退回 canvas 探测 —— 那种情况下
   * 中文字形的判据是保守的（可能漏报，不会误报，见 font-probe.ts）。
   */
  const primary = parseFamilyList(trimmed)[0] ?? "";
  const known = primary ? findChoice(choices, primary) : undefined;
  const installed = known != null || isFamilyInstalled(primary);
  const mono = known ? known.mono : isMonospaceFamily(primary);
  const coversCjk = known ? known.cjk : familyProvidesCjk(primary);

  const notes: string[] = [];
  if (primary) {
    if (!installed) {
      notes.push(t.noteMissing);
    } else if (role === "latin") {
      // 非中文字体的两条关键提示：会不会吃掉中文 / 是不是等宽。
      notes.push(mono ? t.noteMono : t.noteProportional);
    }
    if (role === "latin" && coversCjk) {
      notes.push(t.noteCjkInLatin);
    }
  }

  return (
    <div className="settings-field" data-font-role={role}>
      <div className="settings-field-head">
        <span className="settings-label">{props.label}</span>
        <span className="settings-sub">{props.hint}</span>
      </div>
      {/* 搜索框：系统字体动辄两三百个，没有它只能在长列表里翻。 */}
      <div className="settings-search-row">
        <input
          className="settings-search"
          type="search"
          spellCheck={false}
          value={query}
          placeholder={t.fontSearchPlaceholder}
          aria-label={`${props.label} — ${t.fontSearchPlaceholder}`}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="settings-count">
          {props.loading
            ? t.fontLoading
            : t.fontCount(
                choices.length,
                props.systemFonts ? t.fontSourceSystem : t.fontSourceBuiltin
              )}
        </span>
      </div>
      <div className="settings-field-body">
        <select
          className="settings-select"
          value={selectValue}
          aria-label={props.label}
          onChange={(e) => {
            const next = e.target.value;
            if (next === CUSTOM_OPTION) {
              setCustomPicked(true);
              return;
            }
            setCustomPicked(false);
            onChange(next);
          }}
        >
          <option value="">{t.fontDefault}</option>
          {groups.map((group) => (
            <optgroup
              key={group.key}
              label={groupLabel(group.key, group.choices.length, t)}
            >
              {group.choices.map((c) => (
                <option key={c.family} value={c.family}>
                  {optionLabel(c)}
                </option>
              ))}
            </optgroup>
          ))}
          <option value={CUSTOM_OPTION}>{t.fontCustom}</option>
        </select>
        {custom ? (
          <input
            className="settings-input"
            type="text"
            spellCheck={false}
            value={value}
            placeholder={t.customPlaceholder}
            aria-label={`${props.label} (${t.fontCustom})`}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : null}
      </div>
      {/* 搜不到任何字体时说清楚是「这个词没匹配上」，而不是让下拉空着。 */}
      {total > 0 && groups.length === 0 ? (
        <div className="settings-note">{t.fontNoMatch(query)}</div>
      ) : null}
      {notes.filter(Boolean).map((note) => (
        <div className="settings-note" key={note}>
          {note}
        </div>
      ))}
    </div>
  );
}

export function SettingsModal(props: SettingsModalProps) {
  const { lang, settings, onChange, theme, onSetTheme, onSetLang, onClose } = props;
  const t = TEXT[lang];
  const panelRef = useRef<HTMLDivElement>(null);

  // 本机字体列表：打开设置页时向后端要一次（后端进程内已缓存，前端再按语言缓存），
  // 拿不到（浏览器复现环境 / 命令失败）就保持 null，两个字体项自动回落内置候选表。
  const [systemFonts, setSystemFonts] = useState<SystemFontInfo[] | null>(null);
  const [fontsLoading, setFontsLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setFontsLoading(true);
    void loadSystemFonts(lang).then((list) => {
      if (!cancelled) {
        setSystemFonts(list);
        setFontsLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [lang]);

  // Esc 关闭（与「关于」/ 视图模式模态框一致）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    // 打开即聚焦面板：内容区可键盘滚动，Esc 也一定落在本模态框的作用域里。
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const reset = useCallback(() => {
    onChange({ ...DEFAULT_SETTINGS });
  }, [onChange]);

  const stack = resolveFontStack(settings);

  return (
    <div className="body-modal-overlay" onClick={onClose}>
      <div
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t.title}
        tabIndex={-1}
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-head">
          <span className="settings-title">{t.title}</span>
          <button className="settings-x" onClick={onClose} title={`${t.close}（${t.closeHint}）`}>
            ✕
          </button>
        </div>

        <div className="settings-scroll">
          {/* ---------- 外观 ---------- */}
          <div className="settings-section">{t.appearance}</div>
          <Row label={t.theme}>
            <div className="settings-seg">
              <button
                className={theme === "dark" ? "on" : ""}
                onClick={() => onSetTheme("dark")}
                aria-pressed={theme === "dark"}
              >
                {t.themeDark}
              </button>
              <button
                className={theme === "light" ? "on" : ""}
                onClick={() => onSetTheme("light")}
                aria-pressed={theme === "light"}
              >
                {t.themeLight}
              </button>
            </div>
          </Row>
          <Row label={t.language}>
            <div className="settings-seg">
              <button
                className={lang === "zh" ? "on" : ""}
                onClick={() => onSetLang("zh")}
                aria-pressed={lang === "zh"}
              >
                中文
              </button>
              <button
                className={lang === "en" ? "on" : ""}
                onClick={() => onSetLang("en")}
                aria-pressed={lang === "en"}
              >
                English
              </button>
            </div>
          </Row>

          {/* ---------- 字体 ---------- */}
          <div className="settings-section">{t.fonts}</div>
          <p className="settings-hint">{t.fontsHint}</p>
          <FontField
            role="latin"
            label={t.latinFont}
            hint={t.latinHint}
            value={settings.latinFont}
            lang={lang}
            t={t}
            systemFonts={systemFonts}
            loading={fontsLoading}
            onChange={(v) => onChange({ latinFont: v })}
          />
          <FontField
            role="cjk"
            label={t.cjkFont}
            hint={t.cjkHint}
            value={settings.cjkFont}
            lang={lang}
            t={t}
            systemFonts={systemFonts}
            loading={fontsLoading}
            onChange={(v) => onChange({ cjkFont: v })}
          />

          {/* 实际生效的字体栈：两个下拉的选择结果，写成 CSS 就是这一行（技术细节） */}
          <div className="settings-stack" title={t.stackLabel}>
            <span className="settings-stack-key">{t.stackLabel}</span>
            <span className="settings-stack-value">{stack}</span>
          </div>

          <Row label={t.fontSize}>
            <input
              className="settings-range"
              type="range"
              min={FONT_SIZE_MIN}
              max={FONT_SIZE_MAX}
              step={1}
              value={settings.fontSize}
              aria-label={t.fontSize}
              onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
            />
            <span className="settings-value">
              {settings.fontSize}
              {t.fontSizeUnit}
            </span>
            <button
              className="settings-mini"
              onClick={() => onChange({ fontSize: DEFAULT_SETTINGS.fontSize })}
              disabled={settings.fontSize === DEFAULT_SETTINGS.fontSize}
            >
              {t.fontSizeReset}
            </button>
          </Row>

          {/* ---------- 预览 ---------- */}
          <div className="settings-section">{t.preview}</div>
          <div className="settings-preview">
            <div className="settings-preview-cap">{t.previewLog}</div>
            <div className="settings-preview-log">
              <span className="settings-preview-lineno">1</span>
              <span className="settings-preview-text">
                2025-01-14 09:31:02.418 [INFO] slots.json 1234 行
              </span>
            </div>
            <div className="settings-preview-log">
              <span className="settings-preview-lineno">2</span>
              <span className="settings-preview-text">
                iiilll1OOO0 iiiWm — 宽度对齐检查（中英混排 AssetBundle）
              </span>
            </div>

            <div className="settings-preview-cap">{t.previewMd}</div>
            <div className="settings-preview-md">
              <div className="settings-preview-h">## 版本说明</div>
              <div className="settings-preview-p">
                正文与 <code className="settings-preview-code">inline code</code> 同一套字体。
              </div>
            </div>

            <div className="settings-preview-cap">{t.previewTable}</div>
            <table className="settings-preview-table">
              <thead>
                <tr>
                  <th>id</th>
                  <th>name</th>
                  <th>描述 / desc</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>1</td>
                  <td>sword</td>
                  <td>长剑 · 双手</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="settings-foot">
          <button className="body-modal-btn settings-reset" onClick={reset}>
            {t.reset}
          </button>
          <button className="body-modal-btn settings-close" onClick={onClose}>
            {t.close}
          </button>
        </div>
      </div>
    </div>
  );
}

export default SettingsModal;
