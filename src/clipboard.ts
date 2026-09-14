/**
 * 剪贴板写入（全局共用一份实现）。
 *
 * WebView2 下 `navigator.clipboard` 在部分场景（非安全上下文 / 焦点不在文档内）
 * 会拒绝，故保留旧 `execCommand` 兜底；此前 App / CfgTableTab / 状态页面各有一份
 * 拷贝，统一到这里。
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
}
