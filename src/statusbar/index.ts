/**
 * 状态栏模块的公共入口。
 *
 * App 只 import 本模块，不关心内部怎么拆（与 `src/views/index.ts`、
 * `src/settings/index.ts` 同一约定）：
 *   - `encoding.ts`     纯逻辑：IPC 载荷类型、分组、显示名、预览裁剪（可单测）
 *   - `encoding-ipc.ts` 后端命令封装（含「没有后端」的降级路径）
 *   - `StatusBar.tsx`   底部状态栏
 *   - `EncodingModal.tsx` 编码选择弹窗（列表 + 实时预览）
 */

export {
  AUTO_ID,
  GROUP_ORDER,
  encodingFullLabel,
  encodingLabel,
  groupOptions,
  looksGarbled,
  optionLabel,
  previewLines,
  sourceKey,
  stripBom,
} from "./encoding.ts";
export type {
  EncodingGroup,
  EncodingInfo,
  EncodingOption,
  EncodingSource,
} from "./encoding.ts";

export {
  PREVIEW_MAX_BYTES,
  detectEncoding,
  fetchTabEncoding,
  loadEncodingOptions,
  loadEncodingPreview,
} from "./encoding-ipc.ts";
export type { EncodingPreview } from "./encoding-ipc.ts";

export { StatusBar, formatCount } from "./StatusBar";
export { EncodingModal } from "./EncodingModal";
