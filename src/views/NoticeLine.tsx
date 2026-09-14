/**
 * 状态页面的外壳：正文区正中一行说明文字。
 *
 * 刻意做到最简：没有图标、没有按钮、没有折叠详情 —— 状态页面只负责把「出了什么事」
 * 说清楚（例如「文件不存在：D:\logs\a.log」），正文区其余空间留白。原因是这类页面
 * 只有一句话的信息量，堆按钮反而把「看一眼就知道怎么回事」变成了「先读一排操作」；
 * 完整路径 / 后端原始报错放进 title 悬停提示，不占版面。
 *
 * 新页面直接复用本组件即可（见 docs/body-views.md）。
 */

export interface NoticeLineProps {
  /** 视觉基调：`warn` = 黄（可恢复，如文件不存在）；`error` = 红（失败）。 */
  tone?: "warn" | "error";
  /** 单行描述（通常是「<说明>：<路径>」）。 */
  text: string;
  /** 悬停提示（完整路径 / 后端原始报错）。 */
  title?: string;
}

/** 正文状态页：一行说明文字。 */
export function NoticeLine({ tone = "warn", text, title }: NoticeLineProps) {
  return (
    <div className={`notice-page ${tone}`}>
      <div className="notice-line" title={title}>
        {text}
      </div>
    </div>
  );
}
