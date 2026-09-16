/**
 * 正文多页面框架的公共入口。
 *
 * 页面组件（FileMissingView / OpenErrorView）与框架（注册表 / 宿主 / 单行状态页外壳）
 * 都从这里导出，App 只 import 本模块，不关心文件怎么拆的。
 */

export { BodyViewRegistry, classifyOpenError } from "./body-view";
export type {
  BodyViewDefinition,
  BodyViewProps,
  OpenErrorInfo,
  OpenErrorKind,
  ViewLang,
} from "./body-view";

export { BodyViewHost } from "./BodyViewHost";
export { useBodyViewEffects } from "./use-body-view";
export { ViewToggleButton } from "./ViewToggleButton";

export { APP_BODY_VIEWS, resolveAppBodyViewId } from "./app-body-views";
export type {
  AppBodyViewId,
  AppBodyViewSpec,
  BodyViewState,
  ViewMode,
} from "./app-body-views";

export { NoticeLine } from "./NoticeLine";
export type { NoticeLineProps } from "./NoticeLine";
export { FileMissingView } from "./FileMissingView";
export { OpenErrorView } from "./OpenErrorView";
export type { OpenErrorViewProps } from "./OpenErrorView";

// 注意：`MarkdownView` **刻意不从本模块导出**。
// App.tsx 静态 import 了本模块，若这里再导出 MarkdownView，就会把
// marked + KaTeX + highlight.js（约 600 KB JS 与全部 KaTeX 字体）拖进主 chunk，
// 让每次启动都要解析它们。它由 App 用 `React.lazy(() => import("./views/MarkdownView"))`
// 按需加载（本文件头部注释里的「App 只 import 本模块」规则对它是例外）。
