import { Component, type ErrorInfo, type ReactNode } from "react";

import { BodyViewRegistry, type BodyViewProps } from "./body-view";
import { NoticeLine } from "./NoticeLine";

/**
 * 正文区宿主：把「一个 tab 的状态」解析成唯一页面并渲染。
 *
 * 职责（所有页面共享，页面自己不用管）：
 * 1. 从注册表解析当前页面（优先级 + 兜底），并给容器打上 `data-view`（E2E 断言用）；
 * 2. 用 `key={页面 id}` 在页面切换时重挂载 —— 避免上一个页面的局部状态残留；
 * 3. 页面渲染异常时兜底成一行提示（而不是整窗白屏），并在控制台留下堆栈。
 */
export function BodyViewHost<Ctx>({
  registry,
  ctx,
  base,
}: {
  registry: BodyViewRegistry<Ctx>;
  ctx: Ctx;
  base: BodyViewProps;
}) {
  const view = registry.resolve(ctx);
  const title = view.title(base.lang);

  return (
    <BodyViewErrorBoundary key={view.id} viewId={view.id} lang={base.lang}>
      {/* body-view：页面舞台。各页面内部照旧用 flex:1 铺满（见 App.css）。 */}
      <section className="body-view" data-view={view.id} aria-label={title}>
        {view.render(base, ctx)}
      </section>
    </BodyViewErrorBoundary>
  );
}

/** 页面崩溃时的一行提示文案。 */
const BOUNDARY_TEXT = {
  zh: (msg: string) => `视图渲染失败：${msg}`,
  en: (msg: string) => `View failed to render: ${msg}`,
};

/**
 * 页面级错误边界。
 *
 * 一个页面写错不应让整个窗口白屏 —— 正文区退化成一行提示，用户还能切 tab、关 tab。
 * `key={view.id}`（宿主传入）保证切换到别的页面后边界状态自动清空，页面即可自愈。
 */
class BodyViewErrorBoundary extends Component<
  { viewId: string; lang: "zh" | "en"; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[body-view] 页面 ${this.props.viewId} 渲染失败`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }
    return (
      <NoticeLine
        tone="error"
        text={BOUNDARY_TEXT[this.props.lang](error.message || String(error))}
        title={error.stack ?? String(error)}
      />
    );
  }
}
