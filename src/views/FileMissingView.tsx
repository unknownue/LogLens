import type { BodyViewProps, ViewLang } from "./body-view";
import { NoticeLine } from "./NoticeLine";
import { useBodyViewEffects } from "./use-body-view";

/** 单行描述文案（中英）。 */
const TEXT: Record<ViewLang, (path: string) => string> = {
  zh: (path) => `文件不存在：${path}`,
  en: (path) => `File not found: ${path}`,
};

/**
 * 「文件不存在」状态页：历史记录 / 上次会话指向的文件已被删除或移动时的正文页。
 *
 * 之前这种 tab 只有工具栏上的 ⚠ + 一片空白正文；这里补上一行说明（含完整路径），
 * 让人一眼看出「打开了哪个文件、为什么没有内容」。不做按钮：文件恢复后重新从
 * 历史记录打开即可（同一路径会重新检测并自动切回内容视图）。
 */
export function FileMissingView(props: BodyViewProps) {
  // 状态页不产出可复制内容、也没有行数：激活时清空右上角的两处显示。
  useBodyViewEffects(props);

  return (
    <NoticeLine
      tone="warn"
      text={TEXT[props.lang](props.path)}
      title={props.path}
    />
  );
}
