/**
 * system-fonts.ts — 向后端要「本机所有可用字体」。
 *
 * 后端命令 `list_system_fonts` 走 DirectWrite 的系统字体集（详见
 * `src-tauri/src/fonts.rs`），返回 `{ family, display }[]`：`family` 是写进 CSS 的名字，
 * `display` 是界面语言对应的本地化名。
 *
 * 降级路径：拿不到后端（浏览器复现环境、命令失败）时返回 `null`，
 * 调用方回落到内置候选表 —— 设置页在任何环境都能用，只是列表短一些。
 */

import { invoke } from "@tauri-apps/api/core";

import type { ViewLang } from "../views/body-view.ts";

/** 后端返回的一个系统字体。 */
export interface SystemFontInfo {
  /** CSS family 名。 */
  family: string;
  /** 界面展示名（本地化）。 */
  display: string;
  /** 其它本地化名（供跨语言搜索）。 */
  aliases: string[];
  /** 自带中文字形（DirectWrite `HasCharacter`）。 */
  cjk: boolean;
  /** 等宽（DirectWrite `IDWriteFont1::IsMonospacedFont`）。 */
  mono: boolean;
}

/** 按语言缓存（同一语言只问一次后端；语言切换后展示名要重新取）。 */
const cache = new Map<ViewLang, Promise<SystemFontInfo[] | null>>();

/** 清空缓存（测试 / 需要重新枚举时用）。 */
export function resetSystemFontCache(): void {
  cache.clear();
}

/** 真正去问后端；失败一律转成 `null`（设置页要能无后端运行）。 */
async function fetchSystemFonts(lang: ViewLang): Promise<SystemFontInfo[] | null> {
  try {
    const list = await invoke<SystemFontInfo[]>("list_system_fonts", { lang });
    if (!Array.isArray(list) || list.length === 0) {
      return null;
    }
    return list.filter(
      (f) => f && typeof f.family === "string" && f.family.trim() !== ""
    );
  } catch {
    return null;
  }
}

/** 本机字体列表；拿不到返回 `null`（调用方回落内置候选表）。 */
export function loadSystemFonts(lang: ViewLang): Promise<SystemFontInfo[] | null> {
  const hit = cache.get(lang);
  if (hit) {
    return hit;
  }
  const pending = fetchSystemFonts(lang);
  cache.set(lang, pending);
  return pending;
}
