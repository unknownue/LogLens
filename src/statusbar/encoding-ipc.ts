/**
 * encoding-ipc.ts — 编码相关后端命令的薄封装（含降级路径）。
 *
 * 为什么单独一层：三个命令都有「拿不到后端」的可能（浏览器复现环境、
 * E2E 里只跑前端），调用方不该到处写 try/catch；这里统一把失败转成
 * 明确的可判定值（`null` / 降级结果），组件层只关心能不能用。
 *
 * 命令清单（后端见 `src-tauri/src/lib.rs`）：
 * - `list_encodings`    → 可选编码目录
 * - `detect_encoding`   → 探测某个文件的编码（不改动会话）
 * - `read_text_file`    → 整读文件（这里只用来做编码预览）
 * - `set_encoding`      → 切换某个 tab 的编码（在 App 里直接调，见 App.tsx）
 */

import { invoke } from "@tauri-apps/api/core";

import { AUTO_ID, type EncodingInfo, type EncodingOption } from "./encoding.ts";

/** 预览读取的字节上限：够 14 行中文，又不至于把大文件读进来。 */
export const PREVIEW_MAX_BYTES = 8 * 1024;

/** 可选编码目录；拿不到后端时返回 `null`（弹窗只显示「自动」一项）。 */
export async function loadEncodingOptions(): Promise<EncodingOption[] | null> {
  try {
    const list = await invoke<EncodingOption[]>("list_encodings");
    if (!Array.isArray(list)) {
      return null;
    }
    return list.filter(
      (o) => o && typeof o.id === "string" && typeof o.name === "string"
    );
  } catch {
    return null;
  }
}

/**
 * 解析文件的编码（不改动任何会话）。
 *
 * `encoding` 与 `read_text_file` 同义：`auto` 走自动探测，否则按用户指定的编码解析。
 * 手动钉死编码的 tab 必须把那份选择传进来，否则状态栏显示的是探测结果、正文用的是
 * 用户的选择，两者对不上。
 *
 * 失败（没有后端 / 文件读不到）返回 `null` —— 状态栏此时显示「—」而不是报错。
 */
export async function detectEncoding(
  path: string,
  encoding: string = AUTO_ID
): Promise<EncodingInfo | null> {
  try {
    return await invoke<EncodingInfo>("detect_encoding", { path, encoding });
  } catch {
    return null;
  }
}

/** 读取指定 tab 当前生效的编码（切换视图后回填状态栏用）。 */
export async function fetchTabEncoding(tabId: string): Promise<EncodingInfo | null> {
  try {
    const info = await invoke<EncodingInfo | null>("get_encoding", { tabId });
    return info ?? null;
  } catch {
    return null;
  }
}

/** 一次编码预览的结果。 */
export interface EncodingPreview {
  /** 解码后的文本（后端已按所选编码剥 BOM、非法字节 lossy）。 */
  text: string;
  /** 是否被 `PREVIEW_MAX_BYTES` 截断（截断点可能切在多字节字符中间）。 */
  truncated: boolean;
}

/**
 * 用指定编码读文件头部，供编码弹窗预览。
 * 失败返回 `null`（弹窗显示「预览不可用」，不影响选择与切换）。
 */
export async function loadEncodingPreview(
  path: string,
  encoding: string
): Promise<EncodingPreview | null> {
  try {
    const payload = await invoke<{ text: string; truncated?: boolean }>("read_text_file", {
      path,
      maxBytes: PREVIEW_MAX_BYTES,
      encoding,
    });
    if (typeof payload?.text !== "string") {
      return null;
    }
    return { text: payload.text, truncated: payload.truncated === true };
  } catch {
    return null;
  }
}
