/**
 * 设置模块的公共入口。
 *
 * App 只 import 本模块，不关心内部怎么拆（与 `src/views/index.ts` 同一约定）：
 *   - `settings.ts`     设置模型：读写 localStorage、迁移、写入 CSS 变量
 *   - `font-catalog.ts` 字体目录与「非中文 + 中文」字体栈拼装规则（纯逻辑，可单测）
 *   - `font-probe.ts`   canvas 探测系统里装了哪些字体
 *   - `SettingsModal.tsx` 设置模态框
 */

export {
  DEFAULT_SETTINGS,
  FONT_SIZE_DEFAULT,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LEGACY_FONT_SIZE_KEY,
  SETTINGS_KEY,
  applyFontSettings,
  clampFontSize,
  parseSettings,
  readSettings,
  resolveFontStack,
  writeSettings,
} from "./settings.ts";
export type { AppSettings } from "./settings.ts";

export {
  CJK_FONT_OPTIONS,
  DEFAULT_CJK_FAMILIES,
  DEFAULT_LATIN_FAMILIES,
  LATIN_FONT_OPTIONS,
  buildFamilyList,
  buildFontStack,
  defaultFamilies,
  fontOptions,
  isCatalogFamily,
  isGenericFamily,
  normalizeFamily,
  parseFamilyList,
  quoteFamily,
} from "./font-catalog.ts";
export type { FontOption, FontRole } from "./font-catalog.ts";

export {
  familyProvidesCjk,
  isFamilyInstalled,
  isMonospaceFamily,
  probeFontOptions,
  resetFontProbeCache,
} from "./font-probe.ts";
export type { ProbedFont } from "./font-probe.ts";

export {
  buildFontGroups,
  catalogChoices,
  choicesFromSystem,
  filterChoices,
  findChoice,
  matchesQuery,
  normalizeQuery,
  optionLabel,
  sameFamily,
} from "./font-options.ts";
export type { FontChoice, FontGroup, FontGroupKey, SystemFontLike } from "./font-options.ts";

export { loadSystemFonts, resetSystemFontCache } from "./system-fonts.ts";
export type { SystemFontInfo } from "./system-fonts.ts";

export { SettingsModal } from "./SettingsModal";
