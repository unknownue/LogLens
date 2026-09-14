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

export { APP_BODY_VIEWS, resolveAppBodyViewId } from "./app-body-views";
export type { AppBodyViewId, AppBodyViewSpec, BodyViewState } from "./app-body-views";

export { NoticeLine } from "./NoticeLine";
export type { NoticeLineProps } from "./NoticeLine";
export { FileMissingView } from "./FileMissingView";
export { OpenErrorView } from "./OpenErrorView";
export type { OpenErrorViewProps } from "./OpenErrorView";
