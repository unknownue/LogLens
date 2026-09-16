/**
 * 「切换视图模式」图标按钮（正文区各内容视图共用）。
 *
 * 图标表示**将要切到的视图**：当前在非文本视图（表格 / Markdown）时显示「多行文字」，
 * 提示点一下能回文本；在文本视图时显示「网格」，提示还有别的视图可切。
 * 点击一律打开 App 的视图模式选择框，具体切到哪个视图由那个模态框决定。
 *
 * 抽成共用组件的原因：内容视图各有各的工具栏，但「离开本视图」的入口在图里必须一致
 * （位置、图标、aria 语义），否则用户切进表格/Markdown 后会找不到回来的路。
 *
 * 使用约束：内容视图的**每一个**渲染分支（解析中 / 失败 / 正常）都必须带上它 ——
 * 解析失败时若没有这个出口，用户就被困在表格（或 Markdown）视图里了。
 */
export function ViewToggleButton({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button
      className="icon-btn toolbar-icon view-toggle on"
      onClick={onClick}
      aria-pressed={true}
      title={title}
    >
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
        <path d="M2.5 3.5h11M2.5 8h11M2.5 12.5h6" stroke="currentColor" strokeWidth="1.55" />
      </svg>
    </button>
  );
}
