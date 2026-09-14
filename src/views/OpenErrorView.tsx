import type { BodyViewProps, OpenErrorKind, ViewLang } from "./body-view";
import { NoticeLine } from "./NoticeLine";
import { useBodyViewEffects } from "./use-body-view";

/** 单行描述文案（中英）：权限问题与其它失败给不同的说法。 */
const TEXT: Record<ViewLang, { denied: (path: string) => string; other: (path: string) => string }> =
  {
    zh: {
      denied: (path) => `没有权限读取：${path}`,
      other: (path) => `无法打开：${path}`,
    },
    en: {
      denied: (path) => `Permission denied: ${path}`,
      other: (path) => `Cannot open: ${path}`,
    },
  };

/** 通用错误页的专属属性（公共属性见 `BodyViewProps`）。 */
export interface OpenErrorViewProps extends BodyViewProps {
  /** 错误分类：`denied` 与其它失败给不同的说明（missing 有专门页面，不会走到这里）。 */
  kind: OpenErrorKind;
  /** 后端原始报错（放进悬停提示，不占版面）。 */
  error?: string;
}

/**
 * 通用「打开失败」状态页：非「文件不存在」的失败（权限、IO、格式…）走这里。
 *
 * 它是框架的兜底状态页 —— 没有它，任何未预料的失败都会退化成一片什么都没有的正文，
 * 连「哪个文件失败了」都看不出来。
 */
export function OpenErrorView(props: OpenErrorViewProps) {
  const { lang, path, kind, error } = props;
  // 状态页不产出可复制内容、也没有行数：激活时清空右上角的两处显示。
  useBodyViewEffects(props);

  const t = TEXT[lang];
  return (
    <NoticeLine
      tone="error"
      text={kind === "denied" ? t.denied(path) : t.other(path)}
      title={error ?? path}
    />
  );
}
