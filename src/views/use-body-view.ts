import { useEffect } from "react";

import type { BodyViewProps } from "./body-view";

/**
 * 页面公共生命周期：激活时注册「复制当前视图」与上报行数，失活 / 卸载时注销。
 *
 * 宿主注入的 `registerCopy` / `reportTotal` 是「当前激活 tab 的独占注册位」，
 * 注销时还必须判归属（见 App 里的实现）。每个页面各写一遍 effect 很容易漏掉
 * 注销分支，留下指向已卸载 tab 的注册；统一走这个 hook 就不必重复推理。
 *
 * 只要求这四项（不要求完整 {@link BodyViewProps}）：页面可以按自己的命名约定
 * 声明 props（例如表格视图把界面语言叫 `uiLang`），只要结构上带上这四项即可。
 *
 * 内容视图传入自己产出的复制函数与行数；状态页面（错误页等）两者都不适用，
 * 不传即可 —— 激活时会**清空**右上角的总行数并禁用「复制当前视图」。
 */
export function useBodyViewEffects(
  base: Pick<BodyViewProps, "active" | "tabId" | "registerCopy" | "reportTotal">,
  handlers: { copy?: (() => Promise<string>) | null; total?: number | null } = {}
): void {
  const { active, tabId, registerCopy, reportTotal } = base;
  const copy = handlers.copy ?? null;
  const total = handlers.total ?? null;

  useEffect(() => {
    if (!active) {
      return;
    }
    registerCopy(tabId, copy);
    reportTotal(tabId, total);
    return () => {
      registerCopy(tabId, null);
      reportTotal(tabId, null);
    };
  }, [active, tabId, copy, total, registerCopy, reportTotal]);
}
